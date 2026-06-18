import { Hono } from "hono";
import type { Redis } from "ioredis";

export function createHealthRouter(redis: Redis, costEngineUrl: string) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let redisOk = false;
    let costEngineOk = false;

    try {
      await redis.ping();
      redisOk = true;
    } catch { /* ok */ }

    try {
      const res = await fetch(`${costEngineUrl}/health`, { signal: AbortSignal.timeout(3000) });
      costEngineOk = res.ok;
    } catch { /* ok */ }

    const healthy = redisOk && costEngineOk;
    return c.json({
      status: healthy ? "ok" : "degraded",
      redis: redisOk ? "ok" : "unavailable",
      costEngine: costEngineOk ? "ok" : "unavailable",
      version: "0.0.0",
    }, healthy ? 200 : 207);
  });

  return app;
}
