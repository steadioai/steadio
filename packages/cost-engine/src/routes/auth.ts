import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getJwtSecret } from "../config/jwt.js";
import jwt from "jsonwebtoken";
import { randomBytes, createHash } from "node:crypto";
import { getDb } from "../db.js";
import { users, teams, apiKeys, guardrailRules } from "@steadio/shared/schema";
import { managementAuthMiddleware, requireTeamAdmin } from "../middleware/management-auth.js";

export const authRoutes = new Hono();

const JWT_SECRET = getJwtSecret();
const JWT_EXPIRES_IN = "7d";

// Derive a URL-safe base slug (matches teams schema `[a-z0-9-]`), capped to leave
// room for the uniqueness suffix appended below.
function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return base || "team";
}

// POST /api/auth/register
authRoutes.post("/register", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = z.object({
    email: z.string().email(),
    name: z.string().min(1),
    password: z.string().min(8),
    source: z.string().max(32).optional(),
    utm: z.object({
      utm_source: z.string().max(64).optional(),
      utm_medium: z.string().max(64).optional(),
      utm_campaign: z.string().max(128).optional(),
      ref: z.string().max(64).optional(),
    }).optional(),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  // Auto-mint a default st_ key in the SAME transaction as the team+user (ELEAA-773).
  // Signup ends holding a working key instead of sending the user hunting through
  // /onboarding for a "Generate API Key" button. The raw key is returned to the
  // client ONCE (below) and only its hash is stored — never recoverable after.
  const rawKey = `st_${randomBytes(32).toString("hex")}`;
  const keyHash = createHash("sha256").update(rawKey).digest("hex");
  const keyPrefix = rawKey.slice(0, 12);

  const db = getDb();
  let rows;
  try {
    rows = await db.transaction(async (tx) => {
      const base = slugify(parsed.data.name || parsed.data.email.split("@")[0] || "team");
      const slug = `${base}-${randomBytes(3).toString("hex")}`;
      const teamMeta: Record<string, unknown> = {};
      if (parsed.data.utm) {
        teamMeta["signup_attribution"] = parsed.data.utm;
      }
      const teamRows = await tx.insert(teams).values({
        name: parsed.data.name ? `${parsed.data.name}'s Team` : `${base}'s Team`,
        slug,
        ...(Object.keys(teamMeta).length > 0 ? { metadata: teamMeta } : {}),
      }).returning({ id: teams.id });
      const teamId = teamRows[0]!.id;

      const userRows = await tx.insert(users).values({
        email: parsed.data.email,
        name: parsed.data.name,
        passwordHash,
        role: "admin",
        teamId,
      }).returning({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        teamId: users.teamId,
      });

      // Default key, same transaction — a failed key insert rolls back the whole
      // signup (no user without a key, no key without a user).
      const keyRows = await tx.insert(apiKeys).values({
        teamId,
        keyHash,
        keyPrefix,
        name: "Default",
      }).returning({ id: apiKeys.id });

      return { user: userRows[0]!, apiKeyId: keyRows[0]!.id };
    });
  } catch (err: unknown) {
    // Postgres unique_violation = 23505 (email already taken — the transaction rolls
    // back the just-created team, so no orphan rows are left behind).
    const pg = err as { code?: string };
    if (pg.code === "23505") {
      return c.json({ error: "email_taken", message: "An account with this email already exists" }, 409);
    }
    throw err;
  }

  const { user, apiKeyId } = rows;
  const token = jwt.sign({ sub: user.id, teamId: user.teamId, role: user.role, capabilities: ["joins:read"] }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  // Starter guardrail: every self-serve signup gets a prefilled "Require approval
  // for external action" rule in hold mode (ELEAA-1771 §P0-2). The unique index
  // on (team_id, rule_id) makes this idempotent. Fire-and-forget — a guardrail
  // setup failure must never block signup.
  void db
    .insert(guardrailRules)
    .values({
      teamId: user.teamId!,
      ruleId: "starter_approval_rule",
      ruleType: "privileged_tool_call",
      mode: "hold",
      enabled: true,
      name: "Require approval for external action",
      description: "Holds risky tool calls for human approval before they execute. Created automatically with your workspace.",
      config: {},
    })
    .onConflictDoNothing()
    .catch((err) => console.error("[register] starter guardrail creation failed:", err));

  // Return the raw key ONCE — it is not stored and cannot be shown again.
  return c.json({ user, token, apiKey: rawKey }, 201);
});

// POST /api/auth/login
authRoutes.post("/login", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = z.object({
    email: z.string().email(),
    password: z.string(),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: "validation_error" }, 400);

  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.email, parsed.data.email)).limit(1);
  const user = rows[0];

  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return c.json({ error: "invalid_credentials", message: "Email or password incorrect" }, 401);
  }

  const capabilities = (user as { capabilities?: string[] }).capabilities ?? [];
  const token = jwt.sign({ sub: user.id, teamId: user.teamId, role: user.role, capabilities }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });

  return c.json({
    user: { id: user.id, email: user.email, name: user.name, role: user.role, teamId: user.teamId },
    token,
  });
});

// POST /api/auth/invite
authRoutes.post("/invite", managementAuthMiddleware, async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = z.object({
    email: z.string().email(),
    name: z.string().optional(),
    teamId: z.string(),
    role: z.enum(["admin", "viewer"]).default("viewer"),
  }).safeParse(body);

  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const auth = requireTeamAdmin(c, parsed.data.teamId);
  if (auth instanceof Response) return auth;

  // Create a placeholder user with a temp password (must be reset on first login)
  const tempPassword = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  const db = getDb();
  const inviteRows = await db.insert(users).values({
    email: parsed.data.email,
    name: parsed.data.name ?? null,
    passwordHash,
    role: parsed.data.role,
    teamId: parsed.data.teamId,
  }).returning({ id: users.id, email: users.email });

  return c.json({ user: inviteRows[0], tempPassword, message: "Share tempPassword with the invitee — they must change it on first login" }, 201);
});
