// Extracts tool calls from OpenAI and Anthropic request/response payloads

export interface CapturedToolCall {
  toolName: string;
  parameters: Record<string, unknown>;
  callId?: string | undefined;
}

// Extract tool calls from an OpenAI chat completions request body
export function extractToolCallsFromOpenAIRequest(
  body: Record<string, unknown>,
): CapturedToolCall[] {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return [];

  const calls: CapturedToolCall[] = [];

  for (const msg of messages) {
    if (
      msg &&
      typeof msg === "object" &&
      "role" in msg &&
      msg["role"] === "tool" &&
      "tool_call_id" in msg
    ) {
      // Tool result message — skip (result, not call)
      continue;
    }

    if (
      msg &&
      typeof msg === "object" &&
      "tool_calls" in msg &&
      Array.isArray(msg["tool_calls"])
    ) {
      for (const tc of msg["tool_calls"] as unknown[]) {
        if (tc && typeof tc === "object" && "function" in tc) {
          const fn = (tc as { function?: { name?: string; arguments?: string }; id?: string })["function"];
          if (fn?.name) {
            let params: Record<string, unknown> = {};
            try {
              params = JSON.parse(fn.arguments ?? "{}") as Record<string, unknown>;
            } catch {
              params = { _raw: fn.arguments };
            }
            const callId = (tc as { id?: string })["id"];
            calls.push({
              toolName: fn.name,
              parameters: params,
              ...(callId !== undefined ? { callId } : {}),
            });
          }
        }
      }
    }
  }

  return calls;
}

// Extract tool calls from an OpenAI streaming chunk (delta)
export function extractToolCallsFromOpenAIDelta(
  delta: Record<string, unknown>,
): Partial<CapturedToolCall>[] {
  const toolCalls = delta["tool_calls"];
  if (!Array.isArray(toolCalls)) return [];

  return toolCalls.flatMap((tc: unknown) => {
    if (!tc || typeof tc !== "object") return [];
    const fn = (tc as { function?: { name?: string; arguments?: string }; id?: string })["function"];
    if (!fn?.name) return [];
    let params: Record<string, unknown> = {};
    try {
      params = JSON.parse(fn.arguments ?? "{}") as Record<string, unknown>;
    } catch {
      params = { _raw: fn.arguments };
    }
    return [{ toolName: fn.name, parameters: params }];
  });
}

// Extract tool calls from an Anthropic request body
export function extractToolCallsFromAnthropicRequest(
  body: Record<string, unknown>,
): CapturedToolCall[] {
  const messages = body["messages"];
  if (!Array.isArray(messages)) return [];

  const calls: CapturedToolCall[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const content = (msg as { content?: unknown })["content"];
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: string })["type"] === "tool_use"
      ) {
        const b = block as { name?: string; input?: Record<string, unknown>; id?: string };
        if (b.name) {
          calls.push({
            toolName: b.name,
            parameters: b.input ?? {},
            ...(b.id !== undefined ? { callId: b.id } : {}),
          });
        }
      }
    }
  }

  return calls;
}

// Extract tool calls from an Anthropic streaming content block delta
export function extractToolCallsFromAnthropicDelta(
  contentBlock: Record<string, unknown>,
): CapturedToolCall[] {
  if (contentBlock["type"] !== "tool_use") return [];
  const name = contentBlock["name"] as string | undefined;
  if (!name) return [];

  let params: Record<string, unknown> = {};
  const input = contentBlock["input"];
  if (input && typeof input === "object") {
    params = input as Record<string, unknown>;
  } else if (typeof input === "string") {
    try {
      params = JSON.parse(input) as Record<string, unknown>;
    } catch {
      params = { _raw: input };
    }
  }

  return [{ toolName: name, parameters: params }];
}
