// G1 — model-based prompt-injection detector on the A0 async signal lane
// (ELEAA-791). The impure counterpart of the pure engine's regex injection
// signal: it runs the classifier tier (the offline NormalizingRegexClassifier, or
// a BYO judge model), then folds the resulting 0..1 score into the context so the
// pure matchers pick it up — exactly like the G3 content-moderation detector folds
// in moderationScores.
//
// It emits BOTH wired effects the card calls for by re-running the two matchers
// that consume the score:
//   (a) prompt_injection      -> a standalone advisory finding when score >= threshold.
//   (b) privileged_tool_call  -> the action gate: an out-of-policy or in-policy
//       action taken while the score is high is HELD (escalateOnInjection).
//
// The classifier runs off the /v1 hot path (that's the whole point of A0) and is
// FAIL-OPEN: a throw / timeout in the lane contributes nothing, never a spurious
// block. The score is computed at most ONCE per distinct content per lane run,
// even though two detectors consume it, so we never pay for two judge calls.

import { MATCHERS } from "./rules.js";
import type { InjectionClassifier } from "./classifier.js";
import type {
  GuardrailContext,
  GuardrailFinding,
  GuardrailRule,
} from "./types.js";
import type { SignalDetector } from "./signal-lane.js";

// The free text the classifier scores: request/response content plus any
// stringified tool-call arguments (injection is sometimes smuggled through a tool
// argument, not the prose). Empty -> nothing to score.
function scoredText(ctx: GuardrailContext): string {
  const parts: string[] = [ctx.content ?? ""];
  for (const call of ctx.toolCalls ?? []) {
    if (call && typeof call === "object" && call.arguments != null) {
      try {
        parts.push(typeof call.arguments === "string" ? call.arguments : JSON.stringify(call.arguments));
      } catch {
        /* unserializable args — skip, the prose is usually where injection lives */
      }
    }
  }
  return parts.join("\n").trim();
}

// Build the injection detectors for the A0 signal lane. Returns TWO SignalDetectors
// (standalone finding + action gate) that share one score cache, so spread both
// into runSignalLane's detector list. Score computed once per content.
export function makeInjectionClassifierDetectors(
  classifier: InjectionClassifier,
): SignalDetector[] {
  // Per-lane-run memo: the same text scores once even though both detectors and
  // multiple rules of a type may ask for it. Keyed on the exact scored text.
  const inflight = new Map<string, Promise<number>>();
  const scoreOnce = (text: string): Promise<number> => {
    let p = inflight.get(text);
    if (!p) {
      // Fail-open at the source: a rejecting classifier scores 0 (did-not-run),
      // never a spurious escalation. The lane also isolates+times-out per detector.
      p = classifier.score(text).then((r) => r.injectionScore).catch(() => 0);
      inflight.set(text, p);
    }
    return p;
  };

  const detectFor =
    (type: "prompt_injection" | "privileged_tool_call") =>
    async (rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailFinding[]> => {
      const text = scoredText(ctx);
      if (!text) return [];
      const injectionScore = await scoreOnce(text);
      const matcher = MATCHERS[type];
      if (!matcher) return [];
      // Re-run the pure matcher with the freshly computed score folded in, so the
      // thresholding stays in one place (rules.ts) and the lane and sync path agree.
      const finding = matcher(rule, { ...ctx, injectionScore });
      return finding ? [finding] : [];
    };

  return [
    { type: "prompt_injection", detect: detectFor("prompt_injection") },
    { type: "privileged_tool_call", detect: detectFor("privileged_tool_call") },
  ];
}
