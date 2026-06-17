import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import type { Db } from "./db/client.js";
import type { Redis } from "ioredis";
import { createProxyEventsRouter } from "./routes/proxy-events.js";
import { createAttributionRouter } from "./routes/attribution.js";
import { createBudgetsRouter } from "./routes/budgets.js";
import { createCostsRouter } from "./routes/costs.js";

export function createApp(db: Db, redis: Redis) {
  const app = new Hono();

  app.use("*", logger());
  app.use("/api/*", cors());

  app.get("/health", (c) => c.json({ status: "ok", version: "0.0.0" }));

  app.route("/", createProxyEventsRouter(db, redis));
  app.route("/", createAttributionRouter(db));
  app.route("/", createBudgetsRouter(db, redis));
  app.route("/", createCostsRouter(db));

  return app;
}
