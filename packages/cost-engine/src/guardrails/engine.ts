// Guardrail engine (ELEAA-640) — the pure evaluation core.
//
// evaluate() runs every enabled rule against one action and collapses the
// matched findings into a single decision. It is the one place that decides
// allow / alert / throttle / block, so the /v1 gateway, the demo route, and the
// landing narrative all agree by construction.

import { MATCHERS, DEFAULT_RULES } from "./rules.js";
import {
  ACTION_SEVERITY,
  type AgentFreeze,
  type GuardrailAction,
  type GuardrailContext,
  type GuardrailDecision,
  type GuardrailFinding,
  type GuardrailRule,
} from "./types.js";

// The synthetic rule id/type an operator freeze reports as. It is NOT a matcher
// in MATCHERS — a freeze is state (agent_freezes), not a content signal — so it
// short-circuits evaluate() above every rule.
export const KILL_SWITCH_RULE_ID = "kill_switch";

// Which active freeze, if any, applies to this action. A whole-agent freeze
// (no toolName) always applies. A per-tool freeze applies only when that tool is
// actually being invoked in this request — so freezing one tool leaves every
// other tool evaluating normally (ELEAA-747 acceptance criterion). Whole-agent
// freezes win over per-tool ones.
export function matchFreeze(
  freezes: AgentFreeze[] | undefined,
  ctx: GuardrailContext,
): AgentFreeze | null {
  if (!freezes?.length) return null;
  const wholeAgent = freezes.find((f) => f.toolName == null);
  if (wholeAgent) return wholeAgent;
  const called = new Set(
    (ctx.toolCalls ?? [])
      .map((t) => (typeof t?.name === "string" ? t.name.toLowerCase() : ""))
      .filter(Boolean),
  );
  return (
    freezes.find(
      (f) => f.toolName != null && called.has(f.toolName.toLowerCase()),
    ) ?? null
  );
}

// The terminal block finding an active freeze produces. Carries who/why so the
// gateway response, the events feed, and the audit record all show the operator
// and reason without re-deriving them.
export function freezeFinding(freeze: AgentFreeze): GuardrailFinding {
  const scope = freeze.toolName ? `tool "${freeze.toolName}"` : "agent";
  const who = freeze.actor ? ` by ${freeze.actor}` : "";
  const why = freeze.reason ? ` — ${freeze.reason}` : "";
  return {
    ruleId: KILL_SWITCH_RULE_ID,
    ruleType: "kill_switch",
    mode: "block",
    reason: `Kill-switch: ${scope} frozen${who}${why}. Unfreeze to resume.`,
    evidence: {
      killSwitch: true,
      scope: freeze.toolName ? "tool" : "agent",
      ...(freeze.toolName ? { toolName: freeze.toolName } : {}),
      ...(freeze.actor ? { actor: freeze.actor } : {}),
      ...(freeze.reason ? { freezeReason: freeze.reason } : {}),
    },
  };
}

// Collapse a set of matched findings into one decision: highest severity wins,
// sorted so the most severe is first and stable. Shared by the pure evaluate()
// and the async signal lane (evaluateWithSignals) so both agree by construction.
export function collapse(findings: GuardrailFinding[]): GuardrailDecision {
  const sorted = [...findings].sort(
    (a, b) => ACTION_SEVERITY[b.mode] - ACTION_SEVERITY[a.mode],
  );
  const action: GuardrailAction = sorted[0]?.mode ?? "allow";
  return { action, findings: sorted, determinedBy: sorted[0] };
}

export function evaluate(
  ctx: GuardrailContext,
  rules: GuardrailRule[] = DEFAULT_RULES,
  freezes?: AgentFreeze[],
): GuardrailDecision {
  // Kill-switch first, above every rule (ELEAA-747). A freeze is a terminal block
  // and wins over any lower-severity allow/alert/hold/throttle on the same
  // request; short-circuiting here also guarantees the determinant is the
  // kill_switch finding so the audit record attributes the block to the operator.
  const freeze = matchFreeze(freezes, ctx);
  if (freeze) {
    const finding = freezeFinding(freeze);
    return { action: "block", findings: [finding], determinedBy: finding };
  }

  const findings: GuardrailFinding[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const matcher = MATCHERS[rule.type];
    if (!matcher) continue;
    let finding: GuardrailFinding | null = null;
    try {
      finding = matcher(rule, ctx);
    } catch {
      // A matcher must never take down the request path. Fail open per-rule;
      // the other rules still run. (Fail-open here is a deliberate demo/MVP
      // choice — a production hard-mode would fail closed on block rules.)
      finding = null;
    }
    if (finding) findings.push(finding);
  }

  // Highest severity wins; sort so the most severe is first and stable.
  return collapse(findings);
}

// Convenience for callers that only need the terminal verdict.
export function isBlocked(decision: GuardrailDecision): boolean {
  return decision.action === "block";
}

// True when the action must NOT execute as-is — a hard block or a hold pending
// human approval. Both short-circuit the /v1 path; the difference is whether a
// human can still let it through.
export function isHalted(decision: GuardrailDecision): boolean {
  return decision.action === "block" || decision.action === "hold";
}

// Apply every redact-mode finding's transform to `text`, returning the masked
// string (ELEAA-788 G4a). The pure engine only DECIDES what to mask; this is the
// caller's apply-step — run it AFTER evaluate(), before forwarding/returning, so
// a "redact" verdict forwards the content with its PII/secret spans masked and
// the rest intact. Longest matches are applied first so a shorter span nested in
// a longer one can't leave a residual fragment. A no-transform decision (any
// other verdict) returns the text unchanged.
export function applyRedactions(
  text: string,
  decision: GuardrailDecision,
): string {
  const spans = decision.findings.flatMap((f) => f.transform ?? []);
  if (spans.length === 0) return text;
  let out = text;
  for (const { find, replacement } of [...spans].sort(
    (a, b) => b.find.length - a.find.length,
  )) {
    if (find) out = out.split(find).join(replacement);
  }
  return out;
}

export { DEFAULT_RULES } from "./rules.js";
export * from "./types.js";
