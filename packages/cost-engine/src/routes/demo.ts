import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql, and, eq, gte, desc } from "drizzle-orm";
import jwt from "jsonwebtoken";
import { getJwtSecret } from "../config/jwt.js";
import { getDb } from "../db.js";
import { costEvents, teams, users } from "@steadio/shared/schema";
import {
  seedDemoData,
  clearDemoData,
  DEMO_TEAM_SLUG,
  DEMO_USER_EMAIL,
  DEMO_USER_PASSWORD,
} from "../demo-seed.js";

export const DEMO_TEAM_ID = "demo-sandbox";

export const demoApiRoutes = new Hono();

demoApiRoutes.use("*", cors({ origin: "*", allowMethods: ["GET", "OPTIONS"] }));

demoApiRoutes.get("/data", async (c) => {
  const period = (c.req.query("period") ?? "7d") as string;
  const days = period === "30d" ? 30 : period === "24h" ? 1 : 7;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const hourCutoff = new Date(Date.now() - 60 * 60 * 1000);

  const db = getDb();

  try {
    const baseConditions = and(
      eq(costEvents.teamId, DEMO_TEAM_ID),
      gte(costEvents.createdAt, cutoff),
    );

    const [summary, byWorkflow, byAgent, byModel, recent] = await Promise.all([
      db
        .select({
          totalCostCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
          totalInputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::int`,
          totalOutputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::int`,
          requestCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(baseConditions),

      db
        .select({
          workflowId: costEvents.workflowId,
          totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
          requestCount: sql<number>`count(*)::int`,
          agentCount: sql<number>`count(distinct ${costEvents.agentId})::int`,
        })
        .from(costEvents)
        .where(baseConditions)
        .groupBy(costEvents.workflowId)
        .orderBy(desc(sql`sum(${costEvents.costCents})`))
        .limit(20),

      db
        .select({
          agentId: costEvents.agentId,
          totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
          requestCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(baseConditions)
        .groupBy(costEvents.agentId)
        .orderBy(desc(sql`sum(${costEvents.costCents})`))
        .limit(20),

      db
        .select({
          model: costEvents.model,
          provider: costEvents.provider,
          totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
          requestCount: sql<number>`count(*)::int`,
        })
        .from(costEvents)
        .where(baseConditions)
        .groupBy(costEvents.model, costEvents.provider)
        .orderBy(desc(sql`sum(${costEvents.costCents})`))
        .limit(10),

      db
        .select({
          agentId: costEvents.agentId,
          workflowId: costEvents.workflowId,
          model: costEvents.model,
          provider: costEvents.provider,
          inputTokens: costEvents.inputTokens,
          outputTokens: costEvents.outputTokens,
          costCents: costEvents.costCents,
          durationMs: costEvents.durationMs,
          createdAt: costEvents.createdAt,
        })
        .from(costEvents)
        .where(and(eq(costEvents.teamId, DEMO_TEAM_ID), gte(costEvents.createdAt, hourCutoff)))
        .orderBy(desc(costEvents.createdAt))
        .limit(30),
    ]);

    const requestCount = summary[0]?.requestCount ?? 0;
    if (requestCount === 0) {
      return c.json({ demo: true, seeded: false, period }, 200);
    }

    return c.json({
      demo: true,
      seeded: true,
      period,
      summary: {
        totalCost: (summary[0]?.totalCostCents ?? 0) / 100,
        requestCount,
        inputTokens: summary[0]?.totalInputTokens ?? 0,
        outputTokens: summary[0]?.totalOutputTokens ?? 0,
      },
      workflows: byWorkflow.map((w) => ({
        id: w.workflowId,
        totalCost: (w.totalCostCents ?? 0) / 100,
        requestCount: w.requestCount,
        agentCount: w.agentCount,
      })),
      agents: byAgent.map((a) => ({
        id: a.agentId,
        totalCost: (a.totalCostCents ?? 0) / 100,
        requestCount: a.requestCount,
      })),
      models: byModel.map((m) => ({
        model: m.model,
        provider: m.provider,
        totalCost: (m.totalCostCents ?? 0) / 100,
        requestCount: m.requestCount,
      })),
      recentEvents: recent.map((e) => ({
        agentId: e.agentId,
        workflowId: e.workflowId,
        model: e.model,
        provider: e.provider,
        inputTokens: e.inputTokens,
        outputTokens: e.outputTokens,
        costCents: e.costCents,
        durationMs: e.durationMs,
        createdAt: e.createdAt?.toISOString(),
      })),
    });
  } catch (err) {
    console.error("[demo-api] error:", err);
    return c.json({ demo: true, seeded: false, error: "Failed to fetch demo data" }, 500);
  }
});

// ─── Interactive demo environment (design-partner calls) ────────────────────

export const demoRoutes = new Hono();

const JWT_SECRET = getJwtSecret();

demoRoutes.post("/reset", async (c) => {
  const db = getDb();
  await clearDemoData(db);
  const ids = await seedDemoData(db);

  const token = jwt.sign(
    { sub: ids.userId, teamId: ids.teamId, role: "admin" },
    JWT_SECRET,
    { expiresIn: "7d" },
  );

  return c.json({
    message: "Demo data reset successfully",
    credentials: {
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
    },
    token,
    teamId: ids.teamId,
  });
});

demoRoutes.get("/credentials", async (c) => {
  const db = getDb();

  const teamRows = await db
    .select()
    .from(teams)
    .where(eq(teams.slug, DEMO_TEAM_SLUG))
    .limit(1);

  if (!teamRows[0]) {
    const ids = await seedDemoData(db);
    const token = jwt.sign(
      { sub: ids.userId, teamId: ids.teamId, role: "admin" },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    return c.json({
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
      token,
      teamId: ids.teamId,
    });
  }

  const userRows = await db
    .select()
    .from(users)
    .where(eq(users.email, DEMO_USER_EMAIL))
    .limit(1);

  if (!userRows[0]) {
    const ids = await seedDemoData(db);
    const token = jwt.sign(
      { sub: ids.userId, teamId: ids.teamId, role: "admin" },
      JWT_SECRET,
      { expiresIn: "7d" },
    );
    return c.json({
      email: DEMO_USER_EMAIL,
      password: DEMO_USER_PASSWORD,
      token,
      teamId: ids.teamId,
    });
  }

  const user = userRows[0];
  const token = jwt.sign(
    { sub: user.id, teamId: user.teamId, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" },
  );

  return c.json({
    email: DEMO_USER_EMAIL,
    password: DEMO_USER_PASSWORD,
    token,
    teamId: user.teamId,
  });
});
