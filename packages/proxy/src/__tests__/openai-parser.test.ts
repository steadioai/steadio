import { describe, it, expect } from "vitest";
import {
  parseOpenAiUsage,
  parseOpenAiToolCalls,
  parseOpenAiStreamUsage,
} from "../providers/openai.js";

describe("parseOpenAiUsage", () => {
  it("extracts token counts from a completion response", () => {
    const body = {
      id: "chatcmpl-123",
      object: "chat.completion",
      model: "gpt-4o",
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      choices: [],
    };
    const result = parseOpenAiUsage(body);
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50 });
  });

  it("returns null when usage is absent", () => {
    expect(parseOpenAiUsage({ id: "123", choices: [] })).toBeNull();
  });

  it("returns null for non-object input", () => {
    expect(parseOpenAiUsage("not-an-object")).toBeNull();
    expect(parseOpenAiUsage(null)).toBeNull();
  });
});

describe("parseOpenAiToolCalls", () => {
  it("extracts tool calls from choices", () => {
    const body = {
      choices: [
        {
          message: {
            role: "assistant",
            tool_calls: [
              {
                id: "call_abc",
                type: "function",
                function: { name: "search_web", arguments: '{"query":"hello"}' },
              },
            ],
          },
        },
      ],
    };
    const result = parseOpenAiToolCalls(body);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search_web");
    expect(result[0]!.arguments).toEqual({ query: "hello" });
  });

  it("returns empty array when no tool calls", () => {
    const body = { choices: [{ message: { role: "assistant", content: "hello" } }] };
    expect(parseOpenAiToolCalls(body)).toEqual([]);
  });
});

describe("parseOpenAiStreamUsage", () => {
  it("extracts usage from final SSE chunk with stream_options", () => {
    const chunk = [
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
      "data: [DONE]",
    ].join("\n");
    const result = parseOpenAiStreamUsage(chunk);
    expect(result).toEqual({ inputTokens: 10, outputTokens: 5 });
  });

  it("returns null when no usage in stream", () => {
    const chunk = 'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\ndata: [DONE]';
    expect(parseOpenAiStreamUsage(chunk)).toBeNull();
  });
});
