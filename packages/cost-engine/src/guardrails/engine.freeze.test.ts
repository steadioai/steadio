import { describe, it, expect } from "vitest";
import { evaluate, matchFreeze, freezeFinding } from "./engine.js";
import type { AgentFreeze, GuardrailContext } from "./types.js";

// Kill-switch / runtime circuit breaker (ELEAA-747). The pure engine treats a
// matching operator freeze as the highest-severity verdict, above every rule.

const benign: GuardrailContext = {
  direction: "request",
  content: "What is the weather in Paris?",
};

// A refund $1000 over the $500 policy cap — DEFAULT_RULES holds this for review.
const overCapRefund: GuardrailContext = {
  direction: "request",
  toolCalls: [{ name: "refund", arguments: { amount: 1000 } }],
};

describe("matchFreeze", () => {
  it("returns null when there are no freezes", () => {
    expect(matchFreeze(undefined, benign)).toBeNull();
    expect(matchFreeze([], benign)).toBeNull();
  });

  it("applies a whole-agent freeze to any request", () => {
    const freezes: AgentFreeze[] = [{ toolName: null, reason: "runaway" }];
    expect(matchFreeze(freezes, benign)).toEqual(freezes[0]);
  });

  it("applies a per-tool freeze only when that tool is being called", () => {
    const freezes: AgentFreeze[] = [{ toolName: "refund" }];
    // A request that calls refund is frozen…
    expect(
      matchFreeze(freezes, {
        toolCalls: [{ name: "refund", arguments: { amount: 5 } }],
      }),
    ).toEqual(freezes[0]);
    // …but a request that calls a different tool is not.
    expect(
      matchFreeze(freezes, { toolCalls: [{ name: "search", arguments: {} }] }),
    ).toBeNull();
    // …and a request with no tool calls is not.
    expect(matchFreeze(freezes, benign)).toBeNull();
  });

  it("matches tool names case-insensitively", () => {
    const freezes: AgentFreeze[] = [{ toolName: "Refund" }];
    expect(
      matchFreeze(freezes, { toolCalls: [{ name: "REFUND", arguments: {} }] }),
    ).toEqual(freezes[0]);
  });

  it("prefers a whole-agent freeze over a per-tool freeze", () => {
    const whole: AgentFreeze = { toolName: null, reason: "all stop" };
    const perTool: AgentFreeze = { toolName: "refund" };
    expect(
      matchFreeze([perTool, whole], {
        toolCalls: [{ name: "refund", arguments: {} }],
      }),
    ).toEqual(whole);
  });
});

describe("evaluate with a freeze", () => {
  it("blocks a benign request when the whole agent is frozen", () => {
    const d = evaluate(benign, undefined, [{ toolName: null, actor: "u-1", reason: "runaway" }]);
    expect(d.action).toBe("block");
    expect(d.determinedBy?.ruleType).toBe("kill_switch");
    expect(d.determinedBy?.ruleId).toBe("kill_switch");
    expect(d.determinedBy?.reason).toContain("u-1");
    expect(d.determinedBy?.reason).toContain("runaway");
    expect(d.determinedBy?.evidence?.["killSwitch"]).toBe(true);
  });

  it("does not block when there is no freeze (benign stays allow)", () => {
    expect(evaluate(benign).action).toBe("allow");
    expect(evaluate(benign, undefined, []).action).toBe("allow");
  });

  it("overrides a lower-severity hold — freeze wins", () => {
    // Baseline: an over-cap refund is held for human review.
    expect(evaluate(overCapRefund).action).toBe("hold");
    // With the agent frozen, the same request is a hard block by the kill-switch.
    const d = evaluate(overCapRefund, undefined, [{ toolName: null }]);
    expect(d.action).toBe("block");
    expect(d.determinedBy?.ruleType).toBe("kill_switch");
  });

  it("per-tool freeze blocks only the frozen tool; other tools evaluate normally", () => {
    // "refund" frozen, and the request calls refund → block by kill-switch.
    const blocked = evaluate(
      { toolCalls: [{ name: "refund", arguments: { amount: 5 } }] },
      undefined,
      [{ toolName: "refund" }],
    );
    expect(blocked.action).toBe("block");
    expect(blocked.determinedBy?.ruleType).toBe("kill_switch");

    // The same freeze, but the request calls a different (benign) tool → allow.
    const allowed = evaluate(
      { toolCalls: [{ name: "search", arguments: {} }] },
      undefined,
      [{ toolName: "refund" }],
    );
    expect(allowed.action).toBe("allow");
  });
});

describe("freezeFinding", () => {
  it("labels an agent-wide freeze and carries actor/reason", () => {
    const f = freezeFinding({ toolName: null, actor: "op-9", reason: "spending spike" });
    expect(f.mode).toBe("block");
    expect(f.reason).toContain("agent frozen");
    expect(f.evidence?.["scope"]).toBe("agent");
    expect(f.evidence?.["actor"]).toBe("op-9");
  });

  it("labels a per-tool freeze with the tool name", () => {
    const f = freezeFinding({ toolName: "wire_transfer" });
    expect(f.reason).toContain('tool "wire_transfer"');
    expect(f.evidence?.["scope"]).toBe("tool");
    expect(f.evidence?.["toolName"]).toBe("wire_transfer");
  });
});
