// A0 — the async signal lane (ELEAA-787, gates G1/G2/G3).
//
// The pure engine (evaluate()) is synchronous and I/O-free: fast regex/policy
// matchers that must never block the /v1 request path. But a whole class of
// reliability signals — toxicity/moderation (G3), groundedness (G2), an
// injection classifier (G1) — needs a model or a provider endpoint to score the
// action. Those are impure and slow, so they can't live inside evaluate().
//
// The signal lane is where they run. It is a *pre-eval detector stage* that:
//   - runs each registered detector for the enabled rules, concurrently;
//   - is FAIL-OPEN: a detector that throws, rejects, or exceeds its time budget
//     contributes NOTHING (never a spurious block) and never takes down the path;
//   - is time-bounded per detector, so one slow provider can't stall the request.
//
// Its findings are merged with the synchronous engine's findings and collapsed by
// the same severity rule, so the lane and the fast path agree by construction.
//
// A "detector" is the impure counterpart of a matcher: it does the I/O (call a
// moderation endpoint, run an NLI judge), then emits GuardrailFindings. G3's
// content-moderation detector is the first one wired here (cheapest to validate
// the lane end-to-end).

import { collapse, evaluate } from "./engine.js";
import { DEFAULT_RULES } from "./rules.js";
import type {
  AgentFreeze,
  GuardrailContext,
  GuardrailDecision,
  GuardrailFinding,
  GuardrailRule,
  GuardrailRuleType,
} from "./types.js";

// The impure counterpart of a matcher. One detector implements one rule type. It
// MAY throw or reject — the lane isolates it and fails open — but a well-behaved
// detector returns [] when nothing fires.
export interface SignalDetector {
  type: GuardrailRuleType;
  detect(rule: GuardrailRule, ctx: GuardrailContext): Promise<GuardrailFinding[]>;
}

export interface SignalLaneOptions {
  // Per-detector wall-clock budget. A detector still running at the deadline is
  // abandoned (fail-open, contributes nothing). Default 1500ms — generous enough
  // for a single moderation/classifier call, tight enough not to stall /v1.
  timeoutMs?: number;
  // Observability hook for a detector that failed or timed out. Never rethrown —
  // the lane stays fail-open. Lets the caller log/count lane errors.
  onError?: (detectorType: GuardrailRuleType, err: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 1500;

// A detector that exceeds its budget is abandoned (fail-open), but the skip must
// be VISIBLE — a silently-dropped signal is how a reliability product loses trust.
// So a timeout contributes a single non-blocking `alert` finding noting the skip.
// It never blocks (alert is severity 1, the request proceeds) but it surfaces in
// the events feed / response so the caller sees the detector did not run.
// NOTE: only a *timeout* emits this. A detector that throws is handled by its own
// inner catch (which reports via onError and returns []), so the two failure modes
// stay distinguishable in the record.
function detectorSkippedFinding(
  rule: GuardrailRule,
  timeoutMs: number,
): GuardrailFinding {
  return {
    ruleId: rule.id,
    ruleType: rule.type,
    mode: "alert",
    reason: `signal detector for ${rule.type} exceeded ${timeoutMs}ms budget — skipped (fail-open)`,
    evidence: { detectorSkipped: true, detectorType: rule.type, timeoutMs },
  };
}

// Resolve to `fallback` if `p` has not settled within `ms`. The pending promise
// is abandoned, not cancelled (JS can't cancel a fetch mid-flight here), but its
// eventual result is ignored — the request has already moved on. `onTimeout` (if
// given) fires exactly when the timer wins, so the caller can distinguish a real
// timeout from a detector that simply returned the same value as the fallback.
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  fallback: T,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        onTimeout?.();
        resolve(fallback);
      }
    }, ms);
    // Do not keep the event loop alive just for this timer (Node).
    if (typeof (timer as { unref?: () => void }).unref === "function") {
      (timer as { unref: () => void }).unref();
    }
    p.then(
      (v) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(v);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(fallback);
        }
      },
    );
  });
}

// Run the async signal lane and return every finding it produced. Only enabled
// rules whose type has a registered detector are run; each runs concurrently,
// isolated and time-bounded. Never throws.
export async function runSignalLane(
  ctx: GuardrailContext,
  rules: GuardrailRule[] = DEFAULT_RULES,
  detectors: SignalDetector[] = [],
  opts: SignalLaneOptions = {},
): Promise<GuardrailFinding[]> {
  if (!detectors.length) return [];
  const byType = new Map<GuardrailRuleType, SignalDetector>();
  for (const d of detectors) byType.set(d.type, d);

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const jobs: Array<Promise<GuardrailFinding[]>> = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    const detector = byType.get(rule.type);
    if (!detector) continue;
    // Each detector is fully isolated: its own try/catch AND its own timeout, so
    // neither a throw, a rejection, nor a hang can affect the others or the path.
    const job = withTimeout(
      (async () => {
        try {
          return await detector.detect(rule, ctx);
        } catch (err) {
          opts.onError?.(rule.type, err);
          return [] as GuardrailFinding[];
        }
      })(),
      timeoutMs,
      // Timed out -> fail-open (never a block) but VISIBLE: an alert finding that
      // records the skip. Also report it through onError so callers that count
      // lane failures see a timeout the same as a throw.
      [detectorSkippedFinding(rule, timeoutMs)],
      () =>
        opts.onError?.(
          rule.type,
          new Error(`detector timed out after ${timeoutMs}ms`),
        ),
    );
    jobs.push(job);
  }

  const settled = await Promise.all(jobs);
  return settled.flat();
}

// The full evaluation: run the synchronous engine and the async lane, then
// collapse both findings sets with the same severity rule. A kill-switch freeze
// still short-circuits inside evaluate() and wins (it's a terminal block), so we
// respect it: if the sync pass already hard-blocked on a freeze, skip the lane.
export async function evaluateWithSignals(
  ctx: GuardrailContext,
  rules: GuardrailRule[] = DEFAULT_RULES,
  detectors: SignalDetector[] = [],
  opts: SignalLaneOptions = {},
  freezes?: AgentFreeze[],
): Promise<GuardrailDecision> {
  const sync = evaluate(ctx, rules, freezes);
  // A freeze is a terminal operator block — don't spend a provider call to add a
  // lower-severity finding that can't change the verdict.
  if (sync.determinedBy?.ruleType === "kill_switch") return sync;
  const laneFindings = await runSignalLane(ctx, rules, detectors, opts);
  if (laneFindings.length === 0) return sync;
  return collapse([...sync.findings, ...laneFindings]);
}
