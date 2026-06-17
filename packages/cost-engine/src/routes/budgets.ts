import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Redis } from "ioredis";
import { budgets } from "../db/schema.js";
import {
  getPeriodWindow,
  budgetRedisKey,
} from "../services/budget-enforcer.js";

export function createBudgetsRouter(db: Db, redis: Redis) {
  const app = new Hono();

  // GET /api/budgets?scope=agent&scopeId=
  app.get("/api/budgets", async (c) => {
    const scope = c.req.query("scope");
    const scopeId = c.req.query("scopeId");

    const conditions = [];
    if (scope) conditions.push(eq(budgets.scope, scope));
    if (scopeId) conditions.push(eq(budgets.scopeId, scopeId));

    const rows = await db
      .select()
      .from(budgets)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    // Enrich with current spend from Redis
    const enriched = await Promise.all(
      rows.map(async (b) => {
        const { start, end } = getPeriodWindow(b.period);
        const key = budgetRedisKey(b.scope, b.scopeId, b.period, start);
        const raw = await redis.get(key).catch(() => null);
        const currentSpendUsd = raw ? Number(raw) / 1_000_000 : 0;
        const capUsd = Number(b.capUsd);
        return {
          ...b,
          currentSpendUsd,
          capUsd,
          utilizationPercent:
            capUsd > 0 ? (currentSpendUsd / capUsd) * 100 : 0,
          periodStart: start.toISOString(),
          periodEnd: end.toISOString(),
        };
      })
    );

    return c.json({ budgets: enriched });
  });

  // POST /api/budgets
  app.post("/api/budgets", async (c) => {
    const body = await c.req.json() as {
      scope: string;
      scopeId: string;
      period: string;
      capUsd: number;
      warningThresholdPercent?: number;
      enforcementMode: string;
      throttleModelId?: string;
    };

    const id = uuidv4();
    await db.insert(budgets).values({
      id,
      scope: body.scope,
      scopeId: body.scopeId,
      period: body.period,
      capUsd: body.capUsd.toString(),
      warningThresholdPercent: body.warningThresholdPercent ?? 80,
      enforcementMode: body.enforcementMode,
      throttleModelId: body.throttleModelId ?? null,
    });

    const [created] = await db.select().from(budgets).where(eq(budgets.id, id));
    return c.json({ budget: created }, 201);
  });

  // DELETE /api/budgets/:id
  app.delete("/api/budgets/:id", async (c) => {
    const id = c.req.param("id");
    await db.delete(budgets).where(eq(budgets.id, id));
    return c.json({ ok: true });
  });

  return app;
}
