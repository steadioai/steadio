import { Hono } from "hono";
import { and, eq, desc, gte, lte, ne } from "drizzle-orm";
import { getDb } from "../db.js";
import { guardrailEvents } from "@steadio/shared/schema";
import { requireTeamAccess } from "../middleware/management-auth.js";

// Management API for the reliability-events feed (ELEAA-640, Day 2).
// Requires a valid dashboard JWT. All reads are team-scoped.

export const guardrailEventsRoutes = new Hono();

// GET /api/guardrail-events?teamId=&agentId=&action=&direction=&ruleType=&limit=&from=&to=
guardrailEventsRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");
  const action = c.req.query("action");
  // direction/ruleType narrow the feed to a single detector lane so a live
  // verify (e.g. credential-leak response pass, ELEAA-923) is one call rather
  // than scan-the-feed: ?direction=response&ruleType=secret_egress.
  const direction = c.req.query("direction");
  const ruleType = c.req.query("ruleType");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10), 200);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;

  const db = getDb();
  const conditions = [
    eq(guardrailEvents.teamId, teamId),
    ne(guardrailEvents.action, "allow"), // allow is never persisted, but guard anyway
  ];
  if (agentId) conditions.push(eq(guardrailEvents.agentId, agentId));
  if (action && ["alert", "throttle", "hold", "block"].includes(action)) {
    conditions.push(
      eq(guardrailEvents.action, action as "alert" | "throttle" | "hold" | "block"),
    );
  }
  if (direction && ["request", "response"].includes(direction)) {
    conditions.push(eq(guardrailEvents.direction, direction));
  }
  if (ruleType) conditions.push(eq(guardrailEvents.ruleType, ruleType));
  if (from) conditions.push(gte(guardrailEvents.createdAt, from));
  if (to) conditions.push(lte(guardrailEvents.createdAt, to));

  const rows = await db
    .select()
    .from(guardrailEvents)
    .where(and(...conditions))
    .orderBy(desc(guardrailEvents.createdAt))
    .limit(limit);

  return c.json({ events: rows });
});
