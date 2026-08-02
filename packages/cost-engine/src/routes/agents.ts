import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "../db.js";
import {
  getManagementAuth,
  isTeamAdminRole,
  requireTeamAccess,
  requireTeamAdmin,
} from "../middleware/management-auth.js";
import { agents } from "@steadio/shared/schema";
import {
  clearFreeze,
  listActiveFreezes,
  setFreeze,
} from "../services/freeze-service.js";
import { clearAgentAllowlistCache } from "../gateway/agent-resolver.js";

export const agentRoutes = new Hono();

// GET /api/agents?teamId=
agentRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(agents).where(eq(agents.teamId, teamId));
  return c.json({ agents: rows });
});

// ---------------------------------------------------------------------------
// Kill-switch / runtime circuit breaker (ELEAA-747).
//
// Freeze/unfreeze require team admin or operator (accepts {admin, operator} per
// ELEAA-694); a non-admin member gets 403. They act on the CALLER'S team (from
// the JWT), keyed by the external agent identifier the /v1 gateway sees on the
// x-steadio-agent-id header. Registered before GET /:id so "/freezes" isn't
// swallowed as an agent id.
// ---------------------------------------------------------------------------

// GET /api/agents/freezes — current active freezes for the caller's team.
agentRoutes.get("/freezes", async (c) => {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;
  const freezes = await listActiveFreezes(auth.teamId);
  return c.json({
    freezes: freezes.map((f) => ({
      id: f.id,
      agentId: f.agentId,
      toolName: f.toolName,
      reason: f.reason,
      actorUserId: f.actorUserId,
      createdAt: f.createdAt,
    })),
  });
});

const freezeBodySchema = z.object({
  toolName: z.string().optional(),
  reason: z.string().max(500).optional(),
});

// POST /api/agents/:agentId/freeze { toolName?, reason? }
agentRoutes.post("/:agentId/freeze", async (c) => {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;
  if (!isTeamAdminRole(auth.role)) return c.json({ error: "forbidden" }, 403);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = freezeBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  }

  const row = await setFreeze({
    teamId: auth.teamId,
    agentId: c.req.param("agentId"),
    toolName: parsed.data.toolName ?? null,
    reason: parsed.data.reason ?? null,
    actorUserId: auth.userId,
  });
  return c.json({
    freeze: {
      id: row.id,
      agentId: row.agentId,
      toolName: row.toolName,
      reason: row.reason,
      actorUserId: row.actorUserId,
      active: row.active,
      createdAt: row.createdAt,
    },
  });
});

// POST /api/agents/:agentId/unfreeze { toolName? }
agentRoutes.post("/:agentId/unfreeze", async (c) => {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;
  if (!isTeamAdminRole(auth.role)) return c.json({ error: "forbidden" }, 403);

  let body: unknown = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }
  const parsed = freezeBodySchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  }

  const cleared = await clearFreeze({
    teamId: auth.teamId,
    agentId: c.req.param("agentId"),
    toolName: parsed.data.toolName ?? null,
    actorUserId: auth.userId,
  });
  return c.json({ unfrozen: cleared.length, agentId: c.req.param("agentId") });
});

// GET /api/agents/:id
agentRoutes.get("/:id", async (c) => {
  const db = getDb();
  const rows = await db.select().from(agents).where(eq(agents.id, c.req.param("id"))).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAccess(c, rows[0]["teamId"]);
  if (auth instanceof Response) return auth;
  return c.json({ agent: rows[0] });
});

const createAgentSchema = z.object({
  teamId: z.string(),
  name: z.string().min(1),
  externalId: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  // Per-agent tool allowlist (ELEAA-748). Non-empty => positive-security firewall.
  allowedTools: z.array(z.string().min(1)).optional(),
});

// POST /api/agents
agentRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = createAgentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  const auth = requireTeamAdmin(c, parsed.data.teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.insert(agents).values({
    teamId: parsed.data.teamId,
    name: parsed.data.name,
    externalId: parsed.data.externalId ?? null,
    provider: parsed.data.provider ?? null,
    model: parsed.data.model ?? null,
    metadata: parsed.data.metadata ?? {},
    allowedTools: parsed.data.allowedTools ?? [],
  }).returning();

  return c.json({ agent: rows[0] }, 201);
});

const updateAgentSchema = z.object({
  name: z.string().min(1).optional(),
  model: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  guardrailMode: z.enum(["monitor", "block"]).optional(),
});

// PATCH /api/agents/:id
agentRoutes.patch("/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = updateAgentSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const db = getDb();
  const existing = await db.select().from(agents).where(eq(agents.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  const rows = await db
    .update(agents)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(agents.id, c.req.param("id")))
    .returning();

  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  clearAgentAllowlistCache();
  return c.json({ agent: rows[0] });
});
