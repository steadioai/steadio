import { describe, it, expect } from "vitest";
import { evaluate } from "./engine.js";
import { evaluateWithSignals } from "./signal-lane.js";
import {
  makeContentModerationDetector,
  HeuristicModerationClient,
} from "./content-moderation.js";
import { DEFAULT_RULES } from "./rules.js";
import type { GuardrailContext } from "./types.js";

// ELEAA-787 acceptance-#3: the added p50 latency of ONE enabled detector on the
// signal lane must be < 200ms. This runs a real detector (the offline heuristic
// moderation client — no network, deterministic) so CI measures the LANE's own
// overhead, not a provider's RTT. The 200ms budget is the inline /v1 hot-path
// ceiling from the spec ("added detector latency < 200ms p50").

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

describe("A0 signal lane — latency budget (ELEAA-787 AC3)", () => {
  it("adds < 200ms p50 for one enabled detector", async () => {
    const detector = makeContentModerationDetector(
      new HeuristicModerationClient(),
    );
    const ctx: GuardrailContext = {
      direction: "request",
      content:
        "Please summarize this benign support ticket about a billing question.",
    };

    const ITER = 40;
    const WARMUP = 5;
    const added: number[] = [];

    for (let i = 0; i < ITER + WARMUP; i++) {
      // Baseline: the pure synchronous engine.
      const b0 = performance.now();
      evaluate(ctx, DEFAULT_RULES);
      const baseline = performance.now() - b0;

      // With the async lane running one real detector.
      const w0 = performance.now();
      await evaluateWithSignals(ctx, DEFAULT_RULES, [detector]);
      const withLane = performance.now() - w0;

      if (i >= WARMUP) added.push(Math.max(0, withLane - baseline));
    }

    const p50 = median(added);
    // Loud enough to see the actual number in CI output.
    console.log(
      `[bench] signal-lane added latency p50=${p50.toFixed(2)}ms over ${ITER} iters`,
    );
    expect(p50).toBeLessThan(200);
  });
});
