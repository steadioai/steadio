import { Hono } from "hono";
import { requireTeamAccess } from "../middleware/management-auth.js";
import { listIncidents } from "../services/incident-service.js";

// Management API for the incident timeline (ELEAA-680, Track H).
// Incidents are a root-cause grouping over persisted guardrail_events; this
// endpoint requires a valid dashboard JWT and is team-scoped.

export const incidentsRoutes = new Hono();

// GET /api/incidents?teamId=&agentId=&ruleId=&action=&limit=
incidentsRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");
  const ruleId = c.req.query("ruleId");
  const action = c.req.query("action");
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  const incidents = await listIncidents(teamId, {
    ...(agentId ? { agentId } : {}),
    ...(ruleId ? { ruleId } : {}),
    ...(action ? { action } : {}),
    limit: Number.isFinite(limit) ? limit : 50,
  });
  return c.json({ incidents });
});
