// Per-agent allowlist config surface (ELEAA-748). withAllowedTools() is the pure
// helper the /v1 gateway uses to fold an agent's allowed_tools into the action
// gate at evaluate() time; these lock its behavior and its interplay with the
// engine + tool ledger.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, withAllowedTools } from "./rules.js";
import { evaluate } from "./engine.js";
import { buildToolLedger } from "./ledger.js";
import type { GuardrailContext } from "./types.js";

const ctxWith = (name: string): GuardrailContext => ({
  agentId: "agent-1",
  identity: "user@acme.test",
  toolCalls: [{ name }],
  direction: "request",
});

describe("withAllowedTools", () => {
  it("returns the rules unchanged (same reference) when the list is empty/absent", () => {
    expect(withAllowedTools(DEFAULT_RULES, [])).toBe(DEFAULT_RULES);
    expect(withAllowedTools(DEFAULT_RULES, undefined)).toBe(DEFAULT_RULES);
    expect(withAllowedTools(DEFAULT_RULES, null)).toBe(DEFAULT_RULES);
  });

  it("injects the allowlist only into the privileged_tool_call gate", () => {
    const rules = withAllowedTools(DEFAULT_RULES, ["search", "kb"]);
    const gate = rules.find((r) => r.type === "privileged_tool_call");
    expect(gate?.config?.allowedTools).toEqual(["search", "kb"]);
    // Every other rule is untouched.
    for (const r of rules) {
      if (r.type !== "privileged_tool_call") {
        expect(r.config?.allowedTools).toBeUndefined();
      }
    }
    // Does not mutate the shared DEFAULT_RULES.
    const src = DEFAULT_RULES.find((r) => r.type === "privileged_tool_call");
    expect(src?.config?.allowedTools).toBeUndefined();
  });

  it("drops non-string / empty entries", () => {
    const rules = withAllowedTools(DEFAULT_RULES, ["ok", "", 42, null] as unknown[]);
    const gate = rules.find((r) => r.type === "privileged_tool_call");
    expect(gate?.config?.allowedTools).toEqual(["ok"]);
  });

  it("blocks a tool not on the agent allowlist and allows one that is", () => {
    const rules = withAllowedTools(DEFAULT_RULES, ["search"]);
    expect(evaluate(ctxWith("delete_database"), rules).action).toBe("block");
    expect(evaluate(ctxWith("search"), rules).action).toBe("allow");
  });

  it("leaves the tool ledger status consistent with the allowlist verdict", () => {
    const rules = withAllowedTools(DEFAULT_RULES, ["search"]);
    const now = "2026-07-08T00:00:00.000Z";

    const blockedCtx = ctxWith("wire_transfer");
    const blocked = buildToolLedger(blockedCtx, evaluate(blockedCtx, rules), { now });
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.resultStatus).toBe("blocked");
    expect(blocked[0]?.identity).toBe("user@acme.test");

    const allowedCtx = ctxWith("search");
    const allowed = buildToolLedger(allowedCtx, evaluate(allowedCtx, rules), { now });
    expect(allowed[0]?.resultStatus).toBe("allowed");
  });
});
