import { Hono } from "hono";
import { eq, isNull, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiKeys } from "../db/schema.js";

export function createApiKeysRouter(db: Db) {
  const app = new Hono();

  // Resolve a hashed key to its team — called by the proxy on cache miss.
  // Returns 404 for unknown or revoked keys so the proxy can return 401.
  app.post("/api/keys/resolve", async (c) => {
    const body = await c.req.json<{ keyHash?: string }>();
    if (!body.keyHash) {
      return c.json({ error: "missing_key_hash" }, 400);
    }

    const [key] = await db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.keyHash, body.keyHash), isNull(apiKeys.revokedAt)))
      .limit(1);

    if (!key) {
      return c.json({ error: "invalid_or_revoked_key" }, 404);
    }

    return c.json({ teamId: key.teamId, keyId: key.id });
  });

  return app;
}
