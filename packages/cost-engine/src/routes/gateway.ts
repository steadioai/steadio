import { Hono, type Context } from "hono";
import { createHash, randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { apiKeys, costEvents } from "@steadio/shared/schema";
import { evaluate, applyRedactions } from "../guardrails/engine.js";
import { evaluateWithSignals } from "../guardrails/signal-lane.js";
import {
  resolveGatewaySignalDetectors,
  gatewaySignalLaneOptions,
} from "../guardrails/detector-registry.js";
import { withGuardrailConfig, DEFAULT_RULES } from "../guardrails/rules.js";
import { buildToolLedger } from "../guardrails/ledger.js";
import { extractGuardrailContext } from "../guardrails/gateway-adapter.js";
import { writeGuardrailEvent } from "../services/guardrail-event-service.js";
import { writeToolLedger } from "../services/tool-ledger-service.js";
import {
  createApprovalRequest,
  notifyHold,
  getApprovalByResumeToken,
  consumeApprovalResumeToken,
  type ApprovalRow,
  type HeldActionPayload,
} from "../services/approval-service.js";
import { resolveOrCreateAgent, resolveAgentGuardrailConfig } from "../gateway/agent-resolver.js";
import { resolveWorkspaceRules } from "../gateway/rule-resolver.js";
import { calculateCostCents } from "../pricing.js";
import { getActiveFreezes } from "../services/freeze-service.js";
import type { SignalDetector, SignalLaneOptions } from "../guardrails/signal-lane.js";
import type {
  AgentFreeze,
  GuardrailContext,
  GuardrailDecision,
  GuardrailRule,
} from "../guardrails/types.js";

const DASHBOARD_URL =
  process.env["DASHBOARD_URL"]?.replace(/\/$/, "") ?? "http://localhost:5173";

// LLM gateway (/v1) endpoints.
//
// These routes handle /v1 LLM proxy traffic, enforcing the X-SteadIO-Key auth
// contract and runtime guardrails before forwarding to upstream providers.
//
// After auth + the guardrail gate, an allowed request is forwarded to the real
// upstream provider (OpenAI / Anthropic) using the caller's OWN provider key
// (bring-your-own — SteadIO never pays for the LLM call), and the resulting
// spend is captured to power the dashboard.

export const gatewayRoutes = new Hono();

function normalizeHeldActionPayload(payload: unknown): HeldActionPayload {
  const src =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : {};
  const normalized: HeldActionPayload = {};
  if (typeof src["direction"] === "string") normalized.direction = src["direction"];
  if (typeof src["content"] === "string") normalized.content = src["content"];
  if (src["toolCalls"] !== undefined) normalized.toolCalls = src["toolCalls"];
  return normalized;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((key) => obj[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(obj[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function heldActionPayloadsMatch(
  approved: unknown,
  current: HeldActionPayload,
): boolean {
  return (
    stableJson(normalizeHeldActionPayload(approved)) ===
    stableJson(normalizeHeldActionPayload(current))
  );
}

function approvalMatchesRequest(
  approval: ApprovalRow,
  agentId: string | undefined,
  decision: NonNullable<ReturnType<typeof evaluate>>,
  actionPayload: HeldActionPayload,
): boolean {
  const determinant = decision.determinedBy;
  return (
    (approval.agentId ?? undefined) === agentId &&
    approval.ruleId === (determinant?.ruleId ?? "unknown") &&
    approval.ruleType === (determinant?.ruleType ?? "unknown") &&
    heldActionPayloadsMatch(approval.actionPayload, actionPayload) &&
    stableJson(approval.findings) === stableJson(decision.findings)
  );
}

function readKey(c: Context): string | undefined {
  return c.req.header("x-steadio-key") ?? c.req.header("x-api-key");
}

// Apply a "redact" decision's masked spans to every string leaf of the outbound
// request body. Returns a new object; the original is untouched.
// applyRedactions does literal (non-regex) replacement, so masking a value in a
// deeply-nested message content string is safe regardless of what it contains.
function redactBody(
  body: Record<string, unknown>,
  decision: ReturnType<typeof evaluate>,
): Record<string, unknown> {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return applyRedactions(v, decision);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = walk(val);
      return out;
    }
    return v;
  };
  return walk(body) as Record<string, unknown>;
}

// Upstream provider endpoints, keyed off the /v1 path the caller hit. Only the
// documented LLM surfaces forward; anything else falls back to the informative
// placeholder response so an unknown path never reads as a dead host.
type ProviderTarget = {
  provider: "openai" | "anthropic";
  url: string;
  // Build the headers we send upstream from the caller's request. Returns null
  // when the caller didn't supply the provider credential this route needs.
  buildHeaders: (c: Context) => Promise<Record<string, string> | null>;
};

// A deliberately narrow deterministic transport for the frozen synthetic
// credential proof. It is authenticated by the normal X-SteadIO-Key gate and
// only returns these public, non-secret fixture values; callers cannot supply an
// arbitrary response. This keeps provider/model behavior out of the proof while
// exercising the exact production response extraction, scan, and persistence
// path below.
export const CREDENTIAL_CANARY_MODEL = "steadio/credential-canary-v2";
export const CREDENTIAL_CANARY_RESPONSES: Readonly<Record<string, string>> = {
  "positive-openai": "Synthetic canary: sk-SYNTHETICOPENAI1234567890",
  "positive-aws": "Synthetic canary: AKIASYNTHETIC1234567",
  "positive-github": "Synthetic canary: ghp_SYNTHETICGITHUB1234567890",
  "benign-short-provider": "Documentation placeholder: sk-short-example",
  "benign-lowercase-aws": "Documentation placeholder: akiaSYNTHETIC1234567",
  "benign-short-github": "Documentation placeholder: ghp_short-example",
};
export const CREDENTIAL_CANARY_V3_MODEL = "steadio/credential-canary-v3";
export const CREDENTIAL_CANARY_V3_RESPONSES: Readonly<Record<string, string>> = {
  "positive-openai-min-length": "Synthetic canary: sk-ABCDEFGHIJKLMNOP",
  "control-openai-below-min-length": "Documentation placeholder: sk-ABCDEFGHIJKLMNO",
  "positive-aws-lowercase": "Synthetic canary: akiaABCDEFGHIJKLMNOP",
  "control-aws-below-exact-length": "Documentation placeholder: akiaABCDEFGHIJKLMNO",
  "positive-github-min-length": "Synthetic canary: ghp_ABCDEFGHIJKLMNOPQRST",
  "control-github-below-min-length": "Documentation placeholder: ghp_ABCDEFGHIJKLMNOPQRS",
};

const CREDENTIAL_CANARY_TRANSPORTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [CREDENTIAL_CANARY_MODEL]: CREDENTIAL_CANARY_RESPONSES,
  [CREDENTIAL_CANARY_V3_MODEL]: CREDENTIAL_CANARY_V3_RESPONSES,
};

function deterministicCanaryResponse(
  parsedBody: Record<string, unknown>,
): Response | null {
  const model = parsedBody["model"];
  if (typeof model !== "string" || !(model in CREDENTIAL_CANARY_TRANSPORTS)) return null;
  const steadio = parsedBody["steadio"] as Record<string, unknown> | undefined;
  const caseId = steadio?.["credentialCanaryCaseId"];
  const responses = CREDENTIAL_CANARY_TRANSPORTS[model]!;
  const content = typeof caseId === "string" ? responses[caseId] : undefined;
  if (!content) {
    return Response.json(
      {
        error: "invalid_credential_canary_case",
        message: `Use a registered ${model.replace("steadio/", "")} case id.`,
      },
      { status: 400 },
    );
  }
  return Response.json({
    id: `${model.replace("steadio/", "")}-${caseId}`,
    object: "chat.completion",
    model,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  });
}

function resolveProviderTarget(path: string): ProviderTarget | null {
  if (path.endsWith("/chat/completions")) {
    return {
      provider: "openai",
      url: "https://api.openai.com/v1/chat/completions",
      buildHeaders: async (c) => {
        const auth = c.req.header("authorization");
        if (!auth) return null;
        return { "content-type": "application/json", authorization: auth };
      },
    };
  }
  if (path.endsWith("/embeddings")) {
    return {
      provider: "openai",
      url: "https://api.openai.com/v1/embeddings",
      buildHeaders: async (c) => {
        const auth = c.req.header("authorization");
        if (!auth) return null;
        return { "content-type": "application/json", authorization: auth };
      },
    };
  }
  if (path.endsWith("/messages")) {
    return {
      provider: "anthropic",
      url: "https://api.anthropic.com/v1/messages",
      buildHeaders: async (c) => {
        // The Anthropic key rides on x-api-key; the SteadIO key comes in on the
        // dedicated x-steadio-key header, so the two never collide on this path.
        const apiKey = c.req.header("x-api-key");
        if (!apiKey || apiKey === readKey(c)) return null;
        return {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
        };
      },
    };
  }
  return null;
}

// Forward an allowed request to the upstream provider and stream/return its
// response verbatim. Records spend fire-and-forget so the dashboard reflects the
// call. Returns null when this path/method is not a forwardable LLM endpoint, so
// the caller can fall back to the placeholder response.
async function forwardToProvider(
  c: Context,
  teamId: string,
  parsedBody: Record<string, unknown> | undefined,
): Promise<Response | null> {
  if (c.req.method !== "POST" || !parsedBody) return null;

  const canaryResponse = deterministicCanaryResponse(parsedBody);
  if (canaryResponse) {
    if (canaryResponse.ok) {
      // Scan the serialized response, exactly like a buffered provider response.
      // clone() keeps the bytes returned to the caller untouched.
      void canaryResponse.clone().text().then((text) =>
        recordResponseGuardrail(c, teamId, text),
      );
    }
    return canaryResponse;
  }
  const target = resolveProviderTarget(c.req.path);
  if (!target) return null;

  const headers = await target.buildHeaders(c);
  if (!headers) {
    // Authenticated to SteadIO but no upstream provider key — tell the caller how
    // to fix it instead of leaking an opaque 401 from the provider.
    return c.json(
      {
        error: "missing_provider_key",
        message:
          target.provider === "anthropic"
            ? "Pass your Anthropic key on the x-api-key header (and your SteadIO key on X-SteadIO-Key). SteadIO proxies with your own provider key."
            : "Pass your provider key on the Authorization header (Bearer …) alongside X-SteadIO-Key. SteadIO proxies with your own provider key.",
      },
      400,
    );
  }

  const startMs = Date.now();
  const model = (parsedBody["model"] as string | undefined) ?? "unknown";
  const isStream = parsedBody["stream"] === true;

  let providerRes: Response;
  try {
    providerRes = await fetch(target.url, {
      method: "POST",
      headers,
      body: JSON.stringify(parsedBody),
    });
  } catch (err) {
    console.error("[gateway] upstream fetch error:", err);
    return c.json(
      {
        error: "upstream_error",
        message: `Failed to reach ${target.provider}.`,
      },
      502,
    );
  }

  // Stream responses pass straight through — token accounting for streamed
  // calls is a follow-up; the immediate contract is that the stream works.
  if (isStream) {
    return new Response(providerRes.body, {
      status: providerRes.status,
      headers: { "content-type": providerRes.headers.get("content-type") ?? "text/event-stream" },
    });
  }

  const text = await providerRes.text();
  if (providerRes.ok) {
    void recordForwardSpend(c, teamId, target.provider, model, text, Date.now() - startMs);
    // Post-forward response-side credential-leak eval. Fire-and-forget alongside
    // spend capture. The forwarded bytes above are already committed to the caller;
    // this pass only READS the already-buffered `text` and records a
    // direction:"response" verdict. Streaming responses are NOT scanned.
    void recordResponseGuardrail(c, teamId, text);
  }
  return new Response(text, {
    status: providerRes.status,
    headers: { "content-type": providerRes.headers.get("content-type") ?? "application/json" },
  });
}

// Capture spend for a completed non-streaming forward. Fire-and-forget: a failure
// here must never affect the response the caller already received.
async function recordForwardSpend(
  c: Context,
  teamId: string,
  provider: "openai" | "anthropic",
  model: string,
  responseText: string,
  durationMs: number,
): Promise<void> {
  try {
    const parsed = JSON.parse(responseText) as Record<string, unknown>;
    const usage = parsed["usage"] as
      | { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number }
      | undefined;
    const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? 0;
    const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? 0;
    const externalAgentId = c.req.header("x-steadio-agent-id") ?? `default:${teamId}`;
    const workflowId = c.req.header("x-steadio-workflow") ?? null;
    const agentId = await resolveOrCreateAgent(teamId, externalAgentId, provider, model);
    await getDb().insert(costEvents).values({
      agentId,
      teamId,
      requestId: randomUUID(),
      workflowId,
      provider,
      model,
      inputTokens,
      outputTokens,
      costCents: calculateCostCents(model, inputTokens, outputTokens),
      durationMs,
      metadata: {},
    });
  } catch (err) {
    console.error("[gateway] cost capture error:", err);
  }
}

// Response-side credential-leak (secret_egress) scan.
//
// Contract (matches our fail-open enforcement posture):
//   - Fire-and-forget: called with `void`, never awaited on the response path.
//   - Fail-open: any error is logged and swallowed; the answer the caller already
//     received is never touched.
//   - Records a direction:"response" guardrail_event and stops.
//   - Non-streaming only.
async function recordResponseGuardrail(
  c: Context,
  teamId: string,
  responseText: string,
): Promise<void> {
  try {
    const answerText = extractAnswerText(responseText);
    if (!answerText) return; // no answer to scan (e.g. embeddings) — rule inert

    const decision = evaluateResponseCredentialLeak(answerText);
    if (!decision || decision.action === "allow") return; // benign — zero events

    const agentId = c.req.header("x-steadio-agent-id");
    void writeGuardrailEvent({
      teamId,
      agentId,
      decision,
      direction: "response",
      contentPreview: answerText.slice(0, 512),
      httpStatus: 200,
      enforced: false,
    }).catch((err) =>
      console.error("[gateway] response guardrail persist error:", err),
    );
  } catch (err) {
    // Fail-open: a response-scan failure must never surface to the caller.
    console.error("[gateway] response guardrail error:", err);
  }
}

// Pure decision core for the response-side credential-leak scan, exported for
// tests. Runs ONLY the secret_egress rules from DEFAULT_RULES over the answer with
// direction:"response". secret_egress is a synchronous pattern match, so no signal
// lane / network call is needed. Restricting the rule set keeps every other verdict
// off this pass so a response can only ever be flagged for a leaked credential here.
export function evaluateResponseCredentialLeak(
  answerText: string,
): GuardrailDecision | null {
  if (!answerText) return null;
  const rules = DEFAULT_RULES.filter((r) => r.type === "secret_egress");
  if (rules.length === 0) return null;
  return evaluate({ direction: "response", content: answerText }, rules);
}

// Pull the assistant's answer text out of a provider response body so the
// response-side groundedness judge scores the ANSWER, not the JSON envelope.
// Handles both wire shapes — OpenAI chat/completions (choices[].message.content)
// and Anthropic /messages (content[].text). Returns undefined for shapes with no
// answer to judge (e.g. embeddings), which correctly leaves the rule inert.
function extractAnswerText(rawJson: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object") return undefined;
  const obj = parsed as Record<string, unknown>;

  const choices = obj["choices"];
  if (Array.isArray(choices)) {
    const parts = choices.map((ch) => {
      const content = (ch as { message?: { content?: unknown } })?.message?.content;
      if (typeof content === "string") return content;
      if (Array.isArray(content)) {
        return content
          .map((p) =>
            p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string"
              ? (p as { text: string }).text
              : "",
          )
          .join("\n");
      }
      return "";
    });
    const joined = parts.filter(Boolean).join("\n").trim();
    return joined.length ? joined : undefined;
  }

  const content = obj["content"];
  if (Array.isArray(content)) {
    const joined = content
      .map((b) =>
        b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
          ? (b as { text: string }).text
          : "",
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    return joined.length ? joined : undefined;
  }

  return undefined;
}

// Inputs the response-side review needs, all resolved once on the request path.
interface ResponseReviewInputs {
  teamId: string;
  agentId?: string | undefined;
  requestCtx?: ReturnType<typeof extractGuardrailContext> | undefined;
  rules: GuardrailRule[];
  detectors: SignalDetector[];
  laneOptions: SignalLaneOptions;
  freezes: AgentFreeze[];
  enforce: boolean;
}

// Response-side groundedness review. Runs the signal lane a second time over the
// provider's ANSWER so the faithfulness judge scores live RAG responses.
//
// Inert for non-RAG traffic by construction: it only runs when the caller supplied
// sourceContext AND a groundedness detector is registered.
//
// Returns null to pass the provider body through unchanged; otherwise a replacement
// Response: an annotated passthrough (alert) or a withheld answer (block/hold as
// terminal 403, throttle as 429).
async function reviewResponseGroundedness(
  c: Context,
  forwarded: Response,
  ev: ResponseReviewInputs,
): Promise<Response | null> {
  // No source context supplied — rule inert, no finding, no work.
  if (!ev.requestCtx || ev.requestCtx.sourceContext == null) return null;

  // Scope strictly to groundedness on this pass.
  const detectors = ev.detectors.filter((d) => d.type === "groundedness");
  if (detectors.length === 0) return null;

  if (!forwarded.ok) return null;
  const contentType = forwarded.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;

  let rawBody: string;
  try {
    rawBody = await forwarded.clone().text();
  } catch {
    return null;
  }
  const answerText = extractAnswerText(rawBody);
  if (!answerText) return null;

  const rules = ev.rules.filter((r) => r.type === "groundedness");
  if (rules.length === 0) return null;

  const responseCtx: GuardrailContext = {
    ...ev.requestCtx,
    direction: "response",
    content: answerText,
    toolCalls: undefined,
  };

  let decision: GuardrailDecision;
  try {
    decision = await evaluateWithSignals(
      responseCtx,
      rules,
      detectors,
      ev.laneOptions,
      ev.freezes,
    );
  } catch (err) {
    // Fail-open: a response guardrail failure must never break the answer path.
    console.error("[gateway] response guardrail error:", err);
    return null;
  }
  if (!decision || decision.action === "allow") return null;

  const terminal =
    decision.action === "block" ||
    decision.action === "hold" ||
    decision.action === "throttle";
  const enforced = ev.enforce && terminal;
  // Response-side withholding is TERMINAL. Unlike a request-side hold, there is no
  // coherent human-in-the-loop resume for an answer the provider already produced.
  // So a `hold`-mode groundedness verdict is served as a terminal block (403).
  // Throttle stays a 429.
  const withheldStatus = decision.action === "throttle" ? 429 : 403;
  const withheldAction = decision.action === "hold" ? "block" : decision.action;
  const contentPreview = answerText.slice(0, 512);

  // Persist for the dashboard / audit (direction "response"). Fire-and-forget.
  void writeGuardrailEvent({
    teamId: ev.teamId,
    agentId: ev.agentId,
    decision,
    direction: "response",
    contentPreview,
    httpStatus: enforced ? withheldStatus : 200,
    enforced,
  }).catch((err) =>
    console.error("[gateway] response guardrail persist error:", err),
  );

  if (enforced) {
    // Withhold the unfaithful answer — the caller never receives it.
    return c.json(
      {
        error: "guardrail_response_withheld",
        action: withheldAction,
        message:
          decision.determinedBy?.reason ??
          "The provider response was withheld by a SteadIO response guardrail (groundedness).",
        guardrail: decision,
      },
      withheldStatus,
    );
  }

  // Alert: return the answer intact but surface the verdict on a header
  // so the caller (and the dashboard) can see what fired without mutating the body.
  return new Response(rawBody, {
    status: forwarded.status,
    headers: {
      "content-type": forwarded.headers.get("content-type") ?? "application/json",
      "x-steadio-guardrail": decision.action,
    },
  });
}

// Resolve a raw key to its team + row id. Returns null when the key is unknown.
async function resolveKeyTeam(rawKey: string): Promise<{ teamId: string; keyId: string } | null> {
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const rows = await getDb()
    .select({ teamId: apiKeys.teamId, keyId: apiKeys.id })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);
  const row = rows[0];
  return row ? { teamId: row.teamId, keyId: row.keyId } : null;
}

async function guard(c: Context) {
  const key = readKey(c);
  if (!key) {
    return c.json(
      { error: "missing_api_key", message: "X-SteadIO-Key header required" },
      401,
    );
  }

  let resolved: { teamId: string; keyId: string } | null = null;
  try {
    resolved = await resolveKeyTeam(key);
  } catch {
    resolved = null;
  }

  if (!resolved) {
    return c.json(
      { error: "invalid_api_key", message: "Invalid or unrecognized SteadIO API key" },
      401,
    );
  }
  const teamId = resolved.teamId;

  // OSS = self-hosted, always enforce guardrails.
  const enforce = true;

  // Human-in-the-loop resume (ELEAA-664). An agent whose action was previously
  // held re-issues the SAME request with the resume token it received in the 202.
  // If an operator approved it, the hold is cleared and the action proceeds; if
  // denied it is dropped (403); if still pending the caller is told to wait (202).
  const approvalToken = c.req.header("x-steadio-approval");
  let resumedApproval:
    | { approval: ApprovalRow; consumed: false }
    | { id: string; consumed: true }
    | undefined;
  if (approvalToken) {
    try {
      const appr = await getApprovalByResumeToken(approvalToken);
      if (appr && appr.teamId === teamId) {
        if (appr.status === "approved") {
          resumedApproval = { approval: appr, consumed: false };
        } else if (appr.status === "denied") {
          return c.json(
            {
              error: "guardrail_denied",
              action: "block",
              message: "An operator denied this held action. It will not be executed.",
              approvalId: appr.id,
              resolutionNote: appr.resolutionNote,
            },
            403,
          );
        } else if (appr.status === "pending") {
          return c.json(
            {
              error: "guardrail_pending",
              action: "hold",
              message: "This action is still awaiting human approval.",
              approvalId: appr.id,
            },
            202,
          );
        } else if (appr.status === "expired") {
          return c.json(
            {
              error: "approval_already_used",
              action: "hold",
              message: "This approval token has already been used.",
              approvalId: appr.id,
            },
            409,
          );
        }
      }
    } catch (err) {
      // A lookup failure must not break the request path — fall through and
      // re-evaluate as a fresh action (it may hold again, which is safe).
      console.error("[gateway] approval resume lookup error:", err);
    }
  }

  // Runtime guardrails. Authenticated requests are evaluated inline, BEFORE any
  // provider call. A block/throttle verdict short-circuits here so an unsafe agent
  // action never reaches the model or the user; alert-only verdicts pass through
  // but are surfaced in the response so the caller/dashboard can see what fired.
  let guardrail: ReturnType<typeof evaluate> | undefined;
  let guardrailCtx: ReturnType<typeof extractGuardrailContext> | undefined;
  let guardrailCtxMeta: { direction: string; contentPreview: string } | undefined;
  // The parsed request body is kept so an allowed request can be forwarded to the
  // upstream provider without re-reading the (already-consumed) stream.
  let parsedBody: Record<string, unknown> | undefined;

  // The per-agent rule set and resolved signal detectors are hoisted so the
  // response-side groundedness review reuses the exact configuration the request
  // pass evaluated with.
  let rules: GuardrailRule[] = DEFAULT_RULES;
  let detectors: SignalDetector[] = [];

  // Kill-switch (ELEAA-747): the active operator freezes for this agent. Read once
  // and fed into the pure engine, which treats a matching freeze as the highest-
  // severity verdict — above every rule and always enforced (a human explicitly hit
  // stop).
  const agentRef = c.req.header("x-steadio-agent-id");
  const identity = c.req.header("x-steadio-identity");
  let freezes: AgentFreeze[] = [];
  const freezeAgentId = agentRef ?? `default:${teamId}`;
  try {
    freezes = await getActiveFreezes(teamId, freezeAgentId);
  } catch (err) {
    console.error("[gateway] freeze lookup error:", err);
  }

  if (c.req.method === "POST") {
    try {
      const body = await c.req.json();
      parsedBody = body as Record<string, unknown>;
      guardrailCtx = extractGuardrailContext(body, agentRef, teamId);
      if (identity) guardrailCtx.identity = identity;
      // Groundedness: callers who can't extend the JSON body can forward retrieved
      // RAG context via a header instead. The body field wins when both are present.
      if (guardrailCtx.sourceContext == null) {
        const headerSource = c.req.header("x-steadio-source-context");
        if (headerSource && headerSource.trim().length > 0) {
          guardrailCtx.sourceContext = headerSource;
        }
      }
      // Per-agent firewall: fold this agent's allowlist into the action gate so
      // an allowlisted agent runs in positive-security mode.
      const [agentConfig, workspaceRules] = await Promise.all([
        resolveAgentGuardrailConfig(teamId, agentRef),
        resolveWorkspaceRules(teamId),
      ]);
      rules = withGuardrailConfig(
        workspaceRules,
        agentConfig.allowedTools,
        agentConfig.guardrailMode,
      );
      // Async signal lane: run enabled I/O detectors BEFORE the pure engine, then
      // fold their findings into the same verdict.
      detectors = resolveGatewaySignalDetectors();
      guardrail = await evaluateWithSignals(
        guardrailCtx,
        rules,
        detectors,
        gatewaySignalLaneOptions(),
        freezes,
      );
      guardrailCtxMeta = {
        direction: guardrailCtx.direction ?? "request",
        contentPreview: (guardrailCtx.content ?? "").slice(0, 512),
      };
    } catch {
      // Unparseable body: nothing to inspect, fall through to the auth-only path.
      guardrail = undefined;
    }
  }

  // A whole-agent freeze must stop even a non-POST probe or an unparseable body:
  // evaluate with an empty rule set so only the freeze can fire.
  if (!guardrail && freezes.length) {
    guardrail = evaluate({ direction: "request" }, [], freezes);
    if (guardrail.action === "allow") guardrail = undefined;
  }

  // NSA-compliant tool ledger. Persist EVERY tool call in this request — allowed
  // ones too. Fire-and-forget and independent of entitlement.
  if (guardrail && guardrailCtx?.toolCalls?.length) {
    try {
      const entries = buildToolLedger(guardrailCtx, guardrail, {
        now: new Date().toISOString(),
      });
      if (entries.length > 0) {
        void writeToolLedger({ teamId, entries }).catch((err) =>
          console.error("[gateway] tool ledger persist error:", err),
        );
      }
    } catch (err) {
      console.error("[gateway] tool ledger build error:", err);
    }
  }

  // An approved resume clears a hold verdict so the action proceeds. It does NOT
  // clear a hard block (a denied-by-rule action stays denied even with approval).
  if (resumedApproval && guardrail && guardrail.action === "hold") {
    const currentActionPayload = {
      direction: guardrailCtxMeta?.direction,
      content: guardrailCtx?.content,
      toolCalls: guardrailCtx?.toolCalls,
    };
    if (resumedApproval.consumed) {
      return c.json({ error: "approval_already_used", action: "hold" }, 409);
    }
    if (
      !approvalMatchesRequest(
        resumedApproval.approval,
        agentRef,
        guardrail,
        currentActionPayload,
      )
    ) {
      return c.json(
        {
          error: "approval_payload_mismatch",
          action: "hold",
          message:
            "This approval token does not match the held action being resumed.",
          approvalId: resumedApproval.approval.id,
        },
        403,
      );
    }
    const consumed = await consumeApprovalResumeToken(
      resumedApproval.approval.id,
    );
    if (!consumed) {
      return c.json(
        {
          error: "approval_already_used",
          action: "hold",
          message: "This approval token has already been used.",
          approvalId: resumedApproval.approval.id,
        },
        409,
      );
    }
    resumedApproval = { id: resumedApproval.approval.id, consumed: true };
    const forwarded = await forwardToProvider(c, teamId, parsedBody);
    if (forwarded) {
      // A resumed RAG request still gets its answer judged for faithfulness.
      const reviewed = await reviewResponseGroundedness(c, forwarded, {
        teamId,
        agentId: c.req.header("x-steadio-agent-id"),
        requestCtx: guardrailCtx,
        rules,
        detectors,
        laneOptions: gatewaySignalLaneOptions(),
        freezes,
        enforce,
      });
      return reviewed ?? forwarded;
    }
    return c.json(
      {
        action: "allow",
        resumed: true,
        message: "Held action approved by an operator — resuming.",
      },
      200,
    );
  }

  // Persist any non-allow finding fire-and-forget. Failure must not block the
  // request — swallow errors.
  const persistGuardrailEvent = (httpStatus: number) => {
    if (!guardrail || guardrail.action === "allow") return;
    const decision = guardrail;
    const agentId = c.req.header("x-steadio-agent-id");
    void writeGuardrailEvent({
      teamId,
      agentId,
      decision,
      direction: guardrailCtxMeta?.direction,
      contentPreview: guardrailCtxMeta?.contentPreview,
      httpStatus,
      enforced: true,
    }).catch((err) =>
      console.error("[gateway] guardrail event persist error:", err),
    );
  };

  // Would-be HTTP status for a verdict, used to record severity. "redact" forwards
  // (the request completes with masked content), so it records as a 200.
  const wouldBeStatus = (action: string): number =>
    action === "block"
      ? 403
      : action === "throttle"
        ? 429
        : action === "hold"
          ? 202
          : action === "redact"
            ? 200
            : 503;

  // Kill-switch short-circuit (ELEAA-747). A freeze is the highest-severity
  // verdict: it wins over an approved resume and is ALWAYS enforced, even for a
  // monitor-only team, because an operator explicitly froze this agent/tool.
  if (guardrail && guardrail.determinedBy?.ruleType === "kill_switch") {
    persistGuardrailEvent(403);
    return c.json(
      {
        error: "guardrail_blocked",
        action: "block",
        killSwitch: true,
        message:
          guardrail.determinedBy.reason ??
          "This agent is frozen by an operator. Unfreeze it to resume.",
        guardrail,
      },
      403,
    );
  }

  // A "hold" is the reliability wedge: the action is authorized but harmful, so
  // instead of executing OR hard-rejecting it, we enqueue it for a human, notify
  // operators, and hand the caller a resume token.
  if (guardrail && guardrail.action === "hold") {
    persistGuardrailEvent(202);
    let approvalId: string | undefined;
    let resumeToken: string | undefined;
    try {
      const approval = await createApprovalRequest({
        teamId,
        agentId: c.req.header("x-steadio-agent-id"),
        keyId: resolved?.keyId,
        decision: guardrail,
        actionPayload: {
          direction: guardrailCtxMeta?.direction,
          content: guardrailCtx?.content,
          toolCalls: guardrailCtx?.toolCalls,
        },
        contentPreview: guardrailCtxMeta?.contentPreview,
      });
      approvalId = approval.id;
      resumeToken = approval.resumeToken;
      void notifyHold(approval); // fire-and-forget Slack/webhook
    } catch (err) {
      // If we can't enqueue, fail closed on the hold: still stop the action, but
      // without a resume path.
      console.error("[gateway] approval enqueue error:", err);
    }
    return c.json(
      {
        error: "guardrail_held",
        action: "hold",
        message:
          guardrail.determinedBy?.reason ??
          "Action held by a SteadIO runtime guardrail, pending human approval.",
        approvalId,
        resumeToken,
        resumeWith: resumeToken ? { header: "X-SteadIO-Approval", value: resumeToken } : undefined,
        guardrail,
      },
      202,
    );
  }

  // block/throttle short-circuit before the provider call. Block is a hard deny
  // (no human override); throttle slows the caller.
  if (
    guardrail &&
    (guardrail.action === "block" || guardrail.action === "throttle")
  ) {
    const status = guardrail.action === "block" ? 403 : 429;
    persistGuardrailEvent(status);
    return c.json(
      {
        error: "guardrail_blocked",
        action: guardrail.action,
        message:
          guardrail.determinedBy?.reason ??
          "Request stopped by a SteadIO runtime guardrail before reaching the provider.",
        guardrail,
      },
      status,
    );
  }

  // Redact — the only mutating verdict. Non-terminal: mask the matched PII/secret
  // spans in the OUTBOUND body, record the firing, and forward the masked request.
  if (guardrail && guardrail.action === "redact") {
    persistGuardrailEvent(wouldBeStatus("redact"));
    if (parsedBody) parsedBody = redactBody(parsedBody, guardrail);
  }

  // Alert-mode findings persist but the request is allowed through.
  if (guardrail && guardrail.action === "alert") {
    persistGuardrailEvent(wouldBeStatus("alert"));
  }

  // Allowed (or alert-only, or redacted) — forward to the real upstream provider.
  const forwarded = await forwardToProvider(c, teamId, parsedBody);
  if (forwarded) {
    // Response-side groundedness: judge the provider's answer against the caller's
    // retrieved context. Inert unless sourceContext was supplied.
    const reviewed = await reviewResponseGroundedness(c, forwarded, {
      teamId,
      agentId: c.req.header("x-steadio-agent-id"),
      requestCtx: guardrailCtx,
      rules,
      detectors,
      laneOptions: gatewaySignalLaneOptions(),
      freezes,
      enforce,
    });
    return reviewed ?? forwarded;
  }

  // Non-forwardable path (e.g. a GET probe, an unknown /v1/* route, or a POST with
  // no upstream mapping): return an honest placeholder instead of a dead-host 404.
  return c.json(
    {
      error: "gateway_unavailable",
      message:
        "This /v1 path is not a forwardable LLM endpoint. Use /v1/chat/completions, /v1/messages, or /v1/embeddings with your provider key.",
      ...(guardrail && guardrail.findings.length ? { guardrail } : {}),
    },
    503,
  );
}

gatewayRoutes.post("/chat/completions", guard);
gatewayRoutes.post("/messages", guard);

// Any other /v1/* path hits the same auth gate so nothing under /v1 falls
// through to a bare 404 that reads as a dead deployment.
gatewayRoutes.all("/*", guard);
