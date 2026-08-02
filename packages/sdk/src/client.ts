// @steadio/sdk — the Steadio client (ELEAA-679, Hackathon Track G).
//
// A thin wrapper over the guardrails endpoints already live on api.steadio.ai.
// It adds NO detectors of its own — it routes an agent's LLM + tool calls
// through the SAME evaluate() the /v1 gateway runs, and hands back one clean
// Verdict so a developer can branch on allow / block / hold / throttle in ~3
// lines. DX is the product: the goal is a prospect wiring this in during a call.
//
// Two transports, one Verdict shape:
//   • keyless  → POST {base}/api/demo/guardrails/evaluate  (public, instant,
//     full fidelity incl. direction + repeatCount + a resolvable hold queue).
//     This is what makes a ≤10-minute quickstart possible with no provisioning.
//   • with key → POST {base}/v1/chat/completions            (real enforcement,
//     events persisted to the caller's dashboard, DB-backed hold/approval queue).
// The client auto-selects: a key means "production path", no key means "demo".

import type { AgentAction, ChatLike, Verdict, Finding, ToolCall } from "./types.js";
import {
  SteadioBlockedError,
  SteadioThrottledError,
  SteadioHeldError,
  SteadioTransportError,
} from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.steadio.ai";

export interface SteadioOptions {
  /**
   * SteadIO API key (st_...). When set, checks run through the authenticated
   * /v1 gateway (real enforcement + dashboard persistence). When omitted, the
   * client runs against the public, keyless demo endpoint — ideal for a first
   * ≤10-minute integration with nothing to provision.
   */
  apiKey?: string;
  /** Base URL of the SteadIO API. Defaults to https://api.steadio.ai. */
  baseUrl?: string;
  /** Default agent id attached to every action (overridable per call). */
  agentId?: string;
  /** Force a transport regardless of apiKey. Rarely needed. */
  transport?: "demo" | "v1";
  /** Per-request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Inject a fetch (tests / non-global-fetch runtimes). Defaults to global. */
  fetch?: typeof fetch;
}

const ALLOWED_ACTIONS = new Set(["allow", "alert"]);

/** Normalize an AgentAction | ChatLike into a flat AgentAction. */
function toAction(input: AgentAction | ChatLike): AgentAction {
  const anyIn = input as ChatLike & AgentAction;
  // ChatLike: flatten messages -> content.
  if (Array.isArray(anyIn.messages)) {
    const content = anyIn.messages
      .map((m) => (typeof m.content === "string" ? m.content : stringifyContent(m.content)))
      .filter(Boolean)
      .join("\n");
    const out: AgentAction = {};
    if (content) out.content = content;
    if (anyIn.toolCalls) out.toolCalls = anyIn.toolCalls;
    if (anyIn.direction) out.direction = anyIn.direction;
    if (anyIn.agentId) out.agentId = anyIn.agentId;
    return out;
  }
  return { ...anyIn };
}

function stringifyContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === "string") return p;
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          if (typeof o["text"] === "string") return o["text"];
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/** Build an OpenAI-compatible body so the /v1 gateway's adapter can read it. */
function toChatBody(action: AgentAction): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = [];
  if (action.content) messages.push({ role: "user", content: action.content });
  if (action.toolCalls?.length) {
    messages.push({
      role: "assistant",
      content: "",
      tool_calls: action.toolCalls.map((tc, i) => ({
        id: `call_${i}`,
        type: "function",
        function: {
          name: tc.name,
          arguments:
            typeof tc.arguments === "string" ? tc.arguments : JSON.stringify(tc.arguments ?? {}),
        },
      })),
    });
  }
  return { model: "steadio-guard-check", messages };
}

function findingsFrom(raw: unknown): { findings: Finding[]; determinedBy?: Finding } {
  const d = (raw ?? {}) as Record<string, unknown>;
  const findings = Array.isArray(d["findings"]) ? (d["findings"] as Finding[]) : [];
  const determinedBy = (d["determinedBy"] as Finding | undefined) ?? findings[0];
  return determinedBy ? { findings, determinedBy } : { findings };
}

export class Steadio {
  readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly agentId: string | undefined;
  private readonly transport: "demo" | "v1";
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;

  constructor(opts: SteadioOptions = {}) {
    this.apiKey = opts.apiKey ?? process.env["STEADIO_API_KEY"];
    this.baseUrl = (opts.baseUrl ?? process.env["STEADIO_BASE_URL"] ?? DEFAULT_BASE_URL).replace(
      /\/+$/,
      "",
    );
    this.agentId = opts.agentId;
    this.transport = opts.transport ?? (this.apiKey ? "v1" : "demo");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    const f = opts.fetch ?? globalThis.fetch;
    if (typeof f !== "function") {
      throw new SteadioTransportError(
        "No fetch available. Use Node >=18, or pass { fetch } to the Steadio constructor.",
      );
    }
    this.doFetch = f;
  }

  /**
   * Evaluate one agent action and return a clean Verdict. Never throws on a
   * guardrail verdict (block/hold/throttle) — inspect `verdict.action` /
   * `verdict.allowed`. Only throws on transport/auth failure.
   */
  async check(input: AgentAction | ChatLike): Promise<Verdict> {
    const action = toAction(input);
    return this.transport === "v1" ? this.checkV1(action) : this.checkDemo(action);
  }

  /**
   * Guard a real LLM/tool call. Runs `check()` first; if the action is allowed
   * it invokes `run()` and returns its result. Otherwise it throws a typed error
   * (SteadioBlockedError / SteadioHeldError / SteadioThrottledError) so the
   * unsafe call is never made. This is the "wrap your call in one function" path.
   */
  async guard<T>(input: AgentAction | ChatLike, run: (verdict: Verdict) => Promise<T> | T): Promise<T> {
    const verdict = await this.check(input);
    if (verdict.allowed) return run(verdict);
    if (verdict.action === "block") throw new SteadioBlockedError(verdict);
    if (verdict.action === "throttle") throw new SteadioThrottledError(verdict);
    throw new SteadioHeldError(verdict); // hold
  }

  // --- transports ----------------------------------------------------------

  private async checkDemo(action: AgentAction): Promise<Verdict> {
    const body = {
      agentId: action.agentId ?? this.agentId,
      content: action.content,
      toolCalls: action.toolCalls,
      direction: action.direction ?? "request",
      repeatCount: action.repeatCount,
    };
    const { status, json } = await this.post("/api/demo/guardrails/evaluate", body);
    if (status >= 400) {
      throw new SteadioTransportError(`Demo evaluate failed (HTTP ${status})`, status, json);
    }
    const decision = (json as Record<string, unknown>)["decision"];
    const approval = (json as Record<string, unknown>)["approval"] as
      | { id?: string }
      | undefined;
    return this.normalize(decision, status, { approvalId: approval?.id });
  }

  private async checkV1(action: AgentAction): Promise<Verdict> {
    const { status, json } = await this.post("/v1/chat/completions", toChatBody(action), {
      "X-SteadIO-Key": this.apiKey ?? "",
      ...(action.agentId ?? this.agentId
        ? { "X-SteadIO-Agent-Id": (action.agentId ?? this.agentId) as string }
        : {}),
    });
    const j = (json ?? {}) as Record<string, unknown>;

    if (status === 401) {
      throw new SteadioTransportError(
        "Invalid or missing SteadIO API key",
        401,
        json,
      );
    }
    // The gateway encodes the verdict in the HTTP status + `action` field:
    //   403 block · 429 throttle · 202 hold · 503 gateway_unavailable == allow.
    const guardrail = (j["guardrail"] ?? j) as Record<string, unknown>;
    if (status === 202 && j["action"] === "hold") {
      return this.normalize({ ...guardrail, action: "hold" }, status, {
        approvalId: j["approvalId"] as string | undefined,
        resumeToken: j["resumeToken"] as string | undefined,
      });
    }
    if (status === 403 || status === 429) {
      return this.normalize(
        { ...guardrail, action: status === 403 ? "block" : "throttle" },
        status,
      );
    }
    // 503 gateway_unavailable (monitor-only / non-forwardable path) OR 200 both
    // mean the guardrail let it through. Surface any advisory findings.
    if (status === 503 || status < 400) {
      const hasGuardrail = j["guardrail"] && typeof j["guardrail"] === "object";
      return this.normalize(
        hasGuardrail ? j["guardrail"] : { action: "allow", findings: [] },
        status,
      );
    }
    throw new SteadioTransportError(`Unexpected gateway response (HTTP ${status})`, status, json);
  }

  /**
   * Resume a held action after an operator approves it. In demo mode this drives
   * the public hold queue; with a key you would re-issue the original request
   * with the X-SteadIO-Approval header (see README). Returns the demo outcome.
   */
  async resolveDemoApproval(
    approvalId: string,
    decision: "approve" | "deny",
  ): Promise<{ status: string }> {
    const { json } = await this.post(`/api/demo/guardrails/approvals/${approvalId}/resolve`, {
      decision,
    });
    const appr = (json as Record<string, unknown>)["approval"] as { status?: string } | undefined;
    return { status: appr?.status ?? "unknown" };
  }

  // --- helpers -------------------------------------------------------------

  private normalize(
    rawDecision: unknown,
    httpStatus: number,
    extra?: { approvalId?: string | undefined; resumeToken?: string | undefined },
  ): Verdict {
    const d = (rawDecision ?? {}) as Record<string, unknown>;
    const action = (d["action"] as Verdict["action"]) ?? "allow";
    const { findings, determinedBy } = findingsFrom(d);
    const reason =
      determinedBy?.reason ??
      (action === "allow"
        ? "No guardrail fired — action allowed."
        : `Action ${action} by a SteadIO guardrail.`);
    const verdict: Verdict = {
      action,
      allowed: ALLOWED_ACTIONS.has(action),
      findings,
      reason,
      httpStatus,
      raw: rawDecision,
    };
    if (determinedBy) verdict.determinedBy = determinedBy;
    if (extra?.approvalId) verdict.approvalId = extra.approvalId;
    if (extra?.resumeToken) verdict.resumeToken = extra.resumeToken;
    return verdict;
  }

  private async post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; json: unknown }> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const resp = await this.doFetch(`${this.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      const text = await resp.text();
      let json: unknown = undefined;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = { raw: text };
      }
      return { status: resp.status, json };
    } catch (err) {
      if (err instanceof SteadioTransportError) throw err;
      const msg = (err as Error)?.name === "AbortError" ? "request timed out" : String(err);
      throw new SteadioTransportError(`SteadIO request to ${path} failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Re-export for a one-liner: `import { Steadio } from "@steadio/sdk"`. */
export type { AgentAction, ChatLike, Verdict, Finding, ToolCall };
