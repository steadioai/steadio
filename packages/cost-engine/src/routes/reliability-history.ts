import { Hono } from "hono";
import { requireTeamAccess } from "../middleware/management-auth.js";
import {
  listSnapshots,
  recordSnapshot,
} from "../services/reliability-history.js";

// Reliability score history (ELEAA-746, F3). Team-scoped, requires a dashboard
// JWT. Feeds the score-over-time chart and lets an operator run the check on
// demand from the dashboard ("Run now").

export const reliabilityHistoryRoutes = new Hono();

// GET /api/reliability-history?teamId=&agentId=&limit=
// Chronological snapshots (oldest → newest) for the trend chart.
reliabilityHistoryRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");
  const limitRaw = parseInt(c.req.query("limit") ?? "90", 10);

  const snapshots = await listSnapshots(teamId, {
    ...(agentId ? { agentId } : {}),
    limit: Number.isFinite(limitRaw) ? limitRaw : 90,
  });
  return c.json({ snapshots });
});

// POST /api/reliability-history/run { teamId, agentId? } — run the check now and
// record a snapshot (source='manual'). Same regression detection + alerting as
// the cron path, so an operator can prove the alert wiring end-to-end.
reliabilityHistoryRoutes.post("/run", async (c) => {
  let body: { teamId?: string; agentId?: string } = {};
  try {
    body = (await c.req.json()) as { teamId?: string; agentId?: string };
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (!body.teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, body.teamId);
  if (auth instanceof Response) return auth;

  const { snapshot, regression, notified } = await recordSnapshot(body.teamId, {
    source: "manual",
    ...(body.agentId ? { agentId: body.agentId } : {}),
  });
  return c.json({ snapshot, regression, notified });
});
