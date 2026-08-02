import { Hono } from "hono";
import { eq, and, gte, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { getRedis } from "../redis.js";
import { costEvents, toolCallLogs, runawayEvents, budgets } from "@steadio/shared/schema";
import { calculateCostCents } from "../pricing.js";
import { RunawayDetector } from "../gateway/runaway-detector.js";

export const proxyEventsRoutes = new Hono();

interface ProxyEvent {
  requestId: string;
  provider: string;
  model: string;
  agentId: string;
  teamId: string;
  keyId?: string;
  workflowId?: string | null;
  usage: { inputTokens: number; outputTokens: number };
  toolCalls?: Array<{ name: string; arguments?: unknown }>;
  latencyMs: number;
  streaming: boolean;
  statusCode: number;
  promptHash?: string;
}

function secondsUntilMidnightUTC(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCDate(midnight.getUTCDate() + 1);
  midnight.setUTCHours(0, 0, 0, 0);
  return Math.max(1, Math.floor((midnight.getTime() - now.getTime()) / 1000));
}

proxyEventsRoutes.post("/", async (c) => {
  let event: ProxyEvent;
  try {
    event = await c.req.json<ProxyEvent>();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  try {
    const db = getDb();

    // Calculate cost
    const costCents = calculateCostCents(
      event.model,
      event.usage.inputTokens,
      event.usage.outputTokens,
    );

    // Insert cost event
    await db.insert(costEvents).values({
      agentId: event.agentId,
      teamId: event.teamId,
      requestId: event.requestId,
      workflowId: event.workflowId ?? null,
      provider: event.provider,
      model: event.model,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      costCents,
      durationMs: event.latencyMs,
      metadata: {},
    });

    // Insert tool call logs if present
    if (event.toolCalls && event.toolCalls.length > 0) {
      await db.insert(toolCallLogs).values(
        event.toolCalls.map((tc) => ({
          agentId: event.agentId,
          teamId: event.teamId,
          requestId: event.requestId,
          toolName: tc.name,
          parameters: JSON.stringify(tc.arguments ?? {}).slice(0, 1024),
          resultStatus: "success",
        })),
      );
    }

    // Budget enforcement — fire-and-forget
    void checkBudget(event, costCents).catch((err) => {
      console.error("[proxy-events] budget check failed:", err);
    });

    // Runaway detection — fire-and-forget
    const totalTokens = event.usage.inputTokens + event.usage.outputTokens;
    void checkRunaway(event, totalTokens).catch((err) => {
      console.error("[proxy-events] runaway check failed:", err);
    });

    return c.json({ ok: true }, 202);
  } catch (err) {
    console.error("[proxy-events] ingest error:", err);
    return c.json({ error: "internal_error" }, 500);
  }
});

async function checkBudget(event: ProxyEvent, _costCents: number): Promise<void> {
  const db = getDb();
  const redis = getRedis();

  // Find kill-mode budgets for this team
  const teamBudgets = await db
    .select()
    .from(budgets)
    .where(
      and(
        eq(budgets.teamId, event.teamId),
        eq(budgets.enforcementMode, "kill"),
      ),
    );

  if (teamBudgets.length === 0) return;

  for (const budget of teamBudgets) {
    // Determine period start
    const now = new Date();
    let periodStart: Date;
    switch (budget.periodType) {
      case "daily": {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        periodStart = d;
        break;
      }
      case "weekly": {
        const d = new Date(now);
        d.setUTCHours(0, 0, 0, 0);
        const day = d.getUTCDay() || 7;
        d.setUTCDate(d.getUTCDate() - day + 1);
        periodStart = d;
        break;
      }
      case "monthly": {
        const d = new Date(now);
        d.setUTCDate(1);
        d.setUTCHours(0, 0, 0, 0);
        periodStart = d;
        break;
      }
      default: {
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() - 30);
        periodStart = d;
      }
    }

    // Sum current spend in period
    const conditions = [
      eq(costEvents.teamId, event.teamId),
      gte(costEvents.createdAt, periodStart),
    ];
    if (budget.agentId) {
      conditions.push(eq(costEvents.agentId, budget.agentId));
    }

    const spendRows = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
      .from(costEvents)
      .where(and(...conditions));

    const currentSpend = spendRows[0]?.total ?? 0;

    if (currentSpend >= budget.limitCents) {
      const ttl = secondsUntilMidnightUTC();
      const now = new Date();
      const resetAt = new Date(now.getTime() + ttl * 1000).toISOString();
      const payload = JSON.stringify({
        capAmountUsd: budget.limitCents / 100,
        currentSpendUsd: currentSpend / 100,
        resetAt,
      });
      await redis.setex(`budget:killed:team:${event.teamId}`, ttl, payload);
      if (budget.agentId) {
        await redis.setex(`budget:killed:agent:${budget.agentId}`, ttl, payload);
      }
    }
  }
}

async function checkRunaway(event: ProxyEvent, totalTokens: number): Promise<void> {
  const redis = getRedis();
  const db = getDb();
  const detector = new RunawayDetector(redis);

  const velocity = await detector.checkVelocity(event.agentId, totalTokens);

  if (velocity.isRunaway) {
    const cooldownUntil = await detector.tripCircuitBreaker(event.agentId);

    // Set the key the proxy's budget-check middleware reads for circuit breaking
    await redis.setex(
      `runaway:circuit:${event.agentId}`,
      300,
      JSON.stringify({ state: "open", reason: "velocity", cooldownUntil: cooldownUntil.toISOString() }),
    );

    await db.insert(runawayEvents).values({
      agentId: event.agentId,
      teamId: event.teamId,
      triggerType: "velocity",
      tokenCount: totalTokens,
      evidence: {
        velocityWindowTokens: velocity.currentWindowTokens,
        velocityBaseline: velocity.baselineTokensPerWindow,
        source: "proxy-events",
      },
      actionTaken: "circuit_break",
      cooldownUntil,
    });
  }
}
