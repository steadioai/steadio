import { describe, it, expect, vi } from "vitest";
import {
  runSignalLane,
  evaluateWithSignals,
  type SignalDetector,
} from "./signal-lane.js";
import type {
  AgentFreeze,
  GuardrailFinding,
  GuardrailRule,
} from "./types.js";

// A minimal rule/detector pair for a synthetic type. We piggyback on the
// content_moderation rule type since it has a matcher, but the detector here
// returns fixed findings so we test the LANE mechanics, not moderation.
const modRule: GuardrailRule = {
  id: "mod",
  type: "content_moderation",
  mode: "block",
  enabled: true,
  description: "test",
};

function fixedDetector(findings: GuardrailFinding[]): SignalDetector {
  return { type: "content_moderation", detect: async () => findings };
}

const sampleFinding: GuardrailFinding = {
  ruleId: "mod",
  ruleType: "content_moderation",
  mode: "block",
  reason: "toxic",
};

describe("A0 signal lane — runSignalLane", () => {
  it("returns [] when there are no detectors", async () => {
    const out = await runSignalLane({ content: "hi" }, [modRule], []);
    expect(out).toEqual([]);
  });

  it("runs the detector for a matching enabled rule", async () => {
    const out = await runSignalLane({ content: "x" }, [modRule], [
      fixedDetector([sampleFinding]),
    ]);
    expect(out).toEqual([sampleFinding]);
  });

  it("does not run a detector for a disabled rule", async () => {
    const detect = vi.fn(async () => [sampleFinding]);
    const out = await runSignalLane(
      { content: "x" },
      [{ ...modRule, enabled: false }],
      [{ type: "content_moderation", detect }],
    );
    expect(detect).not.toHaveBeenCalled();
    expect(out).toEqual([]);
  });

  it("fails open when a detector throws (no finding, no crash)", async () => {
    const onError = vi.fn();
    const out = await runSignalLane(
      { content: "x" },
      [modRule],
      [{ type: "content_moderation", detect: async () => { throw new Error("boom"); } }],
      { onError },
    );
    expect(out).toEqual([]);
    expect(onError).toHaveBeenCalledWith("content_moderation", expect.any(Error));
  });

  it("times out fail-open (stays fast) but emits a visible alert finding (AC2)", async () => {
    const onError = vi.fn();
    const slow: SignalDetector = {
      type: "content_moderation",
      // Never resolves within the budget.
      detect: () => new Promise((r) => setTimeout(() => r([sampleFinding]), 5000)),
    };
    const start = Date.now();
    const out = await runSignalLane({ content: "x" }, [modRule], [slow], {
      timeoutMs: 50,
      onError,
    });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(1000); // returned promptly, did not wait 5s
    // Fail-open: the skip is surfaced as a non-blocking alert, never a block.
    expect(out).toHaveLength(1);
    expect(out[0]?.mode).toBe("alert");
    expect(out[0]?.evidence?.["detectorSkipped"]).toBe(true);
    expect(out[0]?.reason).toMatch(/skipped/);
    // A timeout is reported to onError just like a throw.
    expect(onError).toHaveBeenCalledWith("content_moderation", expect.any(Error));
  });

  it("isolates detectors: one failing does not suppress another that fires", async () => {
    const rules: GuardrailRule[] = [
      { ...modRule, id: "a" },
      { ...modRule, id: "b", type: "prompt_injection" },
    ];
    const good = fixedDetector([sampleFinding]);
    const bad: SignalDetector = {
      type: "prompt_injection",
      detect: async () => { throw new Error("nope"); },
    };
    const out = await runSignalLane({ content: "x" }, rules, [good, bad]);
    expect(out).toEqual([sampleFinding]);
  });
});

describe("A0 signal lane — evaluateWithSignals", () => {
  it("merges lane findings with the sync engine and collapses by severity", async () => {
    // A benign body -> the sync engine allows; the lane adds a block finding, so
    // the merged verdict is block.
    const d = await evaluateWithSignals(
      { content: "hello there" },
      [modRule],
      [fixedDetector([sampleFinding])],
    );
    expect(d.action).toBe("block");
    expect(d.determinedBy?.ruleType).toBe("content_moderation");
  });

  it("returns the sync decision unchanged when the lane finds nothing", async () => {
    const d = await evaluateWithSignals(
      { content: "hello there" },
      [modRule],
      [fixedDetector([])],
    );
    expect(d.action).toBe("allow");
    expect(d.findings).toHaveLength(0);
  });

  it("a timed-out detector proceeds (fail-open) as an alert, never a block (AC2)", async () => {
    const slow: SignalDetector = {
      type: "content_moderation",
      detect: () => new Promise((r) => setTimeout(() => r([sampleFinding]), 5000)),
    };
    const d = await evaluateWithSignals(
      { content: "hello there" },
      [modRule],
      [slow],
      { timeoutMs: 30 },
    );
    // Request proceeds (not blocked) but the skip is visible as an alert verdict.
    expect(d.action).toBe("alert");
    expect(d.determinedBy?.evidence?.["detectorSkipped"]).toBe(true);
  });

  it("a kill-switch freeze wins and short-circuits the lane (no provider call)", async () => {
    const detect = vi.fn(async () => [sampleFinding]);
    const freezes: AgentFreeze[] = [{ actor: "ops", reason: "incident" }];
    const d = await evaluateWithSignals(
      { content: "x", toolCalls: [{ name: "refund" }] },
      [modRule],
      [{ type: "content_moderation", detect }],
      {},
      freezes,
    );
    expect(d.action).toBe("block");
    expect(d.determinedBy?.ruleType).toBe("kill_switch");
    expect(detect).not.toHaveBeenCalled(); // lane skipped -> no wasted provider call
  });
});
