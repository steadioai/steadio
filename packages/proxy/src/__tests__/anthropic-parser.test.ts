import { describe, it, expect } from "vitest";
import {
  parseAnthropicUsage,
  parseAnthropicToolCalls,
  parseAnthropicStreamUsage,
} from "../providers/anthropic.js";

describe("parseAnthropicUsage", () => {
  it("extracts token counts", () => {
    const body = {
      id: "msg_123",
      type: "message",
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 200, output_tokens: 80 },
    };
    expect(parseAnthropicUsage(body)).toEqual({
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });

  it("extracts cache token counts", () => {
    const body = {
      usage: {
        input_tokens: 100,
        output_tokens: 40,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 1000,
      },
    };
    const result = parseAnthropicUsage(body);
    expect(result?.cacheReadTokens).toBe(500);
    expect(result?.cacheWriteTokens).toBe(1000);
  });
});

describe("parseAnthropicToolCalls", () => {
  it("extracts tool_use blocks from content", () => {
    const body = {
      content: [
        { type: "text", text: "Let me search that." },
        {
          type: "tool_use",
          id: "toolu_abc",
          name: "search",
          input: { query: "cats" },
        },
      ],
    };
    const result = parseAnthropicToolCalls(body);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("search");
    expect(result[0]!.arguments).toEqual({ query: "cats" });
  });
});

describe("parseAnthropicStreamUsage", () => {
  it("extracts usage from message_start and message_delta events", () => {
    const chunks = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":50}}}',
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":30}}',
    ].join("\n");
    const result = parseAnthropicStreamUsage(chunks);
    expect(result).toEqual({
      inputTokens: 50,
      outputTokens: 30,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    });
  });
});
