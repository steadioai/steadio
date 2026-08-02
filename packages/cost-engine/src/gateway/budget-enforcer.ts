import { eq, and, gte } from "drizzle-orm";
import type { Redis } from "ioredis";
import { getDb } from "../db.js";
import { getRedis } from "../redis.js";
import { budgets, costEvents, alertConfigs } from "@steadio/shared/schema";
import { BudgetExceededError } from "@steadio/shared";
import { assertSafeWebhookUrl } from "../services/webhook-safety.js";

function getPeriodStart(periodType: string): Date {
  const now = new Date();
  switch (periodType) {
    case "daily": {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "weekly": {
      const d = new Date(now);
      d.setUTCHours(0, 0, 0, 0);
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() - day + 1); // Monday
      return d;
    }
    case "monthly": {
      const d = new Date(now);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d;
    }
    case "rolling_30d":
    default: {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() - 30);
      return d;
    }
  }
}

function getPeriodResetAt(periodType: string): string {
  const now = new Date();
  switch (periodType) {
    case "daily": {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + 1);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "weekly": {
      const d = new Date(now);
      const day = d.getUTCDay() || 7;
      d.setUTCDate(d.getUTCDate() + (8 - day)); // Next Monday
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    case "monthly": {
      const d = new Date(now);
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(1);
      d.setUTCHours(0, 0, 0, 0);
      return d.toISOString();
    }
    default: {
      const d = new Date(now);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString();
    }
  }
}

async function getSpendCents(
  budgetId: string,
  teamId: string,
  agentId: string,
  budgetAgentId: string | null,
  periodType: string,
): Promise<number> {
  const redis = getRedis();
  const cacheKey = `budget:spend:${budgetId}`;

  try {
    const cached = await redis.get(cacheKey);
    if (cached !== null) return parseInt(cached, 10);
  } catch {
    // Redis unavailable — fall through to DB (fail-open)
  }

  const periodStart = getPeriodStart(periodType);
  const db = getDb();

  const rows = await db
    .select({ costCents: costEvents.costCents })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.teamId, teamId),
        budgetAgentId !== null ? eq(costEvents.agentId, agentId) : undefined,
        gte(costEvents.createdAt, periodStart),
      ),
    );

  const total = rows.reduce((sum, r) => sum + r.costCents, 0);

  getRedis()
    .setex(cacheKey, 30, total.toString())
    .catch(() => {});

  return total;
}

// Returns true if this is a new threshold crossing (alert should fire).
// Uses a Redis key scoped to budget + threshold + period start so dedup
// resets naturally when the period rolls over.
async function shouldFireAlert(
  redis: Redis,
  budgetId: string,
  thresholdPct: number,
  periodType: string,
): Promise<boolean> {
  try {
    const periodStart = getPeriodStart(periodType).getTime();
    const key = `alert:threshold:${budgetId}:${thresholdPct}:${periodStart}`;
    // SET NX — only succeeds on first call per threshold per period
    const result = await redis.set(key, "1", "EX", 35 * 86400, "NX");
    return result !== null;
  } catch {
    // Redis down — fail-open, skip dedup
    return true;
  }
}

async function dispatchAlerts(
  teamId: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  try {
    const db = getDb();
    const configs = await db
      .select()
      .from(alertConfigs)
      .where(and(eq(alertConfigs.teamId, teamId), eq(alertConfigs.active, true)));

    const relevant = configs.filter(
      (cfg) => (cfg.enabledEvents as string[]).includes(event),
    );

    await Promise.allSettled(
      relevant.filter((cfg) => cfg.webhookUrl).map((cfg) =>
        sendToEndpoint(cfg.webhookUrl!, cfg.channel as "webhook" | "slack", event, payload),
      ),
    );
  } catch (err) {
    console.error("[budget] alert dispatch error:", err);
  }
}

async function sendToEndpoint(
  webhookUrl: string,
  channel: "webhook" | "slack",
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Defense-in-depth SSRF guard (ELEAA-781) — see services/webhook-safety.ts.
  assertSafeWebhookUrl(webhookUrl);
  const body =
    channel === "slack"
      ? {
          text: `*SteadIO Alert: ${event}*`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${event}*\n${Object.entries(payload)
                  .map(([k, v]) => `• *${k}:* ${String(v)}`)
                  .join("\n")}`,
              },
            },
          ],
        }
      : { event, payload, timestamp: new Date().toISOString() };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Alert webhook returned ${res.status}`);
}

export interface BudgetCheckResult {
  throttle: boolean;
  throttleModel: string | null;
  alerts: string[];
}

export async function checkBudgets(
  teamId: string,
  agentId: string,
): Promise<BudgetCheckResult> {
  const db = getDb();
  const redis = getRedis();

  const rows = await db
    .select()
    .from(budgets)
    .where(eq(budgets.teamId, teamId));

  const relevant = rows.filter((b) => b.agentId === null || b.agentId === agentId);

  if (relevant.length === 0) return { throttle: false, throttleModel: null, alerts: [] };

  let throttle = false;
  let throttleModel: string | null = null;
  const alerts: string[] = [];
  const alertPromises: Promise<void>[] = [];

  for (const budget of relevant) {
    const spendCents = await getSpendCents(
      budget.id,
      teamId,
      agentId,
      budget.agentId,
      budget.periodType,
    );

    const utilizationPct =
      budget.limitCents > 0 ? (spendCents / budget.limitCents) * 100 : 0;

    // Fire alert when utilization crosses the configured threshold
    if (utilizationPct >= budget.alertThresholdPercent) {
      const shouldSend = await shouldFireAlert(
        redis,
        budget.id,
        budget.alertThresholdPercent,
        budget.periodType,
      );
      if (shouldSend) {
        alertPromises.push(
          dispatchAlerts(teamId, "budget_threshold", {
            budgetId: budget.id,
            budgetName: budget.name,
            utilizationPercent: Math.round(utilizationPct),
            limitCents: budget.limitCents,
            spendCents,
            threshold: budget.alertThresholdPercent,
          }),
        );
      }
      alerts.push(
        `Budget "${budget.name}" at ${Math.round(utilizationPct)}% of $${(budget.limitCents / 100).toFixed(2)}`,
      );
    }

    if (spendCents >= budget.limitCents) {
      // Also fire a 100% threshold alert (deduped separately)
      const shouldSend100 = await shouldFireAlert(redis, budget.id, 100, budget.periodType);
      if (shouldSend100) {
        alertPromises.push(
          dispatchAlerts(teamId, "budget_threshold", {
            budgetId: budget.id,
            budgetName: budget.name,
            utilizationPercent: 100,
            limitCents: budget.limitCents,
            spendCents,
            threshold: 100,
          }),
        );
      }

      if (budget.enforcementMode === "kill") {
        void Promise.allSettled(alertPromises);
        throw new BudgetExceededError(
          budget.id,
          agentId,
          budget.limitCents,
          spendCents,
          getPeriodResetAt(budget.periodType),
        );
      }
      if (budget.enforcementMode === "throttle") {
        throttle = true;
        // Use first configured throttle model; callers supply provider default as fallback
        if (!throttleModel && budget.throttleModel) {
          throttleModel = budget.throttleModel;
        }
      }
      alerts.push(
        `Budget "${budget.name}" EXCEEDED: $${(spendCents / 100).toFixed(2)} / $${(budget.limitCents / 100).toFixed(2)}`,
      );
    }
  }

  void Promise.allSettled(alertPromises);
  return { throttle, throttleModel, alerts };
}

export async function recordSpend(
  teamId: string,
  agentId: string,
  costCents: number,
): Promise<void> {
  if (costCents <= 0) return;

  const db = getDb();
  const redis = getRedis();

  const rows = await db
    .select({ id: budgets.id, agentId: budgets.agentId })
    .from(budgets)
    .where(eq(budgets.teamId, teamId));

  const relevant = rows.filter((b) => b.agentId === null || b.agentId === agentId);

  await Promise.all(
    relevant.map(async (b) => {
      const key = `budget:spend:${b.id}`;
      try {
        await redis.incrby(key, costCents);
        await redis.expire(key, 86400 * 32); // max period + buffer
      } catch {
        // Redis down — cost recorded in DB, Redis re-syncs on next miss
      }
    }),
  );
}
