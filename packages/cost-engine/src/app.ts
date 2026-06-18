import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import type { Db } from "./db/client.js";
import type { Redis } from "ioredis";
import { createProxyEventsRouter } from "./routes/proxy-events.js";
import { createAttributionRouter } from "./routes/attribution.js";
import { createBudgetsRouter } from "./routes/budgets.js";
import { createCostsRouter } from "./routes/costs.js";
import { createRunawaysRouter } from "./routes/runaways.js";
import { createCircuitBreakersRouter } from "./routes/circuit-breakers.js";
import { createAlertConfigsRouter } from "./routes/alert-configs.js";
import { createSseRouter } from "./routes/sse.js";
import { createApiKeysRouter } from "./routes/api-keys.js";

export function createApp(db: Db, redis: Redis) {
  const app = new Hono();

  app.use("*", logger());
  app.use("/api/*", cors());

  app.get("/health", async (c) => {
    let dbOk = false;
    try {
      await db.execute(sql`SELECT 1`);
      dbOk = true;
    } catch { /* ok */ }
    return c.json({
      status: dbOk ? "ok" : "degraded",
      db: dbOk ? "ok" : "unavailable",
      version: "0.0.0",
    }, dbOk ? 200 : 207);
  });

  app.route("/", createProxyEventsRouter(db, redis));
  app.route("/", createAttributionRouter(db));
  app.route("/", createBudgetsRouter(db, redis));
  app.route("/", createCostsRouter(db));
  app.route("/", createRunawaysRouter(db));
  app.route("/", createCircuitBreakersRouter(db, redis));
  app.route("/", createAlertConfigsRouter(db));
  app.route("/", createSseRouter(redis));
  app.route("/", createApiKeysRouter(db));

  return app;
}
