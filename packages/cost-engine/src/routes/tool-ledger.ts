import { Hono } from "hono";
import { and, eq, desc, gte, lte, sql } from "drizzle-orm";
import { getDb } from "../db.js";
import { toolLedger } from "@steadio/shared/schema";
import { requireTeamAccess } from "../middleware/management-auth.js";

// Management API for the NSA-compliant tool ledger (ELEAA-748). Lets an auditor
// pull the record of every tool call an agent made — allowed ones included, which
// is what the guardrail-events feed intentionally omits. Requires a dashboard JWT;
// all reads are team-scoped, mirroring /api/guardrail-events.

export const toolLedgerRoutes = new Hono();

const STATUSES = ["allowed", "blocked", "held", "throttled", "alerted"];

// GET /api/tool-ledger?teamId=&agentId=&tool=&status=&limit=&from=&to=
toolLedgerRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");
  const tool = c.req.query("tool");
  const status = c.req.query("status");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 500);
  const from = c.req.query("from") ? new Date(c.req.query("from")!) : undefined;
  const to = c.req.query("to") ? new Date(c.req.query("to")!) : undefined;

  const db = getDb();
  const conditions = [eq(toolLedger.teamId, teamId)];
  if (agentId) conditions.push(eq(toolLedger.agentId, agentId));
  if (tool) conditions.push(eq(toolLedger.toolName, tool));
  if (status && STATUSES.includes(status)) conditions.push(eq(toolLedger.resultStatus, status));
  if (from && !Number.isNaN(from.getTime())) conditions.push(gte(toolLedger.ts, from));
  if (to && !Number.isNaN(to.getTime())) conditions.push(lte(toolLedger.ts, to));

  const rows = await db
    .select()
    .from(toolLedger)
    .where(and(...conditions))
    .orderBy(desc(toolLedger.ts))
    .limit(limit);

  return c.json({ entries: rows });
});

// GET /api/tool-ledger/observed-tools?teamId=&agentId=
toolLedgerRoutes.get("/observed-tools", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const agentId = c.req.query("agentId");

  const db = getDb();
  const conditions = [eq(toolLedger.teamId, teamId)];
  if (agentId) conditions.push(eq(toolLedger.agentId, agentId));

  const rows = await db
    .select({
      toolName: toolLedger.toolName,
      callCount: sql<number>`count(*)::int`.as("call_count"),
    })
    .from(toolLedger)
    .where(and(...conditions))
    .groupBy(toolLedger.toolName)
    .orderBy(sql`count(*) desc`)
    .limit(200);

  return c.json({ tools: rows });
});
