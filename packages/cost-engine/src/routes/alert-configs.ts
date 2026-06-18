import { Hono } from "hono";
import { v4 as uuidv4 } from "uuid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { alertConfigs } from "../db/schema.js";

export function createAlertConfigsRouter(db: Db) {
  const app = new Hono();

  // GET /api/alert-configs?teamId=
  app.get("/api/alert-configs", async (c) => {
    const teamId = c.req.query("teamId");

    const rows = teamId
      ? await db.select().from(alertConfigs).where(eq(alertConfigs.teamId, teamId))
      : await db.select().from(alertConfigs);

    return c.json({ alertConfigs: rows });
  });

  // POST /api/alert-configs
  app.post("/api/alert-configs", async (c) => {
    const body = await c.req.json() as {
      teamId: string;
      alertType: string;
      channel: string;
      destination: string;
    };

    if (!body.teamId || !body.alertType || !body.channel || !body.destination) {
      return c.json({ error: "missing_fields" }, 400);
    }

    const id = uuidv4();
    await db.insert(alertConfigs).values({
      id,
      teamId: body.teamId,
      alertType: body.alertType,
      channel: body.channel,
      destination: body.destination,
    });

    const [created] = await db
      .select()
      .from(alertConfigs)
      .where(eq(alertConfigs.id, id));

    return c.json({ alertConfig: created }, 201);
  });

  // DELETE /api/alert-configs/:id
  app.delete("/api/alert-configs/:id", async (c) => {
    const id = c.req.param("id");
    await db.delete(alertConfigs).where(eq(alertConfigs.id, id));
    return c.json({ ok: true });
  });

  return app;
}
