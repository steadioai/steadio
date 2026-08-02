import { Hono } from "hono";
import { sql, and, eq, gte, isNull, desc } from "drizzle-orm";
import { getJwtSecret } from "../config/jwt.js";
import jwt, { type JwtPayload } from "jsonwebtoken";
import { getDb } from "../db.js";
import { costEvents, apiKeys, runawayEvents } from "@steadio/shared/schema";

export const analyticsRoutes = new Hono();

const JWT_SECRET = getJwtSecret();

type AuthClaims = JwtPayload & { teamId?: unknown };

function getBearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;

  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;

  return token;
}

function getAuthorizedTeamId(authorization: string | undefined): string | null {
  const token = getBearerToken(authorization);
  if (!token) return null;

  try {
    const claims = jwt.verify(token, JWT_SECRET) as AuthClaims;
    return typeof claims.teamId === "string" && claims.teamId.length > 0 ? claims.teamId : null;
  } catch {
    return null;
  }
}

// GET /api/analytics/summary?teamId=
analyticsRoutes.get("/summary", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const authorizedTeamId = getAuthorizedTeamId(c.req.header("authorization"));
  if (!authorizedTeamId) return c.json({ error: "unauthorized" }, 401);
  if (authorizedTeamId !== teamId) return c.json({ error: "forbidden" }, 403);

  const db = getDb();
  const now = new Date();

  const cutoff24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const cutoff7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const cutoff30d = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const [
    stats24h,
    stats7d,
    stats30d,
    activeKeyRows,
    topAgents,
    runawayCount,
    lifetimeStats,
    lastReqRows,
  ] = await Promise.all([
    db
      .select({
        requests: sql<number>`count(*)::int`,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.teamId, teamId), gte(costEvents.createdAt, cutoff24h))),

    db
      .select({
        requests: sql<number>`count(*)::int`,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.teamId, teamId), gte(costEvents.createdAt, cutoff7d))),

    db
      .select({
        requests: sql<number>`count(*)::int`,
        costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.teamId, teamId), gte(costEvents.createdAt, cutoff30d))),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(apiKeys)
      .where(and(eq(apiKeys.teamId, teamId), isNull(apiKeys.revokedAt))),

    db
      .select({
        agentId: costEvents.agentId,
        totalCostCents: sql<number>`sum(${costEvents.costCents})::int`,
        requestCount: sql<number>`count(*)::int`,
      })
      .from(costEvents)
      .where(and(eq(costEvents.teamId, teamId), gte(costEvents.createdAt, cutoff30d)))
      .groupBy(costEvents.agentId)
      .orderBy(desc(sql`sum(${costEvents.costCents})`))
      .limit(5),

    db
      .select({ count: sql<number>`count(*)::int` })
      .from(runawayEvents)
      .where(and(eq(runawayEvents.teamId, teamId), gte(runawayEvents.createdAt, cutoff30d))),

    db
      .select({ total: sql<number>`count(*)::int` })
      .from(costEvents)
      .where(eq(costEvents.teamId, teamId)),

    db
      .select({ createdAt: costEvents.createdAt })
      .from(costEvents)
      .where(eq(costEvents.teamId, teamId))
      .orderBy(desc(costEvents.createdAt))
      .limit(1),
  ]);

  return c.json({
    windows: {
      "24h": stats24h[0] ?? { requests: 0, costCents: 0 },
      "7d": stats7d[0] ?? { requests: 0, costCents: 0 },
      "30d": stats30d[0] ?? { requests: 0, costCents: 0 },
    },
    activeApiKeys: activeKeyRows[0]?.count ?? 0,
    topAgentsBySpend: topAgents,
    budgetAlertsTriggered: runawayCount[0]?.count ?? 0,
    totalRequestsLifetime: lifetimeStats[0]?.total ?? 0,
    lastRequestAt: lastReqRows[0]?.createdAt?.toISOString() ?? null,
  });
});
