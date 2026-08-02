import { Hono } from "hono";
import { cors } from "hono/cors";
import { bodyLimit } from "hono/body-limit";
import { DEFAULT_RULES } from "../guardrails/rules.js";
import { evaluate } from "../guardrails/engine.js";
import {
  ATTACK_PACK,
  runReliabilityCheck,
  type AttackCase,
} from "../guardrails/attack-pack.js";
import type { GuardrailContext, ToolCall } from "../guardrails/types.js";

// Self-serve Reliability Check (ELEAA-665, Hackathon Track E).
//
// The product-led aha that gives us a real PMF read: a prospect runs our sample
// attack pack (v0) against the SAME engine the /v1 gateway enforces and gets
// back a reliability score plus a report of exactly what we'd have caught — no
// signup, no sales call. Growth (ELEAA-646) wires this as the pull-test entry
// point. Public and read-only; no auth, no persistence.
//
// "Point at your own agent endpoint" is the v1 extension — the runner is written
// against a pluggable pack so a live-probe adapter can be dropped in later; the
// public surface stays "run the sample" until we can probe a caller URL safely
// (SSRF-guarded, opt-in). Not built here on purpose (least privilege).

export const reliabilityCheckRoutes = new Hono();

const SCAN_BODY_LIMIT_BYTES = 64 * 1024;
const MAX_SCAN_ACTIONS = 50;
const MAX_SCAN_TOOL_CALLS = 20;
const MAX_SCAN_CONTENT_CHARS = 10_000;
const MAX_SCAN_TOOL_NAME_CHARS = 200;
const MAX_SCAN_ARGUMENT_CHARS = 2_000;

reliabilityCheckRoutes.use("*", cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"] }));
reliabilityCheckRoutes.use(
  "/scan",
  bodyLimit({
    maxSize: SCAN_BODY_LIMIT_BYTES,
    onError: (c) =>
      c.json(
        { error: "payload_too_large", message: "Reliability Check scan body must be 64KB or smaller" },
        413,
      ),
  }),
);

function sanitizeToolArguments(args: ToolCall["arguments"]): ToolCall["arguments"] {
  if (args == null) return undefined;
  if (typeof args === "string") return args.slice(0, MAX_SCAN_ARGUMENT_CHARS);

  try {
    const serialized = JSON.stringify(args);
    if (serialized.length > MAX_SCAN_ARGUMENT_CHARS) {
      return serialized.slice(0, MAX_SCAN_ARGUMENT_CHARS);
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function sanitizeToolCall(call: unknown): ToolCall | undefined {
  if (typeof call !== "object" || call === null) return undefined;
  const candidate = call as { name?: unknown; arguments?: ToolCall["arguments"] };
  if (typeof candidate.name !== "string" || candidate.name.trim() === "") return undefined;

  return {
    name: candidate.name.slice(0, MAX_SCAN_TOOL_NAME_CHARS),
    arguments: sanitizeToolArguments(candidate.arguments),
  };
}

// Trim a case down to what the result view needs — the scenario plus its live
// verdict. We ship the full context so a skeptic can reproduce it via /evaluate.
function serializeCase(c: AttackCase) {
  return {
    id: c.id,
    kind: c.kind,
    category: c.category,
    persona: c.persona,
    title: c.title,
    narrative: c.narrative,
    expect: c.expect,
    context: c.context,
  };
}

// GET /api/demo/reliability-check — run the sample attack pack against the live
// SteadIO rule set and return the full report: score, grade, per-category
// coverage, the caught-action list, and the false-positive control result. This
// IS the shareable result view's data source.
reliabilityCheckRoutes.get("/", (c) => {
  const report = runReliabilityCheck(DEFAULT_RULES);
  // Contrast: with no reliability layer, every attack lands on the customer.
  const bare = runReliabilityCheck([]);
  const unprotectedExposure = bare.attacksTotal - bare.attacksCaught;

  return c.json({
    demo: true,
    // Headline numbers for the score card.
    score: report.score,
    grade: report.grade,
    attacksTotal: report.attacksTotal,
    attacksCaught: report.attacksCaught,
    controlsTotal: report.controlsTotal,
    falsePositives: report.falsePositives,
    unprotectedExposure,
    byCategory: report.byCategory,
    ruleSet: report.ruleSet,
    // Full per-case results with live decisions — the "what we'd have caught" list.
    results: report.results.map((r) => ({
      case: serializeCase(r.case),
      decision: r.decision,
      passed: r.passed,
    })),
  });
});

// GET /api/demo/reliability-check/pack — the raw attack pack (scenarios only,
// no verdicts), for docs / Growth / PM (Track F) to review and extend.
reliabilityCheckRoutes.get("/pack", (c) =>
  c.json({ demo: true, pack: ATTACK_PACK.map(serializeCase) }),
);

// POST /api/demo/reliability-check/scan — v0 "bring your own actions": a prospect
// POSTs a list of their agent's actions (GuardrailContext[]) and gets the same
// score against the SteadIO rule set. This is the self-serve check without
// exposing our curated pack, and the seam a live-endpoint prober plugs into.
reliabilityCheckRoutes.post("/scan", async (c) => {
  let body: { actions?: unknown } = {};
  try {
    body = (await c.req.json()) as { actions?: unknown };
  } catch {
    return c.json({ error: "invalid_json", message: "Body must be { actions: GuardrailContext[] }" }, 400);
  }
  if (!Array.isArray(body.actions) || body.actions.length === 0) {
    return c.json({ error: "no_actions", message: "Provide a non-empty `actions` array." }, 400);
  }
  // Bound the input so the public endpoint can't be abused (regex DoS / flood).
  const actions = (body.actions as GuardrailContext[]).slice(0, MAX_SCAN_ACTIONS).map((a, i) => ({
    index: i,
    content: typeof a?.content === "string" ? a.content.slice(0, MAX_SCAN_CONTENT_CHARS) : undefined,
    toolCalls: Array.isArray(a?.toolCalls)
      ? a.toolCalls.slice(0, MAX_SCAN_TOOL_CALLS).map(sanitizeToolCall).filter((call): call is ToolCall => Boolean(call))
      : undefined,
    direction: a?.direction === "response" ? ("response" as const) : ("request" as const),
    repeatCount: typeof a?.repeatCount === "number" ? a.repeatCount : undefined,
  }));

  const results = actions.map((a) => {
    const { index, ...ctx } = a;
    const decision = evaluate(ctx);
    return { index, context: ctx, decision, halted: decision.action === "block" || decision.action === "hold" };
  });
  const flagged = results.filter((r) => r.decision.action !== "allow").length;

  return c.json({
    demo: true,
    total: results.length,
    flagged,
    // How many of the caller's own actions the SteadIO engine would have stopped
    // (block or hold) before they reached a customer.
    haltedCount: results.filter((r) => r.halted).length,
    results,
  });
});
