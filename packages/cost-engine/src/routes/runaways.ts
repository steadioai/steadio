import { Hono } from "hono";
import { eq, desc, and } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { runaways } from "../db/schema.js";

export function createRunawaysRouter(db: Db) {
  const app = new Hono();

  // GET /api/runaways?agentId=&teamId=&limit=50
  app.get("/api/runaways", async (c) => {
    const agentId = c.req.query("agentId");
    const teamId = c.req.query("teamId");
    const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);

    const conditions = [];
    if (agentId) conditions.push(eq(runaways.agentId, agentId));
    if (teamId) conditions.push(eq(runaways.teamId, teamId));

    const rows = await db
      .select()
      .from(runaways)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(runaways.detectedAt))
      .limit(limit);

    return c.json({ runaways: rows });
  });

  return app;
}
