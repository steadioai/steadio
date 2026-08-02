import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";
import { guardrailRules } from "@steadio/shared/schema";
import { DEFAULT_RULES } from "../guardrails/rules.js";
import type { GuardrailRuleConfig, GuardrailRuleType, GuardrailMode } from "../guardrails/types.js";

export const guardrailRuleRoutes = new Hono();

const VALID_RULE_TYPES: GuardrailRuleType[] = [
  "privileged_tool_call", "secret_egress", "pii_egress",
  "prompt_injection", "tool_poisoning", "runaway_loop",
  "content_moderation", "groundedness",
];

const VALID_MODES: GuardrailMode[] = ["alert", "throttle", "redact", "hold", "block"];

const createSchema = z.object({
  teamId: z.string(),
  ruleId: z.string().min(1).max(128),
  ruleType: z.enum(VALID_RULE_TYPES as [string, ...string[]]),
  mode: z.enum(VALID_MODES as [string, ...string[]]).default("alert"),
  enabled: z.boolean().default(true),
  name: z.string().min(1).max(256),
  description: z.string().max(1024).optional(),
  config: z.record(z.unknown()).default({}),
});

const updateSchema = z.object({
  mode: z.enum(VALID_MODES as [string, ...string[]]).optional(),
  enabled: z.boolean().optional(),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(1024).nullable().optional(),
  config: z.record(z.unknown()).optional(),
}).strict();

// GET /api/guardrail-rules/defaults — returns the built-in DEFAULT_RULES
guardrailRuleRoutes.get("/defaults", (c) => {
  return c.json({
    rules: DEFAULT_RULES.map((r) => ({
      ruleId: r.id,
      ruleType: r.type,
      mode: r.mode,
      enabled: r.enabled,
      description: r.description,
      config: r.config ?? {},
    })),
  });
});

// GET /api/guardrail-rules?teamId= — returns workspace rules + effective merged view
guardrailRuleRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(guardrailRules).where(eq(guardrailRules.teamId, teamId));

  const overrideMap = new Map(rows.map((r) => [r["ruleId"], r]));
  const effective = DEFAULT_RULES.map((dflt) => {
    const override = overrideMap.get(dflt.id);
    if (override) {
      return {
        ruleId: override["ruleId"],
        ruleType: override["ruleType"] as GuardrailRuleType,
        mode: override["mode"] as GuardrailMode,
        enabled: override["enabled"],
        name: override["name"],
        description: override["description"] ?? dflt.description,
        config: override["config"] as GuardrailRuleConfig,
        source: "workspace" as const,
        id: override["id"],
      };
    }
    return {
      ruleId: dflt.id,
      ruleType: dflt.type,
      mode: dflt.mode,
      enabled: dflt.enabled,
      name: dflt.id,
      description: dflt.description,
      config: dflt.config ?? {},
      source: "default" as const,
    };
  });

  // Add any workspace-only rules (custom ruleIds not in DEFAULT_RULES)
  const defaultIds = new Set(DEFAULT_RULES.map((r) => r.id));
  for (const row of rows) {
    if (!defaultIds.has(row["ruleId"])) {
      effective.push({
        ruleId: row["ruleId"],
        ruleType: row["ruleType"] as GuardrailRuleType,
        mode: row["mode"] as GuardrailMode,
        enabled: row["enabled"],
        name: row["name"],
        description: row["description"] ?? "",
        config: row["config"] as GuardrailRuleConfig,
        source: "workspace" as const,
        id: row["id"],
      });
    }
  }

  return c.json({ rules: rows, effective });
});

// GET /api/guardrail-rules/:id
guardrailRuleRoutes.get("/:id", async (c) => {
  const db = getDb();
  const rows = await db.select().from(guardrailRules).where(eq(guardrailRules.id, c.req.param("id"))).limit(1);
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAccess(c, rows[0]["teamId"]);
  if (auth instanceof Response) return auth;
  return c.json({ rule: rows[0] });
});

// POST /api/guardrail-rules
guardrailRuleRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  const auth = requireTeamAdmin(c, parsed.data.teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.insert(guardrailRules).values({
    teamId: parsed.data.teamId,
    ruleId: parsed.data.ruleId,
    ruleType: parsed.data.ruleType,
    mode: parsed.data.mode,
    enabled: parsed.data.enabled,
    name: parsed.data.name,
    description: parsed.data.description ?? null,
    config: parsed.data.config,
  }).returning();

  const rule = rows[0]!;
  return c.json({ rule }, 201);
});

// PATCH /api/guardrail-rules/:id
guardrailRuleRoutes.patch("/:id", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const db = getDb();
  const existing = await db.select().from(guardrailRules).where(eq(guardrailRules.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  const rows = await db
    .update(guardrailRules)
    .set({ ...parsed.data, updatedAt: new Date() })
    .where(eq(guardrailRules.id, c.req.param("id")))
    .returning();

  if (!rows[0]) return c.json({ error: "not_found" }, 404);

  return c.json({ rule: rows[0] });
});

// DELETE /api/guardrail-rules/:id
guardrailRuleRoutes.delete("/:id", async (c) => {
  const db = getDb();
  const existing = await db.select().from(guardrailRules).where(eq(guardrailRules.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  await db.delete(guardrailRules).where(eq(guardrailRules.id, c.req.param("id")));
  return c.json({ success: true });
});
