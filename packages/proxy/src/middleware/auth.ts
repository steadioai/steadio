import { createMiddleware } from "hono/factory";
import { createHash } from "node:crypto";
import type { Redis } from "ioredis";
import type { ProxyEnv } from "../env.js";

const CACHE_TTL_SECONDS = 300; // 5 minutes

interface ResolvedKey {
  teamId: string;
  keyId: string;
}

async function resolveFromDb(
  costEngineUrl: string,
  keyHash: string
): Promise<ResolvedKey | null> {
  try {
    const res = await fetch(`${costEngineUrl}/api/keys/resolve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyHash }),
    });
    if (!res.ok) return null;
    return res.json() as Promise<ResolvedKey>;
  } catch {
    return null;
  }
}

export function createAuthMiddleware(costEngineUrl: string, redis: Redis) {
  return createMiddleware<ProxyEnv>(async (c, next) => {
    const apiKey =
      c.req.header("X-Elevation-Key") ??
      c.req.header("Authorization")?.replace("Bearer ", "");

    if (!apiKey) {
      return c.json({ error: "missing_api_key" }, 401);
    }

    const keyHash = createHash("sha256").update(apiKey).digest("hex");
    const cacheKey = `apikey:${keyHash}`;

    let resolved: ResolvedKey | null = null;

    // Redis cache lookup — avoids DB round-trip on hot path
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        resolved = JSON.parse(cached) as ResolvedKey;
      }
    } catch {
      // Redis unavailable — fall through to DB
    }

    if (!resolved) {
      resolved = await resolveFromDb(costEngineUrl, keyHash);
      if (!resolved) {
        return c.json({ error: "invalid_or_revoked_key" }, 401);
      }
      try {
        await redis.set(
          cacheKey,
          JSON.stringify(resolved),
          "EX",
          CACHE_TTL_SECONDS
        );
      } catch {
        // Redis write failure is non-fatal
      }
    }

    c.set("teamId", resolved.teamId);
    c.set("apiKey", apiKey);

    await next();
  });
}
