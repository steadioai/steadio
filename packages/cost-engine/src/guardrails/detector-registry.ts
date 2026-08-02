// A0 — signal-lane detector registry (ELEAA-787).
//
// The /v1 gateway (routes/gateway.ts) runs the async signal lane BEFORE the pure
// engine's evaluate(). This module answers "which detectors run" so the gateway
// stays declarative and the wiring is unit-testable in one place.
//
// PROD-SAFE BY DEFAULT. The registry returns an EMPTY list unless the lane is
// explicitly enabled. So with a stock environment:
//   - the gateway calls evaluateWithSignals() with zero detectors,
//   - runSignalLane() short-circuits to [] with no network call,
//   - the decision is byte-identical to the old synchronous evaluate() path,
//   - the public demo route (which never uses this registry) is untouched.
// When the lane IS enabled, each detector still self-gates: the provider-backed
// ones (G3 moderation) only wire when their key is provisioned, and every detector
// stays inert until its trigger is present (e.g. groundedness needs response
// egress WITH caller sourceContext). This keeps the fail-open, no-surprise posture
// of the rest of the engine.
//
// KEY-FREE INJECTION TIER (ELEAA-814). The lane's injection detector uses the
// OFFLINE NormalizingRegexClassifier — no network, no provider key. So flipping
// STEADIO_SIGNAL_LANE=1 alone adds coverage for the paraphrased/encoded/obfuscated
// injection the always-on synchronous regex (rules.ts INJECTION_PATTERNS) misses,
// without provisioning anything. Content-moderation (G3) is the ONLY detector that
// needs a provisioned key, and it degrades gracefully when the key is absent.

import {
  makeContentModerationDetector,
  openAIModerationClientFromEnv,
} from "./content-moderation.js";
import { makeGroundednessDetector } from "./groundedness-judge.js";
import { makeInjectionClassifierDetectors } from "./injection-classifier.js";
import { NormalizingRegexClassifier } from "./classifier.js";
import type { SignalLaneOptions, SignalDetector } from "./signal-lane.js";
import type { GuardrailRuleType } from "./types.js";

// Per-detector wall-clock budget on the /v1 hot path. Tighter than the library
// default (1500ms) because this is inline, request-blocking work: one moderation
// call is well under this, and a detector that overruns is skipped fail-open (an
// alert finding records the skip — see signal-lane.ts).
const DEFAULT_GATEWAY_TIMEOUT_MS = 800;

function laneEnabled(env: NodeJS.ProcessEnv): boolean {
  const v = (env["STEADIO_SIGNAL_LANE"] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}

// Assemble the detectors that should run on the gateway signal lane for this
// environment. Empty unless the lane is enabled AND a provider is available, so
// the default gateway path makes no network call and is unchanged.
export function buildSignalDetectors(
  env: NodeJS.ProcessEnv = process.env,
): SignalDetector[] {
  if (!laneEnabled(env)) return [];
  const detectors: SignalDetector[] = [];

  // G1 injection classifier (ELEAA-791, registered by ELEAA-818) — the model-based
  // prompt-injection tier. Registered whenever the lane is enabled: the default
  // NormalizingRegexClassifier is zero-dependency and needs no provider key, yet it
  // catches the encoded/homoglyph/multilingual bypasses the pure regex misses. Its
  // 0..1 score feeds the pure engine's two wired effects — a standalone
  // prompt_injection advisory finding, and the action gate's escalateOnInjection
  // (an authorized-but-harmful action co-occurring with a high score is HELD). Both
  // detectors share one per-run score cache so a distinct text scores at most once.
  // Fail-open like the rest of the lane: a throwing classifier contributes nothing,
  // never a spurious block. The per-rule "judge" tier (BYO model via /v1) is opted
  // into through config.classifier and layers on top of this offline default.
  detectors.push(
    ...makeInjectionClassifierDetectors(new NormalizingRegexClassifier()),
  );

  // G3 content-moderation — the first (cheapest) detector to validate the lane
  // end-to-end. Only wired when a moderation key is provisioned; otherwise the
  // client factory returns null and moderation simply doesn't run.
  const moderationClient = openAIModerationClientFromEnv(env);
  if (moderationClient) {
    detectors.push(makeContentModerationDetector(moderationClient));
  }

  // G2 groundedness (ELEAA-790) — the RAG faithfulness detector. Registered
  // whenever the lane is enabled: its default judge (lexicalGroundednessJudge) is
  // zero-dependency and needs no provider key. It only ever fires on RESPONSE
  // egress when the caller supplied sourceContext (the matcher gates on
  // direction + source presence), so non-RAG traffic stays inert. The gateway
  // runs this detector on the provider's answer AFTER forwarding (see
  // reviewResponseGroundedness in routes/gateway.ts); on the request pass it is a
  // no-op. Swap in an NLI/faithfulness model by passing a GroundednessJudge here
  // once one is provisioned.
  detectors.push(makeGroundednessDetector());

  return detectors;
}

// Lane options for the gateway: a tight per-detector budget and an onError hook
// that surfaces lane failures/timeouts in the server log without ever throwing on
// the request path (the lane itself is fail-open).
export function gatewaySignalLaneOptions(
  env: NodeJS.ProcessEnv = process.env,
): SignalLaneOptions {
  const raw = Number(env["STEADIO_SIGNAL_LANE_TIMEOUT_MS"]);
  const timeoutMs =
    Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_GATEWAY_TIMEOUT_MS;
  return {
    timeoutMs,
    onError: (detectorType: GuardrailRuleType, err: unknown) => {
      console.warn(`[gateway] signal detector ${detectorType} skipped:`, err);
    },
  };
}

// Test/wiring seam. The gateway calls THIS (not buildSignalDetectors directly) so
// a test can vi.mock this module to inject a synthetic detector and prove the lane
// is invoked by the gateway — without provisioning a real provider key. Production
// resolves to the env-driven registry above.
export function resolveGatewaySignalDetectors(): SignalDetector[] {
  return buildSignalDetectors();
}
