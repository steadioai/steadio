import { Hono } from "hono";
import { eq, and, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { apiKeys } from "@steadio/shared/schema";

export const keyResolveRoutes = new Hono();

// Called by the proxy on cache miss to resolve a hashed API key to its team.
// Mounted before JWT middleware — this is an internal service-to-service call.
keyResolveRoutes.post("/resolve", async (c) => {
  const body = await c.req.json<{ keyHash?: string }>();
  if (!body.keyHash) {
    return c.json({ error: "missing_key_hash" }, 400);
  }

  const db = getDb();
  const [key] = await db
    .select({ id: apiKeys.id, teamId: apiKeys.teamId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, body.keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!key) {
    return c.json({ error: "invalid_or_revoked_key" }, 404);
  }

  return c.json({ teamId: key.teamId, keyId: key.id });
});
