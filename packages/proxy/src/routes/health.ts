import { Hono } from "hono";
import type { Redis } from "ioredis";

export function createHealthRouter(redis: Redis) {
  const app = new Hono();

  app.get("/health", async (c) => {
    let redisOk = false;
    try {
      await redis.ping();
      redisOk = true;
    } catch { /* ok */ }

    return c.json({
      status: redisOk ? "ok" : "degraded",
      redis: redisOk ? "ok" : "unavailable",
      version: "0.0.0",
    }, redisOk ? 200 : 207);
  });

  return app;
}
