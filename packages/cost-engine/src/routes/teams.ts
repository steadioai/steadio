import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db.js";
import { getManagementAuth, requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";
import { teams, apiKeys } from "@steadio/shared/schema";
import { createHash, randomBytes } from "node:crypto";
export const teamsRoutes = new Hono();

// GET /api/teams
teamsRoutes.get("/", async (c) => {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(teams).where(eq(teams.id, auth.teamId));
  return c.json({ teams: rows });
});

// GET /api/teams/:id
teamsRoutes.get("/:id", async (c) => {
  const auth = requireTeamAccess(c, c.req.param("id"));
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(teams).where(eq(teams.id, c.req.param("id"))).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  return c.json({ team: rows[0] });
});

const createTeamSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/),
});

// POST /api/teams
teamsRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = createTeamSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const db = getDb();
  const rows = await db.insert(teams).values(parsed.data).returning();
  return c.json({ team: rows[0] }, 201);
});

// POST /api/teams/:id/api-keys — create a new API key for the team
teamsRoutes.post("/:id/api-keys", async (c) => {
  const teamId = c.req.param("id");
  const auth = requireTeamAdmin(c, teamId);
  if (auth instanceof Response) return auth;

  // `source` carries the demo a self-serve visitor arrived from (ELEAA-769). The
  // guardrails-demo "start free now" CTA appends ?src=guardrails to the signup
  // URL; the dashboard forwards it here so a real key mint can be attributed to
  // the demo that drove it. Absent/unknown source -> no activation event (a normal
  // dashboard key add is not a self-serve activation).
  let body: { name?: string; source?: string } = {};
  try { body = await c.req.json<{ name?: string; source?: string }>(); } catch {}

  const rawKey = `st_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const db = getDb();
  const rows = await db.insert(apiKeys).values({
    teamId,
    keyHash,
    keyPrefix,
    name: body.name ?? "Default",
  }).returning({ id: apiKeys.id, keyPrefix: apiKeys.keyPrefix, name: apiKeys.name, createdAt: apiKeys.createdAt });

  // Return the raw key ONCE — not stored
  return c.json({ apiKey: { ...rows[0], key: rawKey } }, 201);
});

// GET /api/teams/:id/api-keys
teamsRoutes.get("/:id/api-keys", async (c) => {
  const teamId = c.req.param("id");
  const auth = requireTeamAdmin(c, teamId);
  if (auth instanceof Response) return auth;
  const db = getDb();
  const rows = await db
    .select({
      id: apiKeys.id,
      keyPrefix: apiKeys.keyPrefix,
      name: apiKeys.name,
      revokedAt: apiKeys.revokedAt,
      lastUsedAt: apiKeys.lastUsedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.teamId, teamId));
  return c.json({ apiKeys: rows });
});

// DELETE /api/teams/:teamId/api-keys/:keyId
teamsRoutes.delete("/:teamId/api-keys/:keyId", async (c) => {
  const auth = requireTeamAdmin(c, c.req.param("teamId"));
  if (auth instanceof Response) return auth;

  const db = getDb();
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, c.req.param("keyId")));
  return c.json({ success: true });
});
