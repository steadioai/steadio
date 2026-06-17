import { serve } from "@hono/node-server";
import Redis from "ioredis";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

const config = loadConfig();

const redis = new Redis(config.redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});

redis.on("error", (err: unknown) => {
  console.warn("[redis] connection error:", err);
});

const app = createApp(config, redis);

serve({ fetch: app.fetch, port: config.port }, () => {
  console.log(`[proxy] listening on port ${config.port}`);
});
