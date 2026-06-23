import { Hono } from "hono";
import { desc, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import { v4 as uuid } from "uuid";
import type { Db } from "../db/client.js";
import { landingEvents } from "../db/schema.js";

export function createAnalyticsRouter(db: Db) {
  const app = new Hono();

  // POST /api/analytics/collect — landing page event beacon
  // Called from the landing page for every tracked event.
  // Stores events in landing_events; IP is hashed immediately, never stored raw.
  app.post("/api/analytics/collect", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "invalid_json" }, 400);
    }

    const event = typeof body.event === "string" ? body.event.slice(0, 128) : null;
    if (!event) return c.json({ error: "event_required" }, 400);

    const rawIp =
      c.req.header("cf-connecting-ip") ||
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "";
    const ipHash = rawIp
      ? createHash("sha256").update(rawIp).digest("hex").slice(0, 16)
      : null;

    const props = body.props && typeof body.props === "object" ? body.props : null;

    await db.insert(landingEvents).values({
      id: uuid(),
      event,
      page: strField(body.page),
      referrer: strField(body.referrer),
      utmSource: strField(body.utm_source),
      utmMedium: strField(body.utm_medium),
      utmCampaign: strField(body.utm_campaign),
      utmContent: strField(body.utm_content),
      utmTerm: strField(body.utm_term),
      props,
      ipHash,
      userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
    });

    return c.json({ ok: true }, 201);
  });

  // GET /api/analytics/summary — quick dashboard for traffic attribution
  app.get("/api/analytics/summary", async (c) => {
    const [totals] = await db
      .select({
        total: sql<number>`count(*)`,
        sources: sql<number>`count(distinct utm_source) filter (where utm_source is not null)`,
      })
      .from(landingEvents);

    const bySource = await db
      .select({
        source: landingEvents.utmSource,
        count: sql<number>`count(*)`,
      })
      .from(landingEvents)
      .groupBy(landingEvents.utmSource)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    const byEvent = await db
      .select({
        event: landingEvents.event,
        count: sql<number>`count(*)`,
      })
      .from(landingEvents)
      .groupBy(landingEvents.event)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    const recent = await db
      .select({
        event: landingEvents.event,
        utmSource: landingEvents.utmSource,
        utmCampaign: landingEvents.utmCampaign,
        createdAt: landingEvents.createdAt,
      })
      .from(landingEvents)
      .orderBy(desc(landingEvents.createdAt))
      .limit(50);

    return c.json({
      total: Number(totals?.total ?? 0),
      bySource,
      byEvent,
      recent,
    });
  });

  return app;
}

function strField(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim().slice(0, 512);
  return s.length > 0 ? s : null;
}
