import { Hono } from "hono";
import { z } from "zod";
import { sql, and, eq, gte } from "drizzle-orm";
import { getDb } from "../db.js";
import { requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";
import { budgets, costEvents } from "@steadio/shared/schema";

export const budgetRoutes = new Hono();

const ENFORCEMENT_MODES = {
  alert: {
    label: "Alert",
    description: "Fire webhook/Slack alerts when alertThresholdPercent is crossed. Requests are allowed through. No action is taken when the limit is reached beyond the threshold alert.",
  },
  throttle: {
    label: "Throttle",
    description: "When the budget limit is reached (spend >= limitCents), downgrade the request model to the configured throttleModel (falls back to gpt-4o-mini for OpenAI or claude-haiku-4-5 for Anthropic). The request is allowed through with the cheaper model. A warning is logged. Hard pre-limit throttling is on the roadmap.",
  },
  kill: {
    label: "Kill",
    description: "When the budget limit is reached (spend >= limitCents), reject the request with HTTP 429 and a BudgetExceeded error. The period reset time is included in the error response.",
  },
};

// GET /api/budgets/enforcement-modes — describes available enforcement modes
budgetRoutes.get("/enforcement-modes", (c) => {
  return c.json({ enforcementModes: ENFORCEMENT_MODES });
});

// GET /api/budgets?teamId=
budgetRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(budgets).where(eq(budgets.teamId, teamId));
  return c.json({ budgets: rows });
});

// GET /api/budgets/:id
budgetRoutes.get("/:id", async (c) => {
  const db = getDb();
  const rows = await db.select().from(budgets).where(eq(budgets.id, c.req.param("id"))).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAccess(c, rows[0]["teamId"]);
  if (auth instanceof Response) return auth;
  return c.json({ budget: rows[0] });
});

// GET /api/budgets/:id/status — real-time utilization for the dashboard
budgetRoutes.get("/:id/status", async (c) => {
  const db = getDb();
  const rows = await db.select().from(budgets).where(eq(budgets.id, c.req.param("id"))).limit(1);
  const budget = rows[0];
  if (!budget) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAccess(c, budget["teamId"]);
  if (auth instanceof Response) return auth;

  const now = new Date();
  let periodStart: Date;
  switch (budget["periodType"]) {
    case "daily": {
      const d = new Date(now); d.setUTCHours(0, 0, 0, 0); periodStart = d; break;
    }
    case "weekly": {
      const d = new Date(now); d.setUTCHours(0, 0, 0, 0);
      const day = d.getUTCDay() || 7; d.setUTCDate(d.getUTCDate() - day + 1); periodStart = d; break;
    }
    case "monthly": {
      const d = new Date(now); d.setUTCDate(1); d.setUTCHours(0, 0, 0, 0); periodStart = d; break;
    }
    default: {
      const d = new Date(now); d.setUTCDate(d.getUTCDate() - 30); periodStart = d;
    }
  }

  const conditions = [
    eq(costEvents.teamId, budget["teamId"]),
    gte(costEvents.createdAt, periodStart),
  ];
  if (budget["agentId"]) conditions.push(eq(costEvents.agentId, budget["agentId"]));

  const spendRows = await db
    .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::int` })
    .from(costEvents)
    .where(and(...conditions));

  const currentSpendCents = spendRows[0]?.total ?? 0;
  const utilizationPercent = budget["limitCents"] > 0
    ? (currentSpendCents / budget["limitCents"]) * 100
    : 0;

  const isAlertThresholdReached = utilizationPercent >= budget["alertThresholdPercent"];

  return c.json({
    budget,
    currentSpendCents,
    remainingCents: Math.max(0, budget["limitCents"] - currentSpendCents),
    utilizationPercent,
    isExceeded: currentSpendCents >= budget["limitCents"],
    isAlertThresholdReached,
    periodStart: periodStart.toISOString(),
  });
});

const createBudgetSchema = z.object({
  teamId: z.string(),
  agentId: z.string().nullable().optional(),
  name: z.string().min(1),
  periodType: z.enum(["daily", "weekly", "monthly", "rolling_30d"]),
  limitCents: z.number().int().positive(),
  alertThresholdPercent: z.number().int().min(1).max(100).optional(),
  enforcementMode: z.enum(["alert", "throttle", "kill"]).optional(),
  throttleModel: z.string().nullable().optional(),
});

// POST /api/budgets
budgetRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = createBudgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  const auth = requireTeamAdmin(c, parsed.data.teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const mode = parsed.data.enforcementMode ?? "alert";
  const rows = await db.insert(budgets).values({
    teamId: parsed.data.teamId,
    agentId: parsed.data.agentId ?? null,
    name: parsed.data.name,
    periodType: parsed.data.periodType,
    limitCents: parsed.data.limitCents,
    alertThresholdPercent: parsed.data.alertThresholdPercent ?? 80,
    enforcementMode: mode,
    throttleModel: parsed.data.throttleModel ?? null,
  }).returning();

  return c.json({ budget: rows[0] }, 201);
});

const updateBudgetSchema = z.object({
  name: z.string().min(1).optional(),
  periodType: z.enum(["daily", "weekly", "monthly", "rolling_30d"]).optional(),
  limitCents: z.number().int().positive().optional(),
  alertThresholdPercent: z.number().int().min(1).max(100).optional(),
  enforcementMode: z.enum(["alert", "throttle", "kill"]).optional(),
  throttleModel: z.string().nullable().optional(),
  hardLimit: z.boolean().optional(),
}).strict();

// PATCH /api/budgets/:id
budgetRoutes.patch("/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = updateBudgetSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const db = getDb();
  const existing = await db.select().from(budgets).where(eq(budgets.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  const rows = await db
    .update(budgets)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(budgets.id, c.req.param("id")))
    .returning();

  if (!rows[0]) return c.json({ error: "not_found" }, 404);

  return c.json({ budget: rows[0] });
});

// DELETE /api/budgets/:id
budgetRoutes.delete("/:id", async (c) => {
  const db = getDb();
  const existing = await db.select().from(budgets).where(eq(budgets.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  await db.delete(budgets).where(eq(budgets.id, c.req.param("id")));
  return c.json({ success: true });
});
