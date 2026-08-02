import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { getDb } from "../db.js";
import { evidence } from "@steadio/shared/schema";
import { requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";

const VALID_TYPES = ["command_output", "event_delta", "url_check", "screenshot_ref"] as const;

export const evidenceRoutes = new Hono();

// POST /api/evidence — create an immutable evidence record (admin/operator only)
evidenceRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const { teamId, issueRef, type, payload, producerRole } = body;

  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAdmin(c, teamId);
  if (auth instanceof Response) return auth;

  if (!issueRef) return c.json({ error: "issueRef required" }, 400);
  if (!type || !VALID_TYPES.includes(type)) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(", ")}` }, 400);
  }
  if (payload === undefined || payload === null) {
    return c.json({ error: "payload required" }, 400);
  }
  if (!producerRole) return c.json({ error: "producerRole required" }, 400);

  const db = getDb();
  const [row] = await db
    .insert(evidence)
    .values({ teamId, issueRef, type, payload, producerRole })
    .returning();

  return c.json({ evidence: row }, 201);
});

// GET /api/evidence?teamId=&issueRef=&type=&limit=
evidenceRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const issueRef = c.req.query("issueRef");
  const type = c.req.query("type");
  const rawLimit = parseInt(c.req.query("limit") ?? "100", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 100, 1), 500);

  const conditions = [eq(evidence.teamId, teamId)];
  if (issueRef) conditions.push(eq(evidence.issueRef, issueRef));
  if (type && VALID_TYPES.includes(type as typeof VALID_TYPES[number])) {
    conditions.push(eq(evidence.type, type));
  }

  const db = getDb();
  const rows = await db
    .select()
    .from(evidence)
    .where(and(...conditions))
    .orderBy(desc(evidence.createdAt))
    .limit(limit);

  return c.json({ evidence: rows });
});

// GET /api/evidence/:id — retrieve a single evidence record
evidenceRoutes.get("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDb();

  const rows = await db
    .select()
    .from(evidence)
    .where(eq(evidence.id, id))
    .limit(1);
  if (!rows.length) return c.json({ error: "not_found" }, 404);

  const row = rows[0]!;
  const auth = requireTeamAccess(c, row.teamId);
  if (auth instanceof Response) return auth;

  return c.json({ evidence: row });
});

// PUT, PATCH, DELETE — reject mutations (immutability enforcement)
evidenceRoutes.put("/:id", (c) => {
  return c.json({ error: "evidence records are immutable" }, 405);
});

evidenceRoutes.patch("/:id", (c) => {
  return c.json({ error: "evidence records are immutable" }, 405);
});

evidenceRoutes.delete("/:id", (c) => {
  return c.json({ error: "evidence records are immutable" }, 405);
});
