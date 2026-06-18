import type { ModelPricing } from "./types/cost.js";

// Pricing per 1k tokens in USD — update as providers change rates
export const MODEL_PRICING: ModelPricing[] = [
  // OpenAI
  {
    provider: "openai",
    model: "gpt-4o",
    inputCostPer1kTokens: 0.0025,
    outputCostPer1kTokens: 0.01,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "openai",
    model: "gpt-4o-mini",
    inputCostPer1kTokens: 0.00015,
    outputCostPer1kTokens: 0.0006,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "openai",
    model: "gpt-4-turbo",
    inputCostPer1kTokens: 0.01,
    outputCostPer1kTokens: 0.03,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "openai",
    model: "gpt-3.5-turbo",
    inputCostPer1kTokens: 0.0005,
    outputCostPer1kTokens: 0.0015,
    updatedAt: new Date("2025-01-01"),
  },
  // Anthropic
  {
    provider: "anthropic",
    model: "claude-opus-4-8",
    inputCostPer1kTokens: 0.015,
    outputCostPer1kTokens: 0.075,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputCostPer1kTokens: 0.003,
    outputCostPer1kTokens: 0.015,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    inputCostPer1kTokens: 0.0008,
    outputCostPer1kTokens: 0.004,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "anthropic",
    model: "claude-3-5-sonnet-20241022",
    inputCostPer1kTokens: 0.003,
    outputCostPer1kTokens: 0.015,
    cacheReadCostPer1kTokens: 0.0003,
    cacheWriteCostPer1kTokens: 0.00375,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "anthropic",
    model: "claude-3-5-haiku-20241022",
    inputCostPer1kTokens: 0.0008,
    outputCostPer1kTokens: 0.004,
    cacheReadCostPer1kTokens: 0.00008,
    cacheWriteCostPer1kTokens: 0.001,
    updatedAt: new Date("2025-01-01"),
  },
  // Google
  {
    provider: "google",
    model: "gemini-1.5-pro",
    inputCostPer1kTokens: 0.00125,
    outputCostPer1kTokens: 0.005,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "google",
    model: "gemini-1.5-flash",
    inputCostPer1kTokens: 0.000075,
    outputCostPer1kTokens: 0.0003,
    updatedAt: new Date("2025-01-01"),
  },
  {
    provider: "google",
    model: "gemini-2.0-flash",
    inputCostPer1kTokens: 0.0001,
    outputCostPer1kTokens: 0.0004,
    updatedAt: new Date("2025-01-01"),
  },
];

const pricingMap = new Map(
  MODEL_PRICING.map((p) => [`${p.provider}:${p.model}`, p])
);

export function getPricing(
  provider: string,
  model: string
): ModelPricing | undefined {
  // Exact match first
  const exact = pricingMap.get(`${provider}:${model}`);
  if (exact) return exact;

  // Prefix match for versioned model names (e.g. gpt-4o-2024-08-06 → gpt-4o)
  for (const [key, pricing] of pricingMap) {
    if (key.startsWith(`${provider}:`) && model.startsWith(pricing.model)) {
      return pricing;
    }
  }

  return undefined;
}

export function calculateCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalCostUsd: number;
} {
  const pricing = getPricing(provider, model);
  if (!pricing) {
    // Unknown model — return zero cost rather than throw
    return {
      inputCostUsd: 0,
      outputCostUsd: 0,
      cacheReadCostUsd: 0,
      cacheWriteCostUsd: 0,
      totalCostUsd: 0,
    };
  }

  const inputCostUsd = (inputTokens / 1000) * pricing.inputCostPer1kTokens;
  const outputCostUsd = (outputTokens / 1000) * pricing.outputCostPer1kTokens;
  const cacheReadCostUsd =
    (cacheReadTokens / 1000) * (pricing.cacheReadCostPer1kTokens ?? 0);
  const cacheWriteCostUsd =
    (cacheWriteTokens / 1000) * (pricing.cacheWriteCostPer1kTokens ?? 0);

  return {
    inputCostUsd,
    outputCostUsd,
    cacheReadCostUsd,
    cacheWriteCostUsd,
    totalCostUsd:
      inputCostUsd + outputCostUsd + cacheReadCostUsd + cacheWriteCostUsd,
  };
}
