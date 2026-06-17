import type { TokenUsage, ToolCall, LlmProvider } from "@elevation/shared";

export interface ProxyEvent {
  requestId: string;
  provider: LlmProvider;
  model: string;
  agentId: string;
  teamId: string;
  workflowId: string | null;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  latencyMs: number;
  streaming: boolean;
  statusCode: number;
}
