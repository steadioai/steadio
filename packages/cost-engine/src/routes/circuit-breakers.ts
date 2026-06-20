import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import type { Redis } from "ioredis";
import { runaways } from "../db/schema.js";
import {
  getCircuitBreakerState,
  tripCircuitBreaker,
  resetCircuitBreaker,
} from "../services/runaway-detector.js";

export function createCircuitBreakersRouter(db: Db, redis: Redis) {
  const app = new Hono();

  // GET /api/circuit-breakers: list recent runaway events (last 100, newest first)
  app.get("/api/circuit-breakers", async (c) => {
    const rows = await db
      .select()
      .from(runaways)
      .orderBy(desc(runaways.detectedAt))
      .limit(100);

    // Enrich each row with live Redis state
    const enriched = await Promise.all(
      rows.map(async (r) => {
        const state = await getCircuitBreakerState(redis, r.agentId);
        return { ...r, circuitState: state.state };
      })
    );

    return c.json({ circuitBreakers: enriched });
  });

  // GET /api/circuit-breakers/:agentId: live state from Redis + recent history
  app.get("/api/circuit-breakers/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const state = await getCircuitBreakerState(redis, agentId);

    const history = await db
      .select()
      .from(runaways)
      .where(eq(runaways.agentId, agentId))
      .orderBy(desc(runaways.detectedAt))
      .limit(20);

    return c.json({ state, history });
  });

  // POST /api/circuit-breakers/:agentId/trip: manually open circuit
  app.post("/api/circuit-breakers/:agentId/trip", async (c) => {
    const agentId = c.req.param("agentId");
    const body = await c.req.json().catch(() => ({})) as { teamId?: string };
    const teamId = body.teamId ?? "unknown";

    await tripCircuitBreaker(redis, db, agentId, teamId);
    const state = await getCircuitBreakerState(redis, agentId);

    return c.json({ ok: true, state });
  });

  // DELETE /api/circuit-breakers/:agentId: reset circuit (close or half-open)
  app.delete("/api/circuit-breakers/:agentId", async (c) => {
    const agentId = c.req.param("agentId");
    const halfOpen = c.req.query("halfOpen") === "true";

    await resetCircuitBreaker(redis, agentId, halfOpen);
    const state = await getCircuitBreakerState(redis, agentId);

    return c.json({ ok: true, state });
  });

  return app;
}
