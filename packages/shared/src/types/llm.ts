export type LlmProvider = "openai" | "anthropic" | "google";

export type OpenAiModel =
  | "gpt-4o"
  | "gpt-4o-mini"
  | "gpt-4-turbo"
  | "gpt-3.5-turbo"
  | string;

export type AnthropicModel =
  | "claude-opus-4-8"
  | "claude-sonnet-4-6"
  | "claude-haiku-4-5-20251001"
  | "claude-3-5-sonnet-20241022"
  | "claude-3-5-haiku-20241022"
  | string;

export type GoogleModel =
  | "gemini-1.5-pro"
  | "gemini-1.5-flash"
  | "gemini-2.0-flash"
  | string;

export type LlmModel = OpenAiModel | AnthropicModel | GoogleModel;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number | undefined;
  cacheWriteTokens?: number | undefined;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export interface ToolCallResult {
  toolCallId: string;
  name: string;
  result: unknown;
  isError: boolean;
}

export interface ProxyRequestContext {
  provider: LlmProvider;
  model: LlmModel;
  agentId: string;
  teamId: string;
  workflowId: string;
  requestId: string;
  startedAt: Date;
}

export interface ProxyResponseMeta {
  provider: LlmProvider;
  model: LlmModel;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  latencyMs: number;
  streaming: boolean;
}
