import { Hono } from "hono";
import type { MiddlewareHandler } from "hono";
import { sql, and, eq, gte, lte, desc, isNotNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { requireTeamAccess } from "../middleware/management-auth.js";
import { costEvents } from "@steadio/shared/schema";

export const attributionRoutes = new Hono();

const requireTeamAuthorization: MiddlewareHandler = async (c, next) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  return next();
};

// GET /api/attribution?teamId=&agentId=&period=7d&groupBy=agent
attributionRoutes.get("/", requireTeamAuthorization, async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const agentId = c.req.query("agentId");
  const period = c.req.query("period") ?? "7d";
  const groupBy = (c.req.query("groupBy") ?? "agent") as "agent" | "model" | "workflow" | "day";

  const { periodStart, periodEnd } = parsePeriod(period);

  const db = getDb();

  const conditions = [
    eq(costEvents.teamId, teamId),
    gte(costEvents.createdAt, periodStart),
    lte(costEvents.createdAt, periodEnd),
  ];

  if (agentId) conditions.push(eq(costEvents.agentId, agentId));

  let rows: Array<Record<string, unknown>>;

  if (groupBy === "agent") {
    rows = await db
      .select({
        agentId: costEvents.agentId,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        totalInputTokens: sql<number>`sum(${costEvents.inputTokens})::int`,
        totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})::int`,
        requestCount: sql<number>`count(*)::int`,
        avgCostCents: sql<number>`avg(${costEvents.costCents})::int`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.agentId)
      .orderBy(desc(sql`sum(${costEvents.costCents})`))
      .limit(100);
  } else if (groupBy === "model") {
    rows = await db
      .select({
        model: costEvents.model,
        provider: costEvents.provider,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        totalInputTokens: sql<number>`sum(${costEvents.inputTokens})::int`,
        totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})::int`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.model, costEvents.provider)
      .orderBy(desc(sql`sum(${costEvents.costCents})`));
  } else if (groupBy === "workflow") {
    rows = await db
      .select({
        workflowId: costEvents.workflowId,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(costEvents.workflowId)
      .orderBy(desc(sql`sum(${costEvents.costCents})`));
  } else {
    // groupBy day
    rows = await db
      .select({
        day: sql<string>`date_trunc('day', ${costEvents.createdAt})::text`,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(...conditions))
      .groupBy(sql`date_trunc('day', ${costEvents.createdAt})`)
      .orderBy(sql`date_trunc('day', ${costEvents.createdAt})`);
  }

  // Summary totals
  const totalsRows = await db
    .select({
      totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
      totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
      requestCount: sql<number>`count(*)::int`,
    })
    .from(costEvents)
    .where(and(...conditions));

  return c.json({
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    summary: totalsRows[0] ?? { totalCostCents: 0, totalInputTokens: 0, totalOutputTokens: 0, requestCount: 0 },
    breakdown: rows,
  });
});

// GET /api/attribution/workflows?teamId=&period=7d
attributionRoutes.get("/workflows", requireTeamAuthorization, async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const period = c.req.query("period") ?? "7d";
  const { periodStart, periodEnd } = parsePeriod(period);

  const db = getDb();

  const rows = await db
    .select({
      workflowId: costEvents.workflowId,
      totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
      totalInputTokens: sql<number>`sum(${costEvents.inputTokens})::int`,
      totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})::int`,
      requestCount: sql<number>`count(*)::int`,
      agentCount: sql<number>`count(distinct ${costEvents.agentId})::int`,
    })
    .from(costEvents)
    .where(
      and(
        eq(costEvents.teamId, teamId),
        gte(costEvents.createdAt, periodStart),
        lte(costEvents.createdAt, periodEnd),
        isNotNull(costEvents.workflowId),
      ),
    )
    .groupBy(costEvents.workflowId)
    .orderBy(desc(sql`sum(${costEvents.costCents})`))
    .limit(100);

  return c.json({
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    workflows: rows,
  });
});

// GET /api/attribution/workflows/:workflowId?teamId=&period=7d
attributionRoutes.get("/workflows/:workflowId", requireTeamAuthorization, async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const workflowId = c.req.param("workflowId");
  const period = c.req.query("period") ?? "7d";
  const { periodStart, periodEnd } = parsePeriod(period);

  const db = getDb();

  const conditions = and(
    eq(costEvents.teamId, teamId),
    eq(costEvents.workflowId, workflowId),
    gte(costEvents.createdAt, periodStart),
    lte(costEvents.createdAt, periodEnd),
  );

  const [summaryRows, agentBreakdown] = await Promise.all([
    db
      .select({
        totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
        totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
        requestCount: sql<number>`count(*)::int`,
        agentCount: sql<number>`count(distinct ${costEvents.agentId})::int`,
      })
      .from(costEvents)
      .where(conditions),
    db
      .select({
        agentId: costEvents.agentId,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        totalInputTokens: sql<number>`sum(${costEvents.inputTokens})::int`,
        totalOutputTokens: sql<number>`sum(${costEvents.outputTokens})::int`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(conditions)
      .groupBy(costEvents.agentId)
      .orderBy(desc(sql`sum(${costEvents.costCents})`)),
  ]);

  return c.json({
    period: { start: periodStart.toISOString(), end: periodEnd.toISOString() },
    workflowId,
    summary: summaryRows[0] ?? {
      totalCostCents: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      requestCount: 0,
      agentCount: 0,
    },
    agentBreakdown,
  });
});

// GET /api/attribution/export?teamId=&period=
attributionRoutes.get("/export", requireTeamAuthorization, async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const period = c.req.query("period") ?? "30d";
  const { periodStart, periodEnd } = parsePeriod(period);

  const db = getDb();
  const rows = await db
    .select()
    .from(costEvents)
    .where(
      and(
        eq(costEvents.teamId, teamId),
        gte(costEvents.createdAt, periodStart),
        lte(costEvents.createdAt, periodEnd),
      ),
    )
    .orderBy(desc(costEvents.createdAt))
    .limit(10000);

  const csvHeader = "id,agent_id,team_id,request_id,provider,model,input_tokens,output_tokens,cost_cents,duration_ms,created_at\n";
  const csvRows = rows
    .map((r) =>
      [r["id"], r["agentId"], r["teamId"], r["requestId"] ?? "", r["provider"], r["model"],
       r["inputTokens"], r["outputTokens"], r["costCents"], r["durationMs"] ?? "",
       r["createdAt"].toISOString()].join(","),
    )
    .join("\n");

  return new Response(csvHeader + csvRows, {
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="steadio-costs-${period}.csv"`,
    },
  });
});

function parsePeriod(period: string): { periodStart: Date; periodEnd: Date } {
  const periodEnd = new Date();
  const periodStart = new Date();

  const match = /^(\d+)([dhw])$/.exec(period);
  if (match) {
    const n = parseInt(match[1]!, 10);
    const unit = match[2];
    if (unit === "h") periodStart.setHours(periodStart.getHours() - n);
    else if (unit === "d") periodStart.setDate(periodStart.getDate() - n);
    else if (unit === "w") periodStart.setDate(periodStart.getDate() - n * 7);
  } else {
    // Default 7 days
    periodStart.setDate(periodStart.getDate() - 7);
  }

  return { periodStart, periodEnd };
}
