import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb } from "../db.js";
import { users } from "@steadio/shared/schema";
import { getManagementAuth } from "../middleware/management-auth.js";

// Authenticated account self-service (ELEAA-869). Mounted BELOW the /api/* JWT gate
// in app.ts, so every handler here already has a verified team-bound token.
export const accountRoutes = new Hono();

// POST /api/account/change-password — a signed-in user changes their own password.
// Requires the current password (so a stolen/left-open session can't silently
// re-key the account), then re-hashes the new one.
accountRoutes.post("/change-password", async (c) => {
  const auth = getManagementAuth(c);
  if (auth instanceof Response) return auth;

  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = z.object({
    currentPassword: z.string().min(1),
    newPassword: z.string().min(8),
  }).safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);

  const db = getDb();
  const rows = await db.select().from(users).where(eq(users.id, auth.userId)).limit(1);
  const user = rows[0];
  if (!user) return c.json({ error: "not_found" }, 404);

  if (!(await bcrypt.compare(parsed.data.currentPassword, user.passwordHash))) {
    return c.json({ error: "invalid_credentials", message: "Current password is incorrect" }, 401);
  }

  const passwordHash = await bcrypt.hash(parsed.data.newPassword, 12);
  await db.update(users).set({ passwordHash, updatedAt: new Date() }).where(eq(users.id, user.id));

  return c.json({ ok: true });
});
