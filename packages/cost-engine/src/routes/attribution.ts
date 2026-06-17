import { Hono } from "hono";
import { sql, eq, and, gte, lte, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { costEvents } from "../db/schema.js";

export function createAttributionRouter(db: Db) {
  const app = new Hono();

  // GET /api/attribution/teams?period=7d
  app.get("/api/attribution/teams", async (c) => {
    const period = c.req.query("period") ?? "7d";
    const { from, to } = parsePeriod(period);

    const rows = await db
      .select({
        teamId: costEvents.teamId,
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        inputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        outputTokens: sql<number>`sum(${costEvents.outputTokens})`,
        requestCount: sql<number>`count(*)`,
        agentCount: sql<number>`count(distinct ${costEvents.agentId})`,
      })
      .from(costEvents)
      .where(and(gte(costEvents.recordedAt, from), lte(costEvents.recordedAt, to)))
      .groupBy(costEvents.teamId)
      .orderBy(desc(sql`sum(${costEvents.totalCostUsd}::numeric)`))
      .limit(50);

    return c.json({ teams: rows, period, from: from.toISOString(), to: to.toISOString() });
  });

  // GET /api/attribution/history?period=7d&agentId=&teamId=
  app.get("/api/attribution/history", async (c) => {
    const agentId = c.req.query("agentId");
    const teamId = c.req.query("teamId");
    const period = c.req.query("period") ?? "7d";
    const { from, to } = parsePeriod(period);

    // bucket by hour for 1d, by day for 7d/30d
    const bucketExpr = period === "1d"
      ? sql`date_trunc('hour', ${costEvents.recordedAt})`
      : sql`date_trunc('day', ${costEvents.recordedAt})`;

    const conditions = [
      gte(costEvents.recordedAt, from),
      lte(costEvents.recordedAt, to),
    ];
    if (agentId) conditions.push(eq(costEvents.agentId, agentId));
    if (teamId) conditions.push(eq(costEvents.teamId, teamId));

    const rows = await db
      .select({
        bucket: bucketExpr.as("bucket"),
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(bucketExpr)
      .orderBy(bucketExpr);

    return c.json({ history: rows, period, from: from.toISOString(), to: to.toISOString() });
  });

  // GET /api/attribution/agents/:agentId?period=7d
  app.get("/api/attribution/agents/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const period = c.req.query("period") ?? "7d";
    const { from, to } = parsePeriod(period);

    const conditions = [
      gte(costEvents.recordedAt, from),
      lte(costEvents.recordedAt, to),
      eq(costEvents.agentId, agentId),
    ];

    const [totals] = await db
      .select({
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        inputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        outputTokens: sql<number>`sum(${costEvents.outputTokens})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(and(...conditions));

    const byModel = await db
      .select({
        model: costEvents.model,
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        requestCount: sql<number>`count(*)`,
        inputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        outputTokens: sql<number>`sum(${costEvents.outputTokens})`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.model)
      .orderBy(desc(sql`sum(${costEvents.totalCostUsd}::numeric)`));

    const recent = await db
      .select()
      .from(costEvents)
      .where(and(...conditions))
      .orderBy(desc(costEvents.recordedAt))
      .limit(20);

    return c.json({
      agentId,
      period,
      totals: {
        totalCostUsd: totals?.totalCostUsd ?? 0,
        inputTokens: totals?.inputTokens ?? 0,
        outputTokens: totals?.outputTokens ?? 0,
        requestCount: totals?.requestCount ?? 0,
      },
      byModel,
      recent,
    });
  });

  // GET /api/attribution/agents?teamId=&period=7d
  app.get("/api/attribution/agents", async (c) => {
    const teamId = c.req.query("teamId");
    const period = c.req.query("period") ?? "7d";
    const { from, to } = parsePeriod(period);

    const conditions = [
      gte(costEvents.recordedAt, from),
      lte(costEvents.recordedAt, to),
    ];
    if (teamId) conditions.push(eq(costEvents.teamId, teamId));

    const rows = await db
      .select({
        agentId: costEvents.agentId,
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        inputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        outputTokens: sql<number>`sum(${costEvents.outputTokens})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.agentId)
      .orderBy(desc(sql`sum(${costEvents.totalCostUsd}::numeric)`))
      .limit(100);

    return c.json({ agents: rows, period, from: from.toISOString(), to: to.toISOString() });
  });

  // GET /api/attribution/summary?agentId=&period=7d
  app.get("/api/attribution/summary", async (c) => {
    const agentId = c.req.query("agentId");
    const teamId = c.req.query("teamId");
    const period = c.req.query("period") ?? "7d";
    const { from, to } = parsePeriod(period);

    const conditions = [
      gte(costEvents.recordedAt, from),
      lte(costEvents.recordedAt, to),
    ];
    if (agentId) conditions.push(eq(costEvents.agentId, agentId));
    if (teamId) conditions.push(eq(costEvents.teamId, teamId));

    const [totals] = await db
      .select({
        totalCostUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        inputTokens: sql<number>`sum(${costEvents.inputTokens})`,
        outputTokens: sql<number>`sum(${costEvents.outputTokens})`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(and(...conditions));

    const models = await db
      .select({
        model: costEvents.model,
        costUsd: sql<number>`sum(${costEvents.totalCostUsd}::numeric)`,
        requestCount: sql<number>`count(*)`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.model)
      .orderBy(desc(sql`sum(${costEvents.totalCostUsd}::numeric)`))
      .limit(10);

    return c.json({
      summary: {
        totalCostUsd: totals?.totalCostUsd ?? 0,
        inputTokens: totals?.inputTokens ?? 0,
        outputTokens: totals?.outputTokens ?? 0,
        requestCount: totals?.requestCount ?? 0,
        avgCostPerRequest:
          totals && Number(totals.requestCount) > 0
            ? Number(totals.totalCostUsd) / Number(totals.requestCount)
            : 0,
        topModels: models,
      },
      period,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  });

  return app;
}

function parsePeriod(period: string): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  if (period === "1d") {
    from.setDate(from.getDate() - 1);
  } else if (period === "30d") {
    from.setDate(from.getDate() - 30);
  } else {
    // default 7d
    from.setDate(from.getDate() - 7);
  }
  return { from, to };
}
