import { Redis } from "ioredis";

let _redis: Redis | null = null;

export function getRedis(): Redis {
  if (!_redis) {
    _redis = new Redis(process.env["REDIS_URL"] ?? "redis://localhost:6379", {
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      connectTimeout: 2000,
      commandTimeout: 1000,
    });

    _redis.on("error", (err) => {
      console.error("[cost-engine/redis] connection error", err.message);
    });
  }
  return _redis;
}
