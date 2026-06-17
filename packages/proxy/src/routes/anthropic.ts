import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import {
  parseAnthropicUsage,
  parseAnthropicToolCalls,
  parseAnthropicStreamUsage,
} from "../providers/anthropic.js";
import { emitProxyEvent } from "../emit.js";
import type { Redis } from "ioredis";

interface ProxyDeps {
  anthropicApiUrl: string;
  costEngineUrl: string;
  redis: Redis;
}

export function createAnthropicRouter(deps: ProxyDeps) {
  const app = new Hono();

  app.all("/*", async (c) => {
    const requestId = uuidv4();
    const startMs = Date.now();

    const agentId: string = c.get("agentId") ?? "untagged";
    const teamId: string = c.get("teamId") ?? "untagged";
    const workflowId: string | null = c.get("workflowId") ?? null;

    const url = new URL(c.req.url);
    const path = url.pathname.replace(/^\/anthropic/, "") || "/";
    const upstreamUrl = `${deps.anthropicApiUrl}${path}${url.search}`;

    const headers = new Headers();
    for (const [key, value] of Object.entries(c.req.header())) {
      const lower = key.toLowerCase();
      if (
        lower === "x-elevation-key" ||
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

    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      requestBody = await c.req.text();
      try {
        const parsed = JSON.parse(requestBody) as Record<string, unknown>;
        isStreaming = parsed["stream"] === true;
        model = (parsed["model"] as string) ?? "unknown";
      } catch { /* ok */ }
    }

    const upstream = await fetch(upstreamUrl, {
      method: c.req.method,
      headers,
      body: requestBody ?? undefined,
    }).catch((err: unknown) => {
      console.error("[anthropic-proxy] upstream error:", err);
      return null;
    });

    if (!upstream) {
      return c.json({ error: "upstream_unavailable" }, 502);
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
          void emitProxyEvent(deps.costEngineUrl, {
            requestId,
            provider: "anthropic",
            model,
            agentId,
            teamId,
            workflowId,
            usage,
            toolCalls: [],
            latencyMs: Date.now() - startMs,
            streaming: true,
            statusCode: upstream.status,
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
    let toolCalls = [];
    try {
      const parsed = JSON.parse(responseText) as unknown;
      usage = parseAnthropicUsage(parsed) ?? usage;
      toolCalls = parseAnthropicToolCalls(parsed);
    } catch { /* ok */ }

    void emitProxyEvent(deps.costEngineUrl, {
      requestId,
      provider: "anthropic",
      model,
      agentId,
      teamId,
      workflowId,
      usage,
      toolCalls,
      latencyMs: Date.now() - startMs,
      streaming: false,
      statusCode: upstream.status,
    });

    return new Response(responseText, {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    });
  });

  return app;
}
