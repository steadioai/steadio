import type { TokenUsage, ToolCall, LlmProvider } from "@elevation/shared";

export interface ProxyEvent {
  requestId: string;
  provider: LlmProvider;
  model: string;
  agentId: string;
  teamId: string;
  keyId: string;
  workflowId: string | null;
  usage: TokenUsage;
  toolCalls: ToolCall[];
  latencyMs: number;
  streaming: boolean;
  statusCode: number;
  /** SHA-256 of the request messages content, used for loop signature detection */
  promptHash?: string;
}

// Fire-and-forget POST to cost-engine: never throws, never blocks the response path
export async function emitProxyEvent(
  costEngineUrl: string,
  event: ProxyEvent
): Promise<void> {
  fetch(`${costEngineUrl}/internal/proxy-events`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch((err: unknown) => {
    console.error("[emit] failed to send proxy event:", err);
  });
}
