import { Hono } from "hono";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { getDb } from "../db.js";
import { requireTeamAccess, requireTeamAdmin } from "../middleware/management-auth.js";
import { alertConfigs } from "@steadio/shared/schema";
import { isSafeWebhookUrl, assertSafeWebhookUrl } from "../services/webhook-safety.js";

export const alertRoutes = new Hono();

// GET /api/alerts?teamId=
alertRoutes.get("/", async (c) => {
  const teamId = c.req.query("teamId");
  if (!teamId) return c.json({ error: "teamId required" }, 400);
  const auth = requireTeamAccess(c, teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.select().from(alertConfigs).where(eq(alertConfigs.teamId, teamId));
  return c.json({ alerts: rows });
});

const createAlertSchema = z.object({
  teamId: z.string(),
  name: z.string().min(1),
  channel: z.enum(["webhook", "slack"]),
  webhookUrl: z
    .string()
    .url()
    .refine(isSafeWebhookUrl, {
      message:
        "webhookUrl must be a public http(s) URL — loopback/private/link-local/metadata hosts are not allowed",
    }),
  enabledEvents: z.array(z.string()).default(["budget_threshold", "runaway", "tool_failure", "guardrail_monitor"]),
});

// POST /api/alerts
alertRoutes.post("/", async (c) => {
  let body: unknown;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }

  const parsed = createAlertSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: "validation_error", details: parsed.error.format() }, 400);
  const auth = requireTeamAdmin(c, parsed.data.teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const rows = await db.insert(alertConfigs).values(parsed.data).returning();
  return c.json({ alert: rows[0] }, 201);
});

// DELETE /api/alerts/:id
alertRoutes.delete("/:id", async (c) => {
  const db = getDb();
  const existing = await db.select().from(alertConfigs).where(eq(alertConfigs.id, c.req.param("id"))).limit(1);
  if (!existing[0]) return c.json({ error: "not_found" }, 404);
  const auth = requireTeamAdmin(c, existing[0]["teamId"]);
  if (auth instanceof Response) return auth;

  await db.delete(alertConfigs).where(eq(alertConfigs.id, c.req.param("id")));
  return c.json({ success: true });
});

// POST /api/alerts/send — internal endpoint to fire an alert
alertRoutes.post("/send", async (c) => {
  let body: {
    teamId: string;
    event: string;
    payload: Record<string, unknown>;
  };
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid_json" }, 400); }
  const auth = requireTeamAdmin(c, body.teamId);
  if (auth instanceof Response) return auth;

  const db = getDb();
  const configs = await db
    .select()
    .from(alertConfigs)
    .where(eq(alertConfigs.teamId, body.teamId));

  const relevantConfigs = configs.filter(
    (cfg) => cfg["active"] && (cfg["enabledEvents"] as string[]).includes(body.event),
  );

  const results = await Promise.allSettled(
    relevantConfigs.map((cfg) =>
      sendAlertToEndpoint(cfg["webhookUrl"]!, cfg["channel"] as "webhook" | "slack", body.event, body.payload),
    ),
  );

  const sent = results.filter((r) => r.status === "fulfilled").length;
  return c.json({ sent, total: relevantConfigs.length });
});

async function sendAlertToEndpoint(
  webhookUrl: string,
  channel: "webhook" | "slack",
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  // Defense-in-depth: never POST to a private/metadata host even if a bad URL
  // was stored before the validator existed.
  assertSafeWebhookUrl(webhookUrl);
  const body =
    channel === "slack"
      ? {
          text: `*SteadIO Alert: ${event}*`,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `*${event}*\n${Object.entries(payload)
                  .map(([k, v]) => `• *${k}:* ${String(v)}`)
                  .join("\n")}`,
              },
            },
          ],
        }
      : { event, payload, timestamp: new Date().toISOString() };

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    throw new Error(`Alert webhook returned ${res.status}`);
  }
}
