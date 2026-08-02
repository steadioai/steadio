import { describe, it, expect } from "vitest";
import { ATTACK_PACK, runReliabilityCheck, unprotectedExposure } from "./attack-pack.js";
import { DEFAULT_RULES } from "./rules.js";

describe("reliability check attack pack", () => {
  it("every case runs through the real engine and meets its expectation", () => {
    // This is the load-bearing guarantee: the curated pack is honest — the
    // default rule set actually catches every attack and lets every control
    // through. A regression in either the pack or the engine trips here.
    const report = runReliabilityCheck(DEFAULT_RULES);
    const failed = report.results.filter((r) => !r.passed);
    expect(
      failed.map((r) => `${r.case.id} → ${r.decision.action} (expected ${r.case.expect})`),
    ).toEqual([]);
  });

  it("scores 100 / A with zero false positives on the default rule set", () => {
    const report = runReliabilityCheck(DEFAULT_RULES);
    expect(report.score).toBe(100);
    expect(report.grade).toBe("A");
    expect(report.attacksCaught).toBe(report.attacksTotal);
    expect(report.falsePositives).toBe(0);
    expect(report.controlsTotal).toBeGreaterThanOrEqual(3);
  });

  it("covers all five rule types with at least one attack each", () => {
    const cats = new Set(
      ATTACK_PACK.filter((c) => c.kind === "attack").map((c) => c.category),
    );
    expect(cats).toEqual(
      new Set([
        "privileged_tool_call",
        "secret_egress",
        "pii_egress",
        "runaway_loop",
        "prompt_injection",
      ]),
    );
  });

  it("reports full exposure with no guardrails — the contrast that gives the score meaning", () => {
    const attacks = ATTACK_PACK.filter((c) => c.kind === "attack").length;
    // Unprotected, every single attack lands on the customer.
    expect(unprotectedExposure()).toBe(attacks);
    // And a no-rules run catches nothing.
    const bare = runReliabilityCheck([]);
    expect(bare.attacksCaught).toBe(0);
    expect(bare.score).toBe(0);
    expect(bare.grade).toBe("F");
  });

  it("has stable unique ids", () => {
    const ids = ATTACK_PACK.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
