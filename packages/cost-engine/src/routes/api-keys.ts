import { Hono } from "hono";
import { randomBytes, createHash } from "node:crypto";
import { v4 as uuidv4 } from "uuid";
import { eq, isNull, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { apiKeys, teams } from "../db/schema.js";

export function createApiKeysRouter(db: Db) {
  const app = new Hono();

  // Resolve a hashed key to its team, called by the proxy on cache miss.
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

  // GET /api/keys?teamId= — list keys (no plaintext)
  app.get("/api/keys", async (c) => {
    const teamId = c.req.query("teamId");
    const conditions = [isNull(apiKeys.revokedAt)];
    if (teamId) conditions.push(eq(apiKeys.teamId, teamId));

    const rows = await db
      .select({
        id: apiKeys.id,
        teamId: apiKeys.teamId,
        name: apiKeys.name,
        createdAt: apiKeys.createdAt,
        revokedAt: apiKeys.revokedAt,
      })
      .from(apiKeys)
      .where(and(...conditions));

    return c.json({ keys: rows });
  });

  // POST /api/keys — create a key; auto-creates team if needed
  app.post("/api/keys", async (c) => {
    const body = await c.req.json<{ teamId?: string; name?: string }>();
    const teamId = body.teamId?.trim();
    const name = body.name?.trim() ?? "Default key";

    if (!teamId) {
      return c.json({ error: "teamId is required" }, 400);
    }

    // Upsert team
    const existingTeam = await db
      .select()
      .from(teams)
      .where(eq(teams.id, teamId))
      .limit(1);

    if (existingTeam.length === 0) {
      await db.insert(teams).values({ id: teamId, name: teamId });
    }

    // Generate key: el_<teamId>_<32 random hex chars>
    const suffix = randomBytes(16).toString("hex");
    const plaintext = `el_${teamId}_${suffix}`;
    const keyHash = createHash("sha256").update(plaintext).digest("hex");
    const id = uuidv4();

    await db.insert(apiKeys).values({ id, keyHash, teamId, name });

    return c.json(
      {
        key: plaintext,
        id,
        teamId,
        name,
        createdAt: new Date().toISOString(),
      },
      201
    );
  });

  // DELETE /api/keys/:id — soft-revoke
  app.delete("/api/keys/:id", async (c) => {
    const id = c.req.param("id");
    await db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(eq(apiKeys.id, id));
    return c.json({ ok: true });
  });

  return app;
}
