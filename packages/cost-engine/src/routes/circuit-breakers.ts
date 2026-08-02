import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { getDb } from "../db.js";
import { getRedis } from "../redis.js";
import { RunawayDetector } from "../gateway/runaway-detector.js";
import { runawayEvents } from "@steadio/shared/schema";

export const circuitBreakerRoutes = new Hono();

circuitBreakerRoutes.get("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const detector = new RunawayDetector(getRedis());
  const state = await detector.getCircuitState(agentId);

  const db = getDb();
  const history = await db
    .select()
    .from(runawayEvents)
    .where(eq(runawayEvents.agentId, agentId))
    .orderBy(desc(runawayEvents.createdAt))
    .limit(20);

  return c.json({ state: { state }, history });
});

circuitBreakerRoutes.delete("/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const detector = new RunawayDetector(getRedis());
  await detector.resetCircuitBreaker(agentId);
  const state = await detector.getCircuitState(agentId);
  return c.json({ ok: true, state: { state } });
});
