import type { Context, Next } from "hono";
import { createHash } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { getDb } from "../db.js";
import { apiKeys } from "@steadio/shared/schema";
import { UnauthorizedError } from "@steadio/shared";

const KEY_CACHE = new Map<string, { teamId: string; keyId: string; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function authMiddleware(c: Context, next: Next) {
  const steadioKey =
    c.req.header("x-steadio-key") ??
    c.req.header("x-api-key");

  if (!steadioKey) {
    return c.json(
      { error: "missing_api_key", message: "X-SteadIO-Key header required" },
      401,
    );
  }

  try {
    const { teamId, keyId } = await resolveApiKey(steadioKey);
    c.set("teamId", teamId);
    c.set("apiKeyId", keyId);
    await next();
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      return c.json({ error: err.code, message: err.message }, 401);
    }
    throw err;
  }
}

async function resolveApiKey(rawKey: string): Promise<{ teamId: string; keyId: string }> {
  const cached = KEY_CACHE.get(rawKey);
  if (cached && cached.expiresAt > Date.now()) {
    return { teamId: cached.teamId, keyId: cached.keyId };
  }

  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const db = getDb();

  const rows = await db
    .select({ id: apiKeys.id, teamId: apiKeys.teamId })
    .from(apiKeys)
    .where(eq(apiKeys.keyHash, keyHash))
    .limit(1);

  const row = rows[0];
  if (!row) throw new UnauthorizedError("Invalid API key");

  const activeRows = await db
    .select({ id: apiKeys.id, teamId: apiKeys.teamId })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, keyHash), isNull(apiKeys.revokedAt)))
    .limit(1);

  const active = activeRows[0];
  if (!active) throw new UnauthorizedError("API key revoked");

  // Awaited so the update completes before the Vercel function exits
  await db.update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, active.id))
    .catch(() => {});

  KEY_CACHE.set(rawKey, {
    teamId: active.teamId,
    keyId: active.id,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });

  return { teamId: active.teamId, keyId: active.id };
}
