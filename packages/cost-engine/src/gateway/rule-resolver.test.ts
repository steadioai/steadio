/**
 * ELEAA-1373: Rule resolver merge-logic tests.
 *
 * Tests the pure mergeWorkspaceRules function. Verifies:
 * 1. No workspace rows → defaults copied unchanged
 * 2. Override replaces a default rule's mode/config
 * 3. Override can disable a default rule
 * 4. Custom (workspace-only) rules append to the set
 * 5. Empty override config preserves the default's config
 * 6. Override count matches defaults when only overriding (no appends)
 */
import { describe, it, expect } from "vitest";
import { DEFAULT_RULES } from "../guardrails/rules.js";
import { mergeWorkspaceRules, type WorkspaceRuleRow } from "./rule-resolver.js";

describe("mergeWorkspaceRules", () => {
  it("returns a copy of defaults when no workspace rows", () => {
    const rules = mergeWorkspaceRules(DEFAULT_RULES, []);
    expect(rules).toEqual([...DEFAULT_RULES]);
    expect(rules).not.toBe(DEFAULT_RULES);
  });

  it("overrides a default rule's mode and config", () => {
    const overrides: WorkspaceRuleRow[] = [
      {
        ruleId: "pii-egress-throttle",
        ruleType: "pii_egress",
        mode: "block",
        enabled: true,
        config: { patterns: ["\\bSSN\\b"] },
        description: "Block PII instead of throttle",
      },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    const pii = rules.find((r) => r.id === "pii-egress-throttle");
    expect(pii).toBeDefined();
    expect(pii!.mode).toBe("block");
    expect(pii!.config).toEqual({ patterns: ["\\bSSN\\b"] });
    // Other default rules unchanged
    const secretRule = rules.find((r) => r.id === "secret-egress-block");
    expect(secretRule!.mode).toBe("block");
    expect(secretRule!.enabled).toBe(true);
  });

  it("disables a default rule when workspace sets enabled=false", () => {
    const overrides: WorkspaceRuleRow[] = [
      {
        ruleId: "prompt-injection-alert",
        ruleType: "prompt_injection",
        mode: "alert",
        enabled: false,
        config: {},
        description: null,
      },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    const injection = rules.find((r) => r.id === "prompt-injection-alert");
    expect(injection!.enabled).toBe(false);
  });

  it("appends workspace-only rules not in DEFAULT_RULES", () => {
    const overrides: WorkspaceRuleRow[] = [
      {
        ruleId: "custom-compliance-check",
        ruleType: "pii_egress",
        mode: "hold",
        enabled: true,
        config: { patterns: ["\\bHIPAA\\b"] },
        description: "Custom compliance rule",
      },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    expect(rules.length).toBe(DEFAULT_RULES.length + 1);
    const custom = rules.find((r) => r.id === "custom-compliance-check");
    expect(custom).toBeDefined();
    expect(custom!.mode).toBe("hold");
    expect(custom!.type).toBe("pii_egress");
    expect(custom!.description).toBe("Custom compliance rule");
  });

  it("preserves default config when workspace override has empty config", () => {
    const groundednessDefault = DEFAULT_RULES.find((r) => r.id === "groundedness-alert");
    expect(groundednessDefault?.config).toBeDefined();
    const overrides: WorkspaceRuleRow[] = [
      {
        ruleId: "groundedness-alert",
        ruleType: "groundedness",
        mode: "block",
        enabled: true,
        config: {},
        description: null,
      },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    const groundedness = rules.find((r) => r.id === "groundedness-alert");
    expect(groundedness!.mode).toBe("block");
    expect(groundedness!.config).toEqual(groundednessDefault!.config);
  });

  it("total rule count matches DEFAULT_RULES when only overriding", () => {
    const overrides: WorkspaceRuleRow[] = [
      { ruleId: "secret-egress-block", ruleType: "secret_egress", mode: "hold", enabled: true, config: {}, description: null },
      { ruleId: "runaway-loop-block", ruleType: "runaway_loop", mode: "alert", enabled: false, config: { repeatThreshold: 10 }, description: "Relaxed" },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    expect(rules.length).toBe(DEFAULT_RULES.length);
  });

  it("can override AND append in one merge", () => {
    const overrides: WorkspaceRuleRow[] = [
      { ruleId: "pii-egress-throttle", ruleType: "pii_egress", mode: "redact", enabled: true, config: {}, description: "Redact instead" },
      { ruleId: "my-custom-rule", ruleType: "secret_egress", mode: "block", enabled: true, config: { patterns: ["my-secret-*"] }, description: "Custom" },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    expect(rules.length).toBe(DEFAULT_RULES.length + 1);
    const pii = rules.find((r) => r.id === "pii-egress-throttle");
    expect(pii!.mode).toBe("redact");
    const custom = rules.find((r) => r.id === "my-custom-rule");
    expect(custom!.mode).toBe("block");
  });

  it("uses workspace description when provided, falls back to default", () => {
    const overrides: WorkspaceRuleRow[] = [
      { ruleId: "secret-egress-block", ruleType: "secret_egress", mode: "block", enabled: true, config: {}, description: "Custom desc" },
      { ruleId: "pii-egress-throttle", ruleType: "pii_egress", mode: "block", enabled: true, config: {}, description: null },
    ];
    const rules = mergeWorkspaceRules(DEFAULT_RULES, overrides);
    const secret = rules.find((r) => r.id === "secret-egress-block");
    expect(secret!.description).toBe("Custom desc");
    const pii = rules.find((r) => r.id === "pii-egress-throttle");
    const defaultPii = DEFAULT_RULES.find((r) => r.id === "pii-egress-throttle");
    expect(pii!.description).toBe(defaultPii!.description);
  });
});
