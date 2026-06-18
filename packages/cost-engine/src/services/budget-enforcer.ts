import type { Redis } from "ioredis";
import type { Db } from "../db/client.js";
import { budgets } from "../db/schema.js";
import { eq, and } from "drizzle-orm";

// Budget period window utilities
export function getPeriodWindow(period: string): { start: Date; end: Date } {
  const now = new Date();
  if (period === "daily") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 1);
    return { start, end };
  }
  if (period === "weekly") {
    const start = new Date(now);
    const day = start.getUTCDay();
    start.setUTCDate(start.getUTCDate() - day);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }
  // monthly
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  );
  return { start, end };
}

export function budgetRedisKey(
  scope: string,
  scopeId: string,
  period: string,
  windowStart: Date
): string {
  return `budget:spend:${scope}:${scopeId}:${period}:${windowStart.toISOString()}`;
}

// Atomically increment spend and return new total (in USD * 1e6 to avoid float math)
export async function incrementSpend(
  redis: Redis,
  key: string,
  amountUsd: number,
  ttlSeconds: number
): Promise<number> {
  const microUsd = Math.round(amountUsd * 1_000_000);
  const pipeline = redis.pipeline();
  pipeline.incrby(key, microUsd);
  pipeline.expire(key, ttlSeconds);
  const results = await pipeline.exec();
  const newMicroUsd = (results?.[0]?.[1] as number) ?? 0;
  return newMicroUsd / 1_000_000;
}

// Check and enforce budget after a cost event
export async function checkAndEnforceBudget(
  db: Db,
  redis: Redis,
  agentId: string,
  teamId: string,
  costUsd: number
): Promise<void> {
  // Check agent-level budgets
  const agentBudgets = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.scope, "agent"), eq(budgets.scopeId, agentId)));

  // Check team-level budgets
  const teamBudgets = await db
    .select()
    .from(budgets)
    .where(and(eq(budgets.scope, "team"), eq(budgets.scopeId, teamId)));

  for (const budget of [...agentBudgets, ...teamBudgets]) {
    const { start, end } = getPeriodWindow(budget.period);
    const ttl = Math.ceil((end.getTime() - Date.now()) / 1000);
    const key = budgetRedisKey(budget.scope, budget.scopeId, budget.period, start);

    const newSpend = await incrementSpend(redis, key, costUsd, ttl);
    const capUsd = Number(budget.capUsd);
    const utilizationPercent = (newSpend / capUsd) * 100;

    // Kill mode — block future requests
    if (
      budget.enforcementMode === "kill" &&
      utilizationPercent >= 100
    ) {
      const killKey =
        budget.scope === "agent"
          ? `budget:killed:agent:${agentId}`
          : `budget:killed:team:${teamId}`;

      await redis.set(
        killKey,
        JSON.stringify({
          capAmountUsd: capUsd,
          currentSpendUsd: newSpend,
          resetAt: end.toISOString(),
          budgetId: budget.id,
        }),
        "EX",
        ttl
      );
    }

    // Warning threshold
    const warningPct = budget.warningThresholdPercent;
    if (utilizationPercent >= warningPct && utilizationPercent < 100) {
      // Mark warning fired in Redis (idempotent)
      const warnKey = `budget:warned:${budget.id}:${start.toISOString()}`;
      const alreadyWarned = await redis.set(warnKey, "1", "EX", ttl, "NX");
      if (alreadyWarned === "OK") {
        // TODO: fire alert via alert service
        console.log(
          `[budget] warning: ${budget.scope}=${budget.scopeId} at ${utilizationPercent.toFixed(1)}%`
        );
      }
    }
  }
}
