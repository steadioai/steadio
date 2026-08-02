// NSA-compliant tool ledger (ELEAA-745).
//
// June-2026 NSA/DoD MCP guidance requires that *every* tool invocation an agent
// makes be recorded and checked — not only the ones that trip a guardrail. The
// guardrail_events feed already captures non-allow decisions; this builds the
// complementary audit record: one entry per tool call in a request, allowed or
// not, safe to persist and hand to an auditor.
//
// It is a pure function of (context, decision, timestamp) so it stays
// deterministic and unit-testable; the stateful caller supplies `now` and
// persists the rows. Arguments are masked and only a hash of the (masked) call
// is retained, so the ledger never stores a raw secret.

import { createHash } from "node:crypto";
import type {
  GuardrailContext,
  GuardrailDecision,
  GuardrailFinding,
  GuardrailMode,
  ToolCall,
  ToolLedgerEntry,
  ToolLedgerStatus,
} from "./types.js";

// Secrets we must never write to the ledger, even masked into evidence. Kept in
// sync with rules.ts SECRET_PATTERNS by intent; a superset is safe here.
const LEDGER_SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9-]{16,}/g,
  /sk-[a-zA-Z0-9]{16,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ghp_[a-zA-Z0-9]{20,}/g,
  /xox[baprs]-[a-zA-Z0-9-]{10,}/g,
  /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END[^-]*-----/g,
];
const LEDGER_PII_PATTERNS: RegExp[] = [
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // email
  /\b\d{3}-\d{2}-\d{4}\b/g, // ssn
  /\b(?:\d[ -]?){13,16}\b/g, // card
];

const MAX_STRING = 256;

// Strip secrets/PII from a string and truncate it. Shared by value and key
// redaction so a secret can never survive in either position.
function redactString(s: string): string {
  for (const re of LEDGER_SECRET_PATTERNS) s = s.replace(re, "[redacted:secret]");
  for (const re of LEDGER_PII_PATTERNS) s = s.replace(re, "[redacted:pii]");
  if (s.length > MAX_STRING) s = `${s.slice(0, MAX_STRING)}…[+${s.length - MAX_STRING}]`;
  return s;
}

// Redact a single value: strip secrets/PII, truncate long strings. Objects and
// arrays are redacted recursively; numbers/booleans pass through unchanged.
// Object keys are user-controlled too, so they are redacted as well as values.
function redactValue(v: unknown): unknown {
  if (typeof v === "string") return redactString(v);
  if (Array.isArray(v)) return v.slice(0, 50).map(redactValue);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[redactString(k)] = redactValue(val);
    }
    return out;
  }
  return v;
}

// Normalize a tool call's arguments (object or JSON string) into a masked object.
function maskParams(args: ToolCall["arguments"]): Record<string, unknown> {
  let obj: unknown = args;
  if (typeof args === "string") {
    try {
      obj = JSON.parse(args);
    } catch {
      return { _raw: redactValue(args) };
    }
  }
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    return redactValue(obj) as Record<string, unknown>;
  }
  if (obj == null) return {};
  return { _value: redactValue(obj) };
}

const MODE_TO_STATUS: Record<GuardrailMode, ToolLedgerStatus> = {
  block: "blocked",
  hold: "held",
  redact: "redacted",
  throttle: "throttled",
  alert: "alerted",
};

// A finding attributed to this specific tool call (its evidence names the tool).
function findingForCall(name: string, findings: GuardrailFinding[]): GuardrailFinding | undefined {
  return findings.find((f) => {
    const t = f.evidence?.["tool"];
    return typeof t === "string" && t === name;
  });
}

// The verdict for one tool call. A finding that names this tool wins. Otherwise
// the call inherits the request verdict: if the request was blocked or held, no
// tool executed, so the call is recorded blocked/held; a throttle still runs the
// tool (delayed); an allow/alert lets it through.
function statusForCall(
  call: ToolCall,
  decision: GuardrailDecision,
): { status: ToolLedgerStatus; ruleId?: string | undefined } {
  const own = findingForCall(call.name, decision.findings);
  if (own) return { status: MODE_TO_STATUS[own.mode], ruleId: own.ruleId };
  switch (decision.action) {
    case "block":
      return { status: "blocked", ruleId: decision.determinedBy?.ruleId };
    case "hold":
      return { status: "held", ruleId: decision.determinedBy?.ruleId };
    case "throttle":
      return { status: "throttled", ruleId: decision.determinedBy?.ruleId };
    default:
      return { status: "allowed" };
  }
}

export interface ToolLedgerOptions {
  // ISO-8601 timestamp for every entry in this batch. Supplied by the caller so
  // the builder stays pure (no Date.now()).
  now: string;
}

// Build one ledger entry per tool call in the context. Returns [] when the
// request made no tool calls (nothing to log).
export function buildToolLedger(
  ctx: GuardrailContext,
  decision: GuardrailDecision,
  opts: ToolLedgerOptions,
): ToolLedgerEntry[] {
  const calls = ctx.toolCalls ?? [];
  const entries: ToolLedgerEntry[] = [];
  for (const call of calls) {
    if (!call || typeof call !== "object" || typeof call.name !== "string") continue;
    const paramsMasked = maskParams(call.arguments);
    const { status, ruleId } = statusForCall(call, decision);
    // Hash the whole canonical row, not just the call arguments, so tampering
    // with the verdict (resultStatus/ruleId) or identity/timestamp is detectable
    // — that decision is the audit value this ledger exists to protect.
    const canonical = JSON.stringify({
      toolName: call.name,
      agentId: ctx.agentId ?? null,
      identity: ctx.identity ?? null,
      paramsMasked,
      resultStatus: status,
      ruleId: ruleId ?? null,
      ts: opts.now,
    });
    const resultHash = createHash("sha256").update(canonical).digest("hex");
    entries.push({
      toolName: call.name,
      agentId: ctx.agentId,
      identity: ctx.identity,
      paramsMasked,
      resultStatus: status,
      ruleId,
      resultHash,
      ts: opts.now,
    });
  }
  return entries;
}
