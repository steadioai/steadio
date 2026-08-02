import { Hono } from "hono";
import { stream } from "hono/streaming";
import { randomUUID } from "node:crypto";
import { calculateCostCents } from "../pricing.js";
import { BudgetExceededError, type RequestContext } from "@steadio/shared";
import { getRedis } from "../redis.js";
import { getDb } from "../db.js";
import { checkBudgets, recordSpend } from "./budget-enforcer.js";
import { RunawayDetector } from "./runaway-detector.js";
import { resolveOrCreateAgent } from "./agent-resolver.js";
import {
  extractToolCallsFromOpenAIRequest,
  extractToolCallsFromAnthropicRequest,
} from "./tool-capture.js";
import { costEvents, toolCallLogs } from "@steadio/shared/schema";
import { handleEnforcementError } from "./enforcement.js";
import { logProxyRequest } from "./request-logger.js";
import type { AppVariables } from "./types.js";

export const gatewayRoutes = new Hono<{ Variables: AppVariables }>();

// ─── Deterministic Growth activation smoke paths ─────────────────────────────

gatewayRoutes.post("/smoke/openai/chat/completions", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();
  const workflowId = c.req.header("x-steadio-workflow") ?? "growth-smoke";
  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `growth-smoke:${teamId}`;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const model = (body["model"] as string | undefined) ?? "gpt-4o-mini";
  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "openai", model);

  try {
    await checkBudgets(teamId, agentId);
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "openai", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "blocked", statusCode: 429, errorType: err instanceof Error ? err.name : "unknown",
      budgetMode: err instanceof BudgetExceededError ? "kill" : "none",
    });
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const inputTokens = 12;
  const outputTokens = 7;
  const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "openai", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "openai", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });

  return c.json({
    id: `chatcmpl-smoke-${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: "growth-smoke-ok" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    steadio: { request_id: requestId, smoke: true, provider: "openai" },
  });
});

gatewayRoutes.post("/smoke/anthropic/messages", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();
  const workflowId = c.req.header("x-steadio-workflow") ?? "growth-smoke";
  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `growth-smoke:${teamId}`;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const model = (body["model"] as string | undefined) ?? "claude-haiku-4-5-20251001";
  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "anthropic", model);

  try {
    await checkBudgets(teamId, agentId);
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "anthropic", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "blocked", statusCode: 429, errorType: err instanceof Error ? err.name : "unknown",
      budgetMode: err instanceof BudgetExceededError ? "kill" : "none",
    });
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const inputTokens = 13;
  const outputTokens = 8;
  const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "anthropic", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "anthropic", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });

  return c.json({
    id: `msg_smoke_${requestId}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: "growth-smoke-ok" }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    steadio: { request_id: requestId, smoke: true, provider: "anthropic" },
  });
});

// ─── OpenAI-format proxy ─────────────────────────────────────────────────────

gatewayRoutes.post("/chat/completions", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();

  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `default:${teamId}`;
  const workflowId = c.req.header("x-steadio-workflow") ?? null;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "openai", body["model"] as string | undefined);
  const model = (body["model"] as string | undefined) ?? "gpt-4o";
  const isStream = body["stream"] === true;
  const requestToolCalls = extractToolCallsFromOpenAIRequest(body);

  const messages = (body["messages"] as Array<{ role: string; content?: unknown }> | undefined) ?? [];
  const promptSample = messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
    .slice(0, 500);

  // Pre-request enforcement
  const runaway = new RunawayDetector(getRedis());
  try {
    await runaway.check(agentId, 0, promptSample);
    const budgetResult = await checkBudgets(teamId, agentId);
    if (budgetResult.throttle) {
      const originalModel = body["model"] as string | undefined;
      const fallback = budgetResult.throttleModel ?? "gpt-4o-mini";
      body["model"] = fallback;
      console.warn("[budget:throttle] model downgraded", {
        agentId, teamId, requestId, originalModel, throttleModel: fallback,
      });
    }
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "openai", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "blocked", statusCode: 429, errorType: err instanceof Error ? err.name : "unknown",
      budgetMode: err instanceof BudgetExceededError ? "kill" : "none",
    });
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const forwardHeaders: Record<string, string> = { "content-type": "application/json" };
  const authHeader = c.req.header("authorization");
  if (authHeader) forwardHeaders["authorization"] = authHeader;

  let providerRes: Response;
  try {
    providerRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "openai", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "upstream_error", statusCode: 502, errorType: err instanceof Error ? err.name : "fetch_error",
      errorMessage: err instanceof Error ? err.message : "Failed to reach OpenAI",
    });
    return c.json({ error: "upstream_error", message: "Failed to reach OpenAI" }, 502);
  }

  if (!providerRes.ok && !isStream) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "openai", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "upstream_error", statusCode: providerRes.status, upstreamStatus: providerRes.status,
      errorType: "upstream_non_2xx",
    });
    return new Response(await providerRes.text(), {
      status: providerRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (isStream) {
    return handleOpenAIStream(c, providerRes,
      { teamId, agentId, workflowId, requestId, provider: "openai" },
      model, startMs, requestToolCalls, apiKeyId);
  }

  const responseBody = await providerRes.json() as Record<string, unknown>;
  const usage = responseBody["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "openai", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "openai", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  void runaway.checkVelocity(agentId, inputTokens + outputTokens);

  const choices = responseBody["choices"] as Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> | undefined;
  const responseTCs = (choices ?? []).flatMap((ch) =>
    (ch.message?.tool_calls ?? []).map((tc) => {
      let params: Record<string, unknown> = {};
      try { params = JSON.parse(tc.function?.arguments ?? "{}") as Record<string, unknown>; } catch {}
      return { toolName: tc.function?.name ?? "unknown", parameters: params };
    }),
  );

  const allToolCalls = [...requestToolCalls, ...responseTCs];
  if (allToolCalls.length > 0) {
    void recordToolCalls(allToolCalls, { teamId, agentId, workflowId, requestId }, costCentVal);
  }

  return c.json(responseBody);
});

// ─── Anthropic-format proxy ──────────────────────────────────────────────────

gatewayRoutes.post("/messages", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();

  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `default:${teamId}`;
  const workflowId = c.req.header("x-steadio-workflow") ?? null;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const model = (body["model"] as string | undefined) ?? "claude-sonnet-4-6";
  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "anthropic", model);
  const isStream = body["stream"] === true;
  const requestToolCalls = extractToolCallsFromAnthropicRequest(body);

  const messages = (body["messages"] as Array<{ role: string; content?: unknown }> | undefined) ?? [];
  const promptSample = messages
    .filter((m) => m.role === "user")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n")
    .slice(0, 500);

  const runaway = new RunawayDetector(getRedis());
  try {
    await runaway.check(agentId, 0, promptSample);
    const budgetResult = await checkBudgets(teamId, agentId);
    if (budgetResult.throttle) {
      const originalModel = body["model"] as string | undefined;
      const fallback = budgetResult.throttleModel ?? "claude-haiku-4-5-20251001";
      body["model"] = fallback;
      console.warn("[budget:throttle] model downgraded", {
        agentId, teamId, requestId, originalModel, throttleModel: fallback,
      });
    }
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "anthropic", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "blocked", statusCode: 429, errorType: err instanceof Error ? err.name : "unknown",
      budgetMode: err instanceof BudgetExceededError ? "kill" : "none",
    });
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const forwardHeaders: Record<string, string> = {
    "content-type": "application/json",
    "anthropic-version": c.req.header("anthropic-version") ?? "2023-06-01",
  };
  const anthropicKey = c.req.header("x-api-key");
  if (anthropicKey) forwardHeaders["x-api-key"] = anthropicKey;

  let providerRes: Response;
  try {
    providerRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(body),
    });
  } catch (err) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "anthropic", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "upstream_error", statusCode: 502, errorType: err instanceof Error ? err.name : "fetch_error",
      errorMessage: err instanceof Error ? err.message : "Failed to reach Anthropic",
    });
    return c.json({ error: "upstream_error", message: "Failed to reach Anthropic" }, 502);
  }

  if (!providerRes.ok && !isStream) {
    logProxyRequest({
      requestId, teamId, agentId, apiKeyId, provider: "anthropic", model,
      inputTokens: 0, outputTokens: 0, costCents: 0, durationMs: Date.now() - startMs,
      outcome: "upstream_error", statusCode: providerRes.status, upstreamStatus: providerRes.status,
      errorType: "upstream_non_2xx",
    });
    return new Response(await providerRes.text(), {
      status: providerRes.status,
      headers: { "content-type": "application/json" },
    });
  }

  if (isStream) {
    return handleAnthropicStream(c, providerRes,
      { teamId, agentId, workflowId, requestId, provider: "anthropic" },
      model, startMs, requestToolCalls, apiKeyId);
  }

  const responseBody = await providerRes.json() as Record<string, unknown>;
  const usage = responseBody["usage"] as { input_tokens?: number; output_tokens?: number } | undefined;
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "anthropic", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "anthropic", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  void runaway.checkVelocity(agentId, inputTokens + outputTokens);

  const content = responseBody["content"] as Array<{ type?: string; name?: string; input?: Record<string, unknown> }> | undefined;
  const responseTCs = (content ?? [])
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ toolName: b.name ?? "unknown", parameters: b.input ?? {} }));

  const allToolCalls = [...requestToolCalls, ...responseTCs];
  if (allToolCalls.length > 0) {
    void recordToolCalls(allToolCalls, { teamId, agentId, workflowId, requestId }, costCentVal);
  }

  return c.json(responseBody);
});

// ─── OpenAI embeddings ────────────────────────────────────────────────────────

gatewayRoutes.post("/embeddings", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();
  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `default:${teamId}`;
  const workflowId = c.req.header("x-steadio-workflow") ?? null;

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const model = (body["model"] as string | undefined) ?? "text-embedding-3-small";
  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "openai", model);

  try {
    await checkBudgets(teamId, agentId);
  } catch (err) {
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const forwardHeaders: Record<string, string> = { "content-type": "application/json" };
  const authHeader = c.req.header("authorization");
  if (authHeader) forwardHeaders["authorization"] = authHeader;

  let providerRes: Response;
  try {
    providerRes = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: forwardHeaders,
      body: JSON.stringify(body),
    });
  } catch {
    return c.json({ error: "upstream_error", message: "Failed to reach OpenAI" }, 502);
  }

  const responseBody = await providerRes.json() as Record<string, unknown>;
  const usage = responseBody["usage"] as { prompt_tokens?: number } | undefined;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const costCentVal = calculateCostCents(model, inputTokens, 0);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "openai", model, inputTokens, outputTokens: 0, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "openai", model, inputTokens, outputTokens: 0, costCents: costCentVal, durationMs });
  return c.json(responseBody, providerRes.status as 200);
});

// ─── Google Gemini proxy ──────────────────────────────────────────────────────
// Mount: /v1/google/* → generativelanguage.googleapis.com/v1beta/*
// SDK usage: set base_url to http://proxy:3001/v1/google and use /v1beta paths

gatewayRoutes.all("/google/*", async (c) => {
  const teamId = c.get("teamId") as string;
  const apiKeyId = c.get("apiKeyId") as string;
  const requestId = randomUUID();
  const startMs = Date.now();
  const externalAgentId = c.req.header("x-steadio-agent-id") ?? `default:${teamId}`;
  const workflowId = c.req.header("x-steadio-workflow") ?? null;

  // Strip /google prefix to get the actual Gemini API path
  const googlePath = c.req.path.replace(/^\/v1\/google/, "");

  // Extract model name from path: /v1beta/models/{model}:generateContent
  const modelMatch = googlePath.match(/\/models\/([^/:]+)/);
  const model = modelMatch?.[1] ?? "unknown";

  const agentId = await resolveOrCreateAgent(teamId, externalAgentId, "google", model);

  try {
    await checkBudgets(teamId, agentId);
  } catch (err) {
    return handleEnforcementError(c, err, agentId, teamId);
  }

  const method = c.req.method;
  const forwardHeaders: Record<string, string> = {};
  const contentType = c.req.header("content-type");
  if (contentType) forwardHeaders["content-type"] = contentType;

  // Google API supports Authorization: Bearer <token> or ?key= query param
  const authHeader = c.req.header("authorization");
  if (authHeader) forwardHeaders["authorization"] = authHeader;

  const upstreamUrl = new URL(`https://generativelanguage.googleapis.com${googlePath}`);
  // Forward non-steadio query params (includes ?key= for API key auth)
  new URL(c.req.url).searchParams.forEach((v, k) => {
    if (!k.startsWith("x-steadio")) upstreamUrl.searchParams.set(k, v);
  });

  const hasBody = method !== "GET" && method !== "HEAD";
  let providerRes: Response;
  try {
    providerRes = await fetch(upstreamUrl.toString(), {
      method,
      headers: forwardHeaders,
      body: hasBody ? await c.req.text() : null,
    });
  } catch {
    return c.json({ error: "upstream_error", message: "Failed to reach Google Gemini" }, 502);
  }

  const responseBody = await providerRes.json() as Record<string, unknown>;
  const usageMeta = responseBody["usageMetadata"] as {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
  } | undefined;
  const inputTokens = usageMeta?.promptTokenCount ?? 0;
  const outputTokens = usageMeta?.candidatesTokenCount ?? 0;
  const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
  const durationMs = Date.now() - startMs;

  void recordCostEvent({ teamId, agentId, workflowId, requestId, provider: "google", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
  logProxyRequest({ requestId, teamId, agentId, apiKeyId, provider: "google", model, inputTokens, outputTokens, costCents: costCentVal, durationMs });

  return c.json(responseBody, providerRes.status as 200);
});

// Pricing info (no auth required)
gatewayRoutes.get("/pricing/:model", (c) => {
  const model = c.req.param("model");
  const cost = calculateCostCents(model, 1_000_000, 1_000_000);
  return c.json({ model, costCentsPerMillionEachDirection: cost / 2 });
});

// ─── Streaming handlers ───────────────────────────────────────────────────────

async function handleOpenAIStream(
  c: Parameters<typeof stream>[0],
  providerRes: Response,
  ctx: RequestContext,
  model: string,
  startMs: number,
  requestToolCalls: Array<{ toolName: string; parameters: Record<string, unknown> }>,
  apiKeyId: string,
): Promise<Response> {
  let inputTokens = 0;
  let outputTokens = 0;
  const runaway = new RunawayDetector(getRedis());

  return stream(c, async (s) => {
    const reader = providerRes.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      await s.write(chunk);

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as Record<string, unknown>;
          const usage = parsed["usage"] as { prompt_tokens?: number; completion_tokens?: number } | undefined;
          if (usage?.prompt_tokens) inputTokens = usage.prompt_tokens;
          if (usage?.completion_tokens) outputTokens = usage.completion_tokens;
        } catch { /* skip non-JSON */ }
      }
    }

    const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
    const durationMs = Date.now() - startMs;
    void recordCostEvent({ ...ctx, model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
    logProxyRequest({ requestId: ctx.requestId, teamId: ctx.teamId, agentId: ctx.agentId, apiKeyId, provider: ctx.provider, model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
    if (requestToolCalls.length > 0) void recordToolCalls(requestToolCalls, ctx, costCentVal);
    void runaway.checkVelocity(ctx.agentId, inputTokens + outputTokens);
  });
}

async function handleAnthropicStream(
  c: Parameters<typeof stream>[0],
  providerRes: Response,
  ctx: RequestContext,
  model: string,
  startMs: number,
  requestToolCalls: Array<{ toolName: string; parameters: Record<string, unknown> }>,
  apiKeyId: string,
): Promise<Response> {
  let inputTokens = 0;
  let outputTokens = 0;
  const runaway = new RunawayDetector(getRedis());

  return stream(c, async (s) => {
    const reader = providerRes.body?.getReader();
    if (!reader) return;

    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      buffer += chunk;
      await s.write(chunk);

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        try {
          const parsed = JSON.parse(line.slice(6).trim()) as Record<string, unknown>;
          const type = parsed["type"] as string | undefined;
          if (type === "message_start") {
            const msg = parsed["message"] as { usage?: { input_tokens?: number } } | undefined;
            if (msg?.usage?.input_tokens) inputTokens = msg.usage.input_tokens;
          } else if (type === "message_delta") {
            const usage = parsed["usage"] as { output_tokens?: number } | undefined;
            if (usage?.output_tokens) outputTokens = usage.output_tokens;
          }
        } catch { /* skip */ }
      }
    }

    const costCentVal = calculateCostCents(model, inputTokens, outputTokens);
    const durationMs = Date.now() - startMs;
    void recordCostEvent({ ...ctx, model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
    logProxyRequest({ requestId: ctx.requestId, teamId: ctx.teamId, agentId: ctx.agentId, apiKeyId, provider: ctx.provider, model, inputTokens, outputTokens, costCents: costCentVal, durationMs });
    if (requestToolCalls.length > 0) void recordToolCalls(requestToolCalls, ctx, costCentVal);
    void runaway.checkVelocity(ctx.agentId, inputTokens + outputTokens);
  });
}

// ─── Async helpers ────────────────────────────────────────────────────────────

async function recordCostEvent(params: {
  teamId: string; agentId: string; workflowId: string | null; requestId: string;
  provider: string; model: string; inputTokens: number; outputTokens: number;
  costCents: number; durationMs: number;
}): Promise<void> {
  try {
    const db = getDb();
    await db.insert(costEvents).values({
      agentId: params.agentId,
      teamId: params.teamId,
      requestId: params.requestId,
      workflowId: params.workflowId,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costCents: params.costCents,
      durationMs: params.durationMs,
      metadata: {},
    });
    await recordSpend(params.teamId, params.agentId, params.costCents);
  } catch (err) {
    console.error("[proxy] failed to record cost event:", err);
  }
}

async function recordToolCalls(
  calls: Array<{ toolName: string; parameters: Record<string, unknown> }>,
  ctx: Pick<RequestContext, "teamId" | "agentId" | "workflowId" | "requestId">,
  totalCostCents: number,
): Promise<void> {
  if (calls.length === 0) return;
  try {
    const db = getDb();
    const costPerTool = Math.floor(totalCostCents / calls.length);
    await db.insert(toolCallLogs).values(
      calls.map((tc) => ({
        agentId: ctx.agentId,
        teamId: ctx.teamId,
        requestId: ctx.requestId,
        workflowId: ctx.workflowId,
        toolName: tc.toolName,
        parameters: tc.parameters,
        resultStatus: "success" as const,
        costCents: costPerTool,
        metadata: {},
      })),
    );
  } catch (err) {
    console.error("[proxy] failed to record tool calls:", err);
  }
}
