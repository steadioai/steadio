import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import type { Db } from "../db/client.js";
import type { Redis } from "ioredis";
import { costEvents, toolCallLogs } from "../db/schema.js";
import { computeCost } from "../services/cost-calculator.js";
import { checkAndEnforceBudget } from "../services/budget-enforcer.js";
import {
  trackVelocityAndDetectRunaway,
  circuitBreakAgent,
} from "../services/runaway-detector.js";
import type { ProxyEvent } from "../types.js";

export function createProxyEventsRouter(db: Db, redis: Redis) {
  const app = new Hono();

  // Called by the proxy after each successful LLM call
  app.post("/internal/proxy-events", async (c) => {
    let event: ProxyEvent;
    try {
      event = await c.req.json() as ProxyEvent;
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const cost = computeCost(
      event.provider,
      event.model,
      event.usage.inputTokens,
      event.usage.outputTokens,
      event.usage.cacheReadTokens ?? 0,
      event.usage.cacheWriteTokens ?? 0
    );

    // Persist cost event
    await db.insert(costEvents).values({
      id: uuidv4(),
      agentId: event.agentId,
      teamId: event.teamId,
      workflowId: event.workflowId,
      provider: event.provider,
      model: event.model,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      cacheReadTokens: event.usage.cacheReadTokens ?? 0,
      cacheWriteTokens: event.usage.cacheWriteTokens ?? 0,
      inputCostUsd: cost.inputCostUsd.toFixed(8),
      outputCostUsd: cost.outputCostUsd.toFixed(8),
      cacheReadCostUsd: cost.cacheReadCostUsd.toFixed(8),
      cacheWriteCostUsd: cost.cacheWriteCostUsd.toFixed(8),
      totalCostUsd: cost.totalCostUsd.toFixed(8),
      requestId: event.requestId,
      latencyMs: event.latencyMs,
      toolCallCount: event.toolCalls.length,
      streaming: event.streaming,
      statusCode: event.statusCode,
    });

    // Persist tool call logs
    if (event.toolCalls.length > 0) {
      await db.insert(toolCallLogs).values(
        event.toolCalls.map((tc) => ({
          id: uuidv4(),
          agentId: event.agentId,
          teamId: event.teamId,
          requestId: event.requestId,
          toolName: tc.name,
          parameters: JSON.stringify(tc.arguments).slice(0, 1024),
          resultStatus: "success" as const,
          latencyMs: null,
        }))
      );
    }

    // Budget enforcement (async, non-blocking for response)
    checkAndEnforceBudget(db, redis, event.agentId, event.teamId, cost.totalCostUsd).catch(
      (err: unknown) => console.error("[budget] enforcement error:", err)
    );

    // Runaway detection
    const totalTokens = event.usage.inputTokens + event.usage.outputTokens;
    trackVelocityAndDetectRunaway(redis, event.agentId, totalTokens)
      .then(async ({ runaway, reason }) => {
        if (runaway && reason) {
          await circuitBreakAgent(redis, event.agentId, reason, cost.totalCostUsd);
          console.log(`[runaway] circuit break: agent=${event.agentId} reason=${reason}`);
        }
      })
      .catch((err: unknown) => console.error("[runaway] detection error:", err));

    return c.json({ ok: true }, 202);
  });

  return app;
}
