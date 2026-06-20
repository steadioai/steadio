import type { LlmProvider, LlmModel, TokenUsage } from "./llm.js";

export interface ModelPricing {
  provider: LlmProvider;
  model: LlmModel;
  inputCostPer1kTokens: number; // USD
  outputCostPer1kTokens: number; // USD
  cacheReadCostPer1kTokens?: number | undefined;
  cacheWriteCostPer1kTokens?: number | undefined;
  updatedAt: Date;
}

export interface CostBreakdown {
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWriteCostUsd: number;
  totalCostUsd: number;
}

export interface CostEvent {
  id: string;
  agentId: string;
  teamId: string;
  workflowId: string | null;
  provider: LlmProvider;
  model: LlmModel;
  usage: TokenUsage;
  cost: CostBreakdown;
  requestId: string;
  latencyMs: number;
  toolCallCount: number;
  streaming: boolean;
  recordedAt: Date;
}

export interface CostSummary {
  agentId: string;
  teamId: string;
  period: "1d" | "7d" | "30d" | "custom";
  fromAt: Date;
  toAt: Date;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  requestCount: number;
  avgCostPerRequest: number;
  topModels: Array<{ model: LlmModel; costUsd: number; requestCount: number }>;
}
