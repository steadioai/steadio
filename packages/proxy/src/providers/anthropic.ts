import type { TokenUsage, ToolCall } from "@steadio/shared";
import { v4 as uuidv4 } from "uuid";

// Parse token usage from Anthropic non-streaming response
export function parseAnthropicUsage(responseBody: unknown): TokenUsage | null {
  if (typeof responseBody !== "object" || responseBody === null) return null;
  const body = responseBody as Record<string, unknown>;
  const usage = body["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: (u["input_tokens"] as number) ?? 0,
    outputTokens: (u["output_tokens"] as number) ?? 0,
    cacheReadTokens: (u["cache_read_input_tokens"] as number | undefined),
    cacheWriteTokens: (u["cache_creation_input_tokens"] as number | undefined),
  };
}

// Parse tool calls from Anthropic response content blocks
export function parseAnthropicToolCalls(responseBody: unknown): ToolCall[] {
  if (typeof responseBody !== "object" || responseBody === null) return [];
  const body = responseBody as Record<string, unknown>;
  const content = body["content"];
  if (!Array.isArray(content)) return [];

  const toolCalls: ToolCall[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b["type"] !== "tool_use") continue;
    toolCalls.push({
      id: (b["id"] as string) ?? uuidv4(),
      name: (b["name"] as string) ?? "unknown",
      arguments: b["input"],
    });
  }
  return toolCalls;
}

// Parse usage from Anthropic SSE stream (message_delta and message_start events carry usage)
export function parseAnthropicStreamUsage(
  accumulatedChunks: string
): TokenUsage | null {
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheWriteTokens: number | undefined;
  let found = false;

  const lines = accumulatedChunks.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    try {
      const event = JSON.parse(data) as Record<string, unknown>;
      const eventType = event["type"];

      if (eventType === "message_start") {
        const message = event["message"] as Record<string, unknown> | undefined;
        const usage = message?.["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          inputTokens = (usage["input_tokens"] as number) ?? 0;
          cacheReadTokens = usage["cache_read_input_tokens"] as number | undefined;
          cacheWriteTokens = usage["cache_creation_input_tokens"] as number | undefined;
          found = true;
        }
      } else if (eventType === "message_delta") {
        const usage = event["usage"] as Record<string, unknown> | undefined;
        if (usage) {
          outputTokens = (usage["output_tokens"] as number) ?? 0;
          found = true;
        }
      }
    } catch {
      // skip
    }
  }

  if (!found) return null;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}
