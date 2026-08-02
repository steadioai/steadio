import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db.js";
import { getRedis } from "../redis.js";
import { requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";
import { runawayEvents } from "@steadio/shared/schema";

export const runawayRoutes = new Hono();

// GET /api/runaway?teamId=&agentId=&limit=
runawayRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);

  const db = getDb();
  const conditions = [eq(runawayEvents.teamId, teamId)];
  if (agentId) conditions.push(eq(runawayEvents.agentId, agentId));

  const rows = await db
    .select()
    .from(runawayEvents)
    .where(conditions.length > 1 ? and(...conditions) : conditions[0])
    .orderBy(desc(runawayEvents.createdAt))
    .limit(limit);

  return c.json({ events: rows });
});

// POST /api/runaway/:id/override — manually override a runaway detection
runawayRoutes.post("/:id/override", async (c) => {
  let body: { reason?: string } = {};
  try { body = await c.req.json<{ reason?: string }>(); } catch {}

  if (!body.reason) return c.json({ error: "reason required" }, 400);

  const db = getDb();
  const existing = await db.select().from(runawayEvents).where(eq(runawayEvents.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  const rows = await db
    .update(runawayEvents)
    .set({ overriddenAt: new Date(), overrideReason: body.reason })
    .where(eq(runawayEvents.id, c.req.param("id")))
    .returning();

  if (!rows[0]) return c.json({ error: "not_found" }, 404);

  // Reset circuit breaker in Redis (team-scoped keys)
  const event = rows[0];
  const redis = getRedis();
  await Promise.all([
    redis.del(`runaway:cooldown:${event.teamId}:${event.agentId}`),
    redis.del(`runaway:velocity:${event.teamId}:${event.agentId}`),
    redis.del(`runaway:loop:${event.teamId}:${event.agentId}`),
    redis.del(`runaway:halfopen:${event.teamId}:${event.agentId}`),
    redis.del(`runaway:baseline:${event.teamId}:${event.agentId}`),
  ]).catch(console.error);

  return c.json({ event: rows[0] });
});

// GET /api/runaway/:agentId/status?teamId=
runawayRoutes.get("/:agentId/status", async (c) => {
  const agentId = c.req.param("agentId");
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);

  const redis = getRedis();
  const cooldownTtl = await redis.ttl(`runaway:cooldown:${teamId}:${agentId}`);

  return c.json({
    agentId,
    teamId,
    isCircuitBroken: cooldownTtl > 0,
    cooldownUntil: cooldownTtl > 0
      ? new Date(Date.now() + cooldownTtl * 1000).toISOString()
      : null,
  });
});
