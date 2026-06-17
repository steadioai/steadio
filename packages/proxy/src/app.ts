import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Redis } from "ioredis";
import { authMiddleware } from "./middleware/auth.js";
import { taggerMiddleware } from "./middleware/tagger.js";
import { createBudgetCheckMiddleware } from "./middleware/budget-check.js";
import { createOpenAiRouter } from "./routes/openai.js";
import { createAnthropicRouter } from "./routes/anthropic.js";
import { createHealthRouter } from "./routes/health.js";
import type { ProxyConfig } from "./config.js";
import type { ProxyEnv } from "./env.js";

export function createApp(config: ProxyConfig, redis: Redis) {
  const app = new Hono<ProxyEnv>();

  app.use("*", logger());

  // Health — no auth
  app.route("/", createHealthRouter(redis));

  // All proxy routes require auth + tagging + budget check
  app.use("/openai/*", authMiddleware);
  app.use("/openai/*", taggerMiddleware);
  app.use("/openai/*", createBudgetCheckMiddleware(redis));
  app.route("/openai", createOpenAiRouter({
    openaiApiUrl: config.openaiApiUrl,
    costEngineUrl: config.costEngineUrl,
    redis,
  }));

  app.use("/anthropic/*", authMiddleware);
  app.use("/anthropic/*", taggerMiddleware);
  app.use("/anthropic/*", createBudgetCheckMiddleware(redis));
  app.route("/anthropic", createAnthropicRouter({
    anthropicApiUrl: config.anthropicApiUrl,
    costEngineUrl: config.costEngineUrl,
    redis,
  }));

  return app;
}
