import { serve } from "@hono/node-server";
import Redis from "ioredis";
import { getDb } from "./db/client.js";
import { createApp } from "./app.js";

const port = Number(process.env["PORT"] ?? 3002);
const redisUrl = process.env["REDIS_URL"] ?? "redis://localhost:6379";

const redis = new Redis(redisUrl, {
  maxRetriesPerRequest: 1,
  enableOfflineQueue: false,
  lazyConnect: true,
});

redis.on("error", (err: unknown) => {
  console.warn("[redis] connection error:", err);
});

const db = getDb();
const app = createApp(db, redis);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[cost-engine] listening on port ${port}`);
});
