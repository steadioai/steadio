import { Hono } from "hono";
import { sql, eq, and, gte, lte, desc } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { toolCallLogs, costEvents } from "../db/schema.js";

export function createCostsRouter(db: Db) {
  const app = new Hono();

  // GET /api/costs/tool-calls?agentId=&period=7d&limit=100&offset=0
  app.get("/api/costs/tool-calls", async (c) => {
    const agentId = c.req.query("agentId");
    const period = c.req.query("period") ?? "7d";
    const limit = Math.min(parseInt(c.req.query("limit") ?? "100", 10), 500);
    const offset = parseInt(c.req.query("offset") ?? "0", 10);
    const { from, to } = parsePeriod(period);

    const conditions = [
      gte(toolCallLogs.recordedAt, from),
      lte(toolCallLogs.recordedAt, to),
    ];
    if (agentId) conditions.push(eq(toolCallLogs.agentId, agentId));

    // Fetch tool calls joined with the parent request cost (evenly split across tool calls)
    const rows = await db
      .select({
        id: toolCallLogs.id,
        agentId: toolCallLogs.agentId,
        toolName: toolCallLogs.toolName,
        resultStatus: toolCallLogs.resultStatus,
        errorType: toolCallLogs.errorType,
        latencyMs: toolCallLogs.latencyMs,
        recordedAt: toolCallLogs.recordedAt,
        requestId: toolCallLogs.requestId,
        // Approximate cost: parent request cost / tool call count
        costUsd: sql<number>`
          CASE
            WHEN ce.tool_call_count > 0
            THEN ce.total_cost_usd::numeric / ce.tool_call_count
            ELSE 0
          END
        `,
      })
      .from(toolCallLogs)
      .leftJoin(
        costEvents,
        eq(toolCallLogs.requestId, costEvents.requestId)
      )
      .where(and(...conditions))
      .orderBy(desc(toolCallLogs.recordedAt))
      .limit(limit)
      .offset(offset);

    // Total count for pagination
    const countRows = await db
      .select({ total: sql<number>`count(*)` })
      .from(toolCallLogs)
      .where(and(...conditions));
    const total = countRows[0]?.total ?? 0;

    // Top tools by call count
    const topTools = await db
      .select({
        toolName: toolCallLogs.toolName,
        callCount: sql<number>`count(*)`,
        errorCount: sql<number>`count(*) filter (where ${toolCallLogs.resultStatus} = 'error')`,
      })
      .from(toolCallLogs)
      .where(and(...conditions))
      .groupBy(toolCallLogs.toolName)
      .orderBy(desc(sql`count(*)`))
      .limit(20);

    return c.json({
      toolCalls: rows,
      topTools,
      total: Number(total),
      limit,
      offset,
      period,
      from: from.toISOString(),
      to: to.toISOString(),
    });
  });

  return app;
}

function parsePeriod(period: string): { from: Date; to: Date } {
  const to = new Date();
  const from = new Date(to);
  if (period === "1d") {
    from.setDate(from.getDate() - 1);
  } else if (period === "30d") {
    from.setDate(from.getDate() - 30);
  } else {
    from.setDate(from.getDate() - 7);
  }
  return { from, to };
}
