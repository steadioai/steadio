import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "node:crypto";
import {
  parseAnthropicUsage,
  parseAnthropicToolCalls,
  parseAnthropicStreamUsage,
} from "../providers/anthropic.js";
import { emitProxyEvent } from "../emit.js";
import type { Redis } from "ioredis";
import type { ToolCall } from "@steadio/shared";
import type { ProxyEnv } from "../env.js";

function hashMessages(body: string | undefined): string | undefined {
  if (!body) return undefined;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const content: Record<string, unknown> = {};
    if (parsed["messages"]) content.messages = parsed["messages"];
    if (parsed["system"]) content.system = parsed["system"];
    if (Object.keys(content).length === 0) return undefined;
    return createHash("sha256").update(JSON.stringify(content)).digest("hex");
  } catch {
    return undefined;
  }
}

interface ProxyDeps {
  anthropicApiUrl: string;
  costEngineUrl: string;
  redis: Redis;
}

export function createAnthropicRouter(deps: ProxyDeps) {
  const app = new Hono<ProxyEnv>();

  app.all("/*", async (c) => {
    const requestId = uuidv4();
    const startMs = Date.now();

    const agentId: string = c.get("agentId") ?? "untagged";
    const teamId: string = c.get("teamId") ?? "untagged";
    const keyId: string = c.get("keyId") ?? "unknown";
    const workflowId: string | null = c.get("workflowId") ?? null;

    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/anthropic/, "") || "/";
    const upstreamUrl = `${deps.anthropicApiUrl}${path}${url.search}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      const lower = key.toLowerCase();
      if (
        lower === "x-steadio-key" ||
        lower === "x-agent-id" ||
        lower === "x-team-id" ||
        lower === "x-workflow-id" ||
        lower === "host"
      ) continue;
      headers.set(key, value);
    }
    headers.set("host", new URL(deps.anthropicApiUrl).host);

    let isStreaming = false;
    let model = "unknown";
    let requestBody: string | undefined;
    let promptHash: string | undefined;

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      requestBody = await c.req.text();
      try {
        const parsed = JSON.parse(requestBody) as Record<string, unknown>;
        isStreaming = parsed["stream"] === true;
        model = (parsed["model"] as string) ?? "unknown";
      } catch { /* ok */ }
      promptHash = hashMessages(requestBody);
    }

    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: requestBody ?? null,
    }).catch((err: unknown) => {
      console.error("[anthropic-proxy] upstream error:", err);
      return null;
    });

    if (!upstream) {
      return c.json(
        {
          error: "upstream_unavailable",
          hint: "Could not reach the Anthropic API. Check that ANTHROPIC_API_URL is correct and the upstream is reachable from this container.",
          upstream_url: upstreamUrl,
        },
        502
      );
    }

    if (isStreaming) {
      const reader = upstream.body?.getReader();
      if (!reader) {
        return new Response(null, { status: upstream.status });
      }

      let accumulated = "";
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      const decoder = new TextDecoder();

      (async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            await writer.write(value);
            accumulated += decoder.decode(value, { stream: true });
          }
        } finally {
          await writer.close();
          const usage = parseAnthropicStreamUsage(accumulated) ?? { inputTokens: 0, outputTokens: 0 };
          if (upstream.status >= 500) {
            console.error(
              `[anthropic-proxy] upstream 5xx: status=${upstream.status} model=${model} keyId=${keyId} agentId=${agentId} requestId=${requestId}`
            );
          }
          void emitProxyEvent(deps.costEngineUrl, {
            requestId,
            provider: "anthropic",
            model,
            agentId,
            teamId,
            keyId,
            workflowId,
            usage,
            toolCalls: [],
            latencyMs: Date.now() - startMs,
            streaming: true,
            statusCode: upstream.status,
            ...(promptHash !== undefined ? { promptHash } : {}),
          });
        }
      })();

      return new Response(readable, {
        status: upstream.status,
        headers: {
          "content-type": "text/event-stream",
          "transfer-encoding": "chunked",
        },
      });
    }

    const responseText = await upstream.text();
    let usage = { inputTokens: 0, outputTokens: 0 };
    let toolCalls: ToolCall[] = [];
    try {
      const parsed = JSON.parse(responseText) as unknown;
      usage = parseAnthropicUsage(parsed) ?? usage;
      toolCalls = parseAnthropicToolCalls(parsed);
    } catch { /* ok */ }

    if (upstream.status >= 500) {
      console.error(
        `[anthropic-proxy] upstream 5xx: status=${upstream.status} model=${model} keyId=${keyId} agentId=${agentId} requestId=${requestId}`
      );
    }
    void emitProxyEvent(deps.costEngineUrl, {
      requestId,
      provider: "anthropic",
      model,
      agentId,
      teamId,
      keyId,
      workflowId,
      usage,
      toolCalls,
      latencyMs: Date.now() - startMs,
      streaming: false,
      statusCode: upstream.status,
      ...(promptHash !== undefined ? { promptHash } : {}),
    });

    return new Response(responseText, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });

  return app;
}
