import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { calculateCostCents } from "../pricing.js";
import { getDb } from "../db.js";
import { costEvents, teams, agents } from "@steadio/shared/schema";

export const DEMO_TEAM_ID = "demo-sandbox";

export const demoRoutes = new Hono();

const DEMO_RATE_LIMIT_WINDOW_MS = 60_000;
const DEMO_RATE_LIMIT_MAX_REQUESTS = 30;
const DEMO_RATE_LIMIT_MAX_BUCKETS = 5_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();

const DEMO_MODELS = {
  openai: ["gpt-4o", "gpt-4o-mini", "gpt-3.5-turbo"],
  anthropic: ["claude-sonnet-4-6", "claude-haiku-4-5-20251001"],
} as const;

const DEMO_WORKFLOW_IDS = new Set([
  "doc-processing-pipeline",
  "support-triage-v2",
  "code-review-bot",
  "sandbox-workflow",
  "my-pipeline",
]);

const DEMO_AGENT_IDS = new Set([
  "doc-parser",
  "content-enricher",
  "report-writer",
  "intent-classifier",
  "response-drafter",
  "quality-checker",
  "code-analyzer",
  "bug-detector",
  "review-writer",
  "sandbox-agent",
  "my-agent",
]);

const requestSchema = z.object({
  model: z.string().trim().max(64).optional(),
}).passthrough();

// Wide-open CORS — demo endpoint is intentionally public, but requests are
// bounded below and demo writes are normalized to a small fixed data set.
demoRoutes.use("*", cors({ origin: "*", allowHeaders: ["Content-Type", "x-steadio-agent-id", "x-steadio-workflow"], allowMethods: ["POST", "OPTIONS"] }));

demoRoutes.use("*", async (c, next) => {
  const forwardedFor = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  const clientKey = forwardedFor || c.req.header("x-real-ip") || "unknown";
  const now = Date.now();
  const existing = rateLimitBuckets.get(clientKey);

  if (!existing || existing.resetAt <= now) {
    if (rateLimitBuckets.size >= DEMO_RATE_LIMIT_MAX_BUCKETS) {
      for (const [key, bucket] of rateLimitBuckets) {
        if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
      }
    }
    rateLimitBuckets.set(clientKey, { count: 1, resetAt: now + DEMO_RATE_LIMIT_WINDOW_MS });
    await next();
    return;
  }

  if (existing.count >= DEMO_RATE_LIMIT_MAX_REQUESTS) {
    return c.json({ error: "rate_limited", message: "Demo request limit exceeded; please try again shortly" }, 429);
  }

  existing.count += 1;
  await next();
});

// Lazily bootstrap the demo team and agent records so the demo works
// without running the seed script first.
async function ensureDemoTeam(): Promise<void> {
  const db = getDb();
  await db
    .insert(teams)
    .values({ id: DEMO_TEAM_ID, name: "SteadIO Demo Sandbox", slug: "demo-sandbox" })
    .onConflictDoNothing();
}

async function ensureDemoAgent(externalId: string, provider: string, model: string): Promise<string> {
  const agentId = `demo-${externalId}`;
  const db = getDb();
  await db
    .insert(agents)
    .values({ id: agentId, teamId: DEMO_TEAM_ID, name: externalId, externalId, provider, model })
    .onConflictDoNothing();
  return agentId;
}

function normalizeDemoInput(body: unknown, provider: keyof typeof DEMO_MODELS, headers: Headers):
  | { ok: true; model: string; externalAgentId: string; workflowId: string }
  | { ok: false; error: string; message: string } {
  const parsed = requestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: "invalid_request", message: "Demo request model must be a string of at most 64 characters" };
  }

  const allowedModels = DEMO_MODELS[provider];
  const defaultModel = allowedModels[0];
  const requestedModel = parsed.data.model ?? defaultModel;
  if (!(allowedModels as readonly string[]).includes(requestedModel)) {
    return { ok: false, error: "unsupported_model", message: `Demo ${provider} model must be one of: ${allowedModels.join(", ")}` };
  }

  const requestedAgent = headers.get("x-steadio-agent-id")?.trim() || "sandbox-agent";
  const requestedWorkflow = headers.get("x-steadio-workflow")?.trim() || "sandbox-workflow";

  return {
    ok: true,
    model: requestedModel,
    externalAgentId: DEMO_AGENT_IDS.has(requestedAgent) ? requestedAgent : "sandbox-agent",
    workflowId: DEMO_WORKFLOW_IDS.has(requestedWorkflow) ? requestedWorkflow : "sandbox-workflow",
  };
}

function randomInt(min: number, max: number): number {
  return Math.floor(min + Math.random() * (max - min));
}

const MOCK_RESPONSE_TEXT =
  "This is a simulated response from the SteadIO demo sandbox. " +
  "In production, your LLM provider responds here while SteadIO records " +
  "per-agent and per-workflow cost attribution in real time.";

function mockOpenAIResponse(model: string): Record<string, unknown> {
  const inputTokens = randomInt(400, 2500);
  const outputTokens = randomInt(40, 600);
  return {
    id: `chatcmpl-demo-${randomUUID().slice(0, 12)}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: MOCK_RESPONSE_TEXT },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens },
    "x-steadio-demo": true,
  };
}

function mockAnthropicResponse(model: string): Record<string, unknown> {
  const inputTokens = randomInt(400, 2500);
  const outputTokens = randomInt(40, 600);
  return {
    id: `msg_demo_${randomUUID().slice(0, 12)}`,
    type: "message",
    role: "assistant",
    model,
    content: [{ type: "text", text: MOCK_RESPONSE_TEXT }],
    stop_reason: "end_turn",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
    "x-steadio-demo": true,
  };
}

async function recordDemoEvent(params: {
  agentId: string;
  workflowId: string | null;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  startMs: number;
}): Promise<void> {
  try {
    const costCents = calculateCostCents(params.model, params.inputTokens, params.outputTokens);
    const durationMs = Date.now() - params.startMs + randomInt(100, 600);
    const db = getDb();
    await db.insert(costEvents).values({
      agentId: params.agentId,
      teamId: DEMO_TEAM_ID,
      requestId: randomUUID(),
      workflowId: params.workflowId,
      provider: params.provider,
      model: params.model,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      costCents,
      durationMs,
      metadata: { demo: true },
    });
  } catch {
    // Never let recording errors fail the demo response
  }
}

// POST /v1/demo/chat/completions — OpenAI-format sandbox
demoRoutes.post("/chat/completions", async (c) => {
  const startMs = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const input = normalizeDemoInput(body, "openai", c.req.raw.headers);
  if (!input.ok) {
    return c.json({ error: input.error, message: input.message }, input.error === "unsupported_model" ? 400 : 422);
  }

  const { model, externalAgentId, workflowId } = input;

  const responseBody = mockOpenAIResponse(model);
  const usage = responseBody["usage"] as { prompt_tokens: number; completion_tokens: number };

  // Bootstrap and record async so response is immediate
  void (async () => {
    try {
      await ensureDemoTeam();
      const agentId = await ensureDemoAgent(externalAgentId, "openai", model);
      await recordDemoEvent({
        agentId, workflowId, provider: "openai", model,
        inputTokens: usage.prompt_tokens,
        outputTokens: usage.completion_tokens,
        startMs,
      });
    } catch { /* ignore */ }
  })();

  return c.json(responseBody);
});

// POST /v1/demo/messages — Anthropic-format sandbox
demoRoutes.post("/messages", async (c) => {
  const startMs = Date.now();
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ error: "invalid_json", message: "Request body must be valid JSON" }, 400);
  }

  const input = normalizeDemoInput(body, "anthropic", c.req.raw.headers);
  if (!input.ok) {
    return c.json({ error: input.error, message: input.message }, input.error === "unsupported_model" ? 400 : 422);
  }

  const { model, externalAgentId, workflowId } = input;

  const responseBody = mockAnthropicResponse(model);
  const usage = responseBody["usage"] as { input_tokens: number; output_tokens: number };

  void (async () => {
    try {
      await ensureDemoTeam();
      const agentId = await ensureDemoAgent(externalAgentId, "anthropic", model);
      await recordDemoEvent({
        agentId, workflowId, provider: "anthropic", model,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        startMs,
      });
    } catch { /* ignore */ }
  })();

  return c.json(responseBody);
});
