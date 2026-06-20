import { Hono } from "hono";
import { logger } from "hono/logger";
import type { Redis } from "ioredis";
import { createAuthMiddleware } from "./middleware/auth.js";
import { taggerMiddleware } from "./middleware/tagger.js";
import { createBudgetCheckMiddleware } from "./middleware/budget-check.js";
import { createOpenAiRouter } from "./routes/openai.js";
import { createAnthropicRouter } from "./routes/anthropic.js";
import { createHealthRouter } from "./routes/health.js";
import type { ProxyConfig } from "./config.js";
import type { ProxyEnv } from "./env.js";

export function createApp(config: ProxyConfig, redis: Redis) {
  const app = new Hono<ProxyEnv>();
  const authMiddleware = createAuthMiddleware(config.costEngineUrl, redis);

  app.use("*", logger());

  // Global error handler: never leak stack traces
  app.onError((err: Error, c) => {
    console.error("[proxy] unhandled error:", err);
    return c.json({ error: "internal_error", message: "An unexpected error occurred." }, 500);
  });

  // Health: no auth
  app.route("/", createHealthRouter(redis, config.costEngineUrl));

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

  // Catch-all: explain valid proxy paths instead of returning an empty 404
  app.all("*", (c) => {
    return c.json(
      {
        error: "not_found",
        message: `No route matched ${c.req.method} ${c.req.path}`,
        valid_paths: [
          "GET  /health",
          "ANY  /openai/<path>   — OpenAI-compatible requests",
          "ANY  /anthropic/<path> — Anthropic-compatible requests",
        ],
        docs: "https://github.com/steadioai/steadio/blob/main/docs/quick-start.md",
      },
      404
    );
  });

  return app;
}
