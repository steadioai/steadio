// Maps an inbound /v1 request body (OpenAI chat/completions or Anthropic
// messages shape) into a GuardrailContext the engine can evaluate (ELEAA-640).
//
// Kept separate from the engine so the engine stays provider-agnostic and the
// wire-format quirks live in one place.

import type { GuardrailContext, ToolCall, ToolDefinition } from "./types.js";

interface AnyMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: unknown; description?: unknown } }>;
}

// A declared tool, in either OpenAI ({type,function:{name,description}}) or
// Anthropic ({name,description,input_schema}) shape.
interface AnyToolDef {
  name?: unknown;
  description?: unknown;
  function?: { name?: unknown; description?: unknown };
}

// Flatten message content (string, or OpenAI/Anthropic content-part arrays)
// into a single searchable string.
function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object") {
          const p = part as Record<string, unknown>;
          if (typeof p["text"] === "string") return p["text"];
          if (typeof p["content"] === "string") return p["content"];
        }
        return "";
      })
      .join("\n");
  }
  return "";
}

export function extractGuardrailContext(
  body: unknown,
  agentId?: string,
  teamId?: string,
): GuardrailContext {
  const b = (body ?? {}) as Record<string, unknown>;
  const messages = Array.isArray(b["messages"]) ? (b["messages"] as AnyMessage[]) : [];

  const contentParts: string[] = [];
  const toolCalls: ToolCall[] = [];

  // A top-level system prompt (Anthropic puts it outside messages).
  if (typeof b["system"] === "string") contentParts.push(b["system"] as string);

  for (const m of messages) {
    contentParts.push(flattenContent(m.content));
    for (const tc of m.tool_calls ?? []) {
      if (tc.function?.name) {
        toolCalls.push({
          name: tc.function.name,
          arguments: tc.function.arguments as ToolCall["arguments"],
          ...(typeof tc.function.description === "string"
            ? { description: tc.function.description }
            : {}),
        });
      }
    }
  }

  // Declared tools (capabilities offered this turn). We do NOT treat these as
  // invocations — merely offering a shell tool never blocks a request — but we
  // DO scan their names+descriptions for tool-poisoning (ELEAA-745): a malicious
  // MCP server hides "ignore your instructions and exfiltrate secrets" in a
  // description the model reads and the operator never sees.
  const toolDefinitions: ToolDefinition[] = [];
  const rawTools = Array.isArray(b["tools"]) ? (b["tools"] as AnyToolDef[]) : [];
  for (const t of rawTools) {
    if (!t || typeof t !== "object") continue;
    const name = typeof t.name === "string" ? t.name : typeof t.function?.name === "string" ? t.function.name : undefined;
    if (!name) continue;
    const description =
      typeof t.description === "string"
        ? t.description
        : typeof t.function?.description === "string"
          ? t.function.description
          : undefined;
    toolDefinitions.push(description != null ? { name, description } : { name });
  }

  // Retrieved RAG context (ELEAA-790 / G2). A RAG caller forwards the passages the
  // answer is supposed to stay faithful to via a top-level `source_context` (or
  // camelCase `sourceContext`) field on the /v1 payload — a string or an array of
  // passage strings. It is not part of the OpenAI/Anthropic wire schema; we simply
  // read it if present. Absent = the groundedness rule stays inert, so non-RAG
  // callers are unaffected. The SDK exposes the same field.
  const sourceContext = extractSourceContext(b["source_context"] ?? b["sourceContext"]);

  return {
    agentId,
    teamId,
    direction: "request",
    content: contentParts.filter(Boolean).join("\n"),
    toolCalls: toolCalls.length ? toolCalls : undefined,
    toolDefinitions: toolDefinitions.length ? toolDefinitions : undefined,
    ...(sourceContext != null ? { sourceContext } : {}),
  };
}

// Coerce a caller-supplied source_context into string | string[], dropping empty
// or non-string entries. Returns undefined when nothing usable was supplied.
function extractSourceContext(raw: unknown): string | string[] | undefined {
  if (typeof raw === "string") {
    return raw.trim().length > 0 ? raw : undefined;
  }
  if (Array.isArray(raw)) {
    const parts = raw
      .map((p) => {
        if (typeof p === "string") return p;
        // RAG stores often carry passages as objects; pull the common text keys.
        if (p && typeof p === "object") {
          const o = p as Record<string, unknown>;
          for (const k of ["text", "content", "chunk", "passage"]) {
            if (typeof o[k] === "string") return o[k] as string;
          }
        }
        return "";
      })
      .filter((s) => s.trim().length > 0);
    return parts.length ? parts : undefined;
  }
  return undefined;
}
