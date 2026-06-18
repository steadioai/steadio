import { calculateCost } from "@elevation/shared";
import type { CostBreakdown } from "@elevation/shared";

export function computeCost(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens = 0,
  cacheWriteTokens = 0
): CostBreakdown {
  return calculateCost(
    provider,
    model,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens
  );
}
