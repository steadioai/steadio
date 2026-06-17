import { describe, it, expect } from "vitest";
import { computeCost } from "../services/cost-calculator.js";

describe("computeCost", () => {
  it("calculates GPT-4o cost correctly", () => {
    const result = computeCost("openai", "gpt-4o", 1000, 500);
    // input: 1000 * 0.0025/1000 = 0.0025
    // output: 500 * 0.01/1000 = 0.005
    expect(result.inputCostUsd).toBeCloseTo(0.0025, 6);
    expect(result.outputCostUsd).toBeCloseTo(0.005, 6);
    expect(result.totalCostUsd).toBeCloseTo(0.0075, 6);
  });

  it("calculates Claude Sonnet cost correctly", () => {
    const result = computeCost("anthropic", "claude-sonnet-4-6", 2000, 1000);
    // input: 2000 * 0.003/1000 = 0.006
    // output: 1000 * 0.015/1000 = 0.015
    expect(result.inputCostUsd).toBeCloseTo(0.006, 6);
    expect(result.outputCostUsd).toBeCloseTo(0.015, 6);
    expect(result.totalCostUsd).toBeCloseTo(0.021, 6);
  });

  it("calculates Anthropic cache cost correctly", () => {
    const result = computeCost(
      "anthropic",
      "claude-3-5-sonnet-20241022",
      100,
      50,
      1000,
      200
    );
    // cache read: 1000 * 0.0003/1000 = 0.0003
    // cache write: 200 * 0.00375/1000 = 0.00075
    expect(result.cacheReadCostUsd).toBeCloseTo(0.0003, 6);
    expect(result.cacheWriteCostUsd).toBeCloseTo(0.00075, 6);
  });

  it("returns zero cost for unknown model", () => {
    const result = computeCost("unknown-provider", "unknown-model", 1000, 500);
    expect(result.totalCostUsd).toBe(0);
  });

  it("handles zero tokens", () => {
    const result = computeCost("openai", "gpt-4o", 0, 0);
    expect(result.totalCostUsd).toBe(0);
  });

  it("matches versioned model names by prefix", () => {
    const result = computeCost("openai", "gpt-4o-2024-08-06", 1000, 0);
    expect(result.inputCostUsd).toBeCloseTo(0.0025, 6);
  });
});
