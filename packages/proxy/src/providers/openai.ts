import type { Context } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { TokenUsage, ToolCall } from "@elevation/shared";

const OPENAI_BASE = "https://api.openai.com";

export async function proxyOpenAi(
  c: Context,
  upstreamBaseUrl: string
): Promise<Response> {
  const url = new URL(c.req.url);
  // Strip the /openai prefix we add, forward the rest
  const upstreamPath = url.pathname.replace(/^\/openai/, "") + url.search;
  const upstreamUrl = `${upstreamBaseUrl}${upstreamPath}`;

  // Forward all headers except our custom ones
  const headers = new Headers();
  for (const [key, value] of Object.entries(c.req.header())) {
    if (!key.toLowerCase().startsWith("x-elevation") && key.toLowerCase() !== "x-agent-id" && key.toLowerCase() !== "x-team-id" && key.toLowerCase() !== "x-workflow-id") {
      headers.set(key, value);
    }
  }
  headers.set("host", new URL(upstreamBaseUrl).host);

  const body = c.req.raw.body;

  const upstream = await fetch(upstreamUrl, {
    method: c.req.method,
    headers,
    body,
    // @ts-ignore - duplex needed for streaming
    duplex: "half",
  });

  return upstream;
}

// Parse token usage from OpenAI non-streaming response
export function parseOpenAiUsage(responseBody: unknown): TokenUsage | null {
  if (typeof responseBody !== "object" || responseBody === null) return null;
  const body = responseBody as Record<string, unknown>;
  const usage = body["usage"];
  if (typeof usage !== "object" || usage === null) return null;
  const u = usage as Record<string, unknown>;
  return {
    inputTokens: (u["prompt_tokens"] as number) ?? 0,
    outputTokens: (u["completion_tokens"] as number) ?? 0,
  };
}

// Parse tool calls from OpenAI response choices
export function parseOpenAiToolCalls(responseBody: unknown): ToolCall[] {
  if (typeof responseBody !== "object" || responseBody === null) return [];
  const body = responseBody as Record<string, unknown>;
  const choices = body["choices"];
  if (!Array.isArray(choices)) return [];

  const toolCalls: ToolCall[] = [];
  for (const choice of choices) {
    if (typeof choice !== "object" || choice === null) continue;
    const c = choice as Record<string, unknown>;
    const message = c["message"];
    if (typeof message !== "object" || message === null) continue;
    const m = message as Record<string, unknown>;
    const calls = m["tool_calls"];
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      if (typeof call !== "object" || call === null) continue;
      const tc = call as Record<string, unknown>;
      const fn = tc["function"];
      if (typeof fn !== "object" || fn === null) continue;
      const f = fn as Record<string, unknown>;
      toolCalls.push({
        id: (tc["id"] as string) ?? uuidv4(),
        name: (f["name"] as string) ?? "unknown",
        arguments: typeof f["arguments"] === "string"
          ? (() => { try { return JSON.parse(f["arguments"] as string); } catch { return f["arguments"]; } })()
          : f["arguments"],
      });
    }
  }
  return toolCalls;
}

// Parse token usage from OpenAI SSE stream (accumulates usage chunk)
export function parseOpenAiStreamUsage(chunk: string): TokenUsage | null {
  const lines = chunk.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data) as Record<string, unknown>;
      const usage = parsed["usage"];
      if (typeof usage === "object" && usage !== null) {
        const u = usage as Record<string, unknown>;
        if (u["prompt_tokens"] !== undefined) {
          return {
            inputTokens: (u["prompt_tokens"] as number) ?? 0,
            outputTokens: (u["completion_tokens"] as number) ?? 0,
          };
        }
      }
    } catch {
      // not JSON, skip
    }
  }
  return null;
}
