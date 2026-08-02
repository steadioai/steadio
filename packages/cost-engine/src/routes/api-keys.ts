import { Hono, type Context } from "hono";
import { eq } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import { getJwtSecret } from "../config/jwt.js";
import jwt from "jsonwebtoken";
import { getDb } from "../db.js";
import { apiKeys } from "@steadio/shared/schema";

export const apiKeyRoutes = new Hono();

const JWT_SECRET = getJwtSecret();

type AuthClaims = {
  sub?: string;
  teamId?: string;
  role?: string;
};

const getBearerToken = (authorization: string | undefined): string | null => {
  const [scheme, token] = authorization?.split(" ") ?? [];
  if (scheme !== "Bearer" || !token) return null;
  return token;
};

const getAuthClaims = (c: Context): AuthClaims | Response => {
  const token = getBearerToken(c.req.header("Authorization"));
  if (!token) return c.json({ error: "unauthorized" }, 401);

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    if (typeof decoded === "string") return c.json({ error: "unauthorized" }, 401);
    return decoded as AuthClaims;
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
};

// "operator" is an elevated Steadio-staff role and a superset of "admin", so it
// must satisfy the same team-admin gates (see management-auth.ts).
const TEAM_ADMIN_ROLES = new Set(["admin", "operator"]);

const requireTeamAdmin = (c: Context, teamId: string): AuthClaims | Response => {
  const claims = getAuthClaims(c);
  if (claims instanceof Response) return claims;
  if (!claims.role || !TEAM_ADMIN_ROLES.has(claims.role) || claims.teamId !== teamId) {
    return c.json({ error: "forbidden" }, 403);
  }
  return claims;
};

// POST /api/api-keys/:id/rotate
// Generates a new key value for the given API key record.
// The caller must present the new key immediately — it is never stored in plain text.
// Rotated keys take effect immediately; the old value stops working once the proxy's
// 60s auth cache expires.
apiKeyRoutes.post("/:id/rotate", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const existing = await db
    .select({ id: apiKeys.id, teamId: apiKeys.teamId, name: apiKeys.name, revokedAt: apiKeys.revokedAt })
    .from(apiKeys)
    .where(eq(apiKeys.id, id))
    .limit(1);

  const key = existing[0];
  if (!key) return c.json({ error: "not_found" }, 404);

  const auth = requireTeamAdmin(c, key.teamId);
  if (auth instanceof Response) return auth;

  if (key.revokedAt) {
    return c.json({ error: "key_revoked", message: "Revoked keys cannot be rotated" }, 409);
  }

  const rawKey = `st_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const updated = await db
    .update(apiKeys)
    .set({ keyHash, keyPrefix })
    .where(eq(apiKeys.id, id))
    .returning({
      id: apiKeys.id,
      teamId: apiKeys.teamId,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      createdAt: apiKeys.createdAt,
    });

  if (!updated[0]) return c.json({ error: "not_found" }, 404);

  return c.json({ apiKey: { ...updated[0], key: rawKey } });
});

// GET /api/api-keys/:id
apiKeyRoutes.get("/:id", async (c) => {
  const db = getDb();
  const rows = await db
    .select({
      id: apiKeys.id,
      teamId: apiKeys.teamId,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.id, c.req.param("id")))
    .limit(1);

  const key = rows[0];
  if (!key) return c.json({ error: "not_found" }, 404);

  const auth = requireTeamAdmin(c, key.teamId);
  if (auth instanceof Response) return auth;

  return c.json({ apiKey: key });
});

// DELETE /api/api-keys/:id — revoke
apiKeyRoutes.delete("/:id", async (c) => {
  const db = getDb();
  const existing = await db
    .select({ teamId: apiKeys.teamId })
    .from(apiKeys)
    .where(eq(apiKeys.id, c.req.param("id")))
    .limit(1);

  const key = existing[0];
  if (!key) return c.json({ error: "not_found" }, 404);

  const auth = requireTeamAdmin(c, key.teamId);
  if (auth instanceof Response) return auth;

  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(eq(apiKeys.id, c.req.param("id")))
    .returning({ id: apiKeys.id });

  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ success: true });
});
