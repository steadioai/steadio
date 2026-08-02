// Enforcement verification recipes (VR1–VR3) from ELEAA-1354 enforcement-experience spec.
// VR4 (browser check) requires manual verification — see PR description.

import { describe, expect, it } from "vitest";
import { DEFAULT_RULES, withGuardrailConfig } from "./rules.js";
import { evaluate } from "./engine.js";
import type { GuardrailContext } from "./types.js";

const ctxWith = (name: string): GuardrailContext => ({
  agentId: "agent-1",
  identity: "user@acme.test",
  toolCalls: [{ name }],
  direction: "request",
});

describe("VR1 — Entitlement-safe default", () => {
  it("withGuardrailConfig with monitor mode returns rules unchanged when no allowlist", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, [], "monitor");
    expect(rules).toBe(DEFAULT_RULES);
  });

  it("withGuardrailConfig with monitor mode and allowlist emits would_block findings, not blocks", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search"], "monitor");
    const result = evaluate(ctxWith("delete_database"), rules);
    expect(result.action).toBe("alert");
    const finding = result.findings[0];
    expect(finding?.mode).toBe("alert");
    expect((finding?.evidence as Record<string, unknown>)?.["would_block"]).toBe(true);
  });

  it("allowed tool passes cleanly in monitor mode", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search"], "monitor");
    expect(evaluate(ctxWith("search"), rules).action).toBe("allow");
  });
});

describe("VR2 — Freeze is inline and reversible", () => {
  it("frozen agent blocks all tools", () => {
    const result = evaluate(ctxWith("search"), DEFAULT_RULES, [
      { reason: "Emergency freeze", actor: "admin" },
    ]);
    expect(result.action).toBe("block");
    expect(result.findings[0]?.ruleType).toBe("kill_switch");
  });

  it("unfrozen agent (no freezes) allows tools normally", () => {
    const result = evaluate(ctxWith("search"), DEFAULT_RULES, []);
    expect(result.action).toBe("allow");
  });
});

describe("VR3 — Allowlist blocks only disallowed tools (4-call matrix)", () => {
  it("monitor + allowed tool → allow", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search", "read_file"], "monitor");
    expect(evaluate(ctxWith("search"), rules).action).toBe("allow");
  });

  it("monitor + disallowed tool → alert with would_block", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search", "read_file"], "monitor");
    const result = evaluate(ctxWith("rm_rf"), rules);
    expect(result.action).toBe("alert");
    expect(result.findings[0]?.mode).toBe("alert");
    expect((result.findings[0]?.evidence as Record<string, unknown>)?.["would_block"]).toBe(true);
  });

  it("block + allowed tool → allow", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search", "read_file"], "block");
    expect(evaluate(ctxWith("search"), rules).action).toBe("allow");
  });

  it("block + disallowed tool → block", () => {
    const rules = withGuardrailConfig(DEFAULT_RULES, ["search", "read_file"], "block");
    const result = evaluate(ctxWith("rm_rf"), rules);
    expect(result.action).toBe("block");
    expect(result.findings[0]?.mode).toBe("block");
    expect((result.findings[0]?.evidence as Record<string, unknown>)?.["would_block"]).toBeUndefined();
  });
});
