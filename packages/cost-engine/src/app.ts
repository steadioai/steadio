import { Hono } from "hono";
import { cors } from "hono/cors";
import { sql } from "drizzle-orm";
import { teamsRoutes } from "./routes/teams.js";
import { agentRoutes } from "./routes/agents.js";
import { budgetRoutes } from "./routes/budgets.js";
import { attributionRoutes } from "./routes/attribution.js";
import { analyticsRoutes } from "./routes/analytics.js";
import { runawayRoutes } from "./routes/runaway.js";
import { alertRoutes } from "./routes/alerts.js";
import { authRoutes } from "./routes/auth.js";
import { accountRoutes } from "./routes/account.js";
import { apiKeyRoutes } from "./routes/api-keys.js";
import { demoApiRoutes, demoRoutes } from "./routes/demo.js";
import { guardrailsDemoRoutes } from "./routes/guardrails-demo.js";
import { reliabilityCheckRoutes } from "./routes/reliability-check.js";
import { reliabilityHistoryRoutes } from "./routes/reliability-history.js";
import { pricingRoutes } from "./routes/pricing.js";
import { guardrailEventsRoutes } from "./routes/guardrail-events.js";
import { guardrailRuleRoutes } from "./routes/guardrail-rules.js";
import { toolLedgerRoutes } from "./routes/tool-ledger.js";
import { incidentsRoutes } from "./routes/incidents.js";
import { approvalsRoutes } from "./routes/approvals.js";
import { evidenceRoutes } from "./routes/evidence.js";
import { gatewayRoutes } from "./routes/gateway.js";
import { proxyEventsRoutes } from "./routes/proxy-events.js";
import { circuitBreakerRoutes } from "./routes/circuit-breakers.js";
import { keyResolveRoutes } from "./routes/key-resolve.js";
import { getDb } from "./db.js";
import { getRedis } from "./redis.js";
import { jsonLogger } from "./middleware/logger.js";
import { managementAuthMiddleware } from "./middleware/management-auth.js";

export const app = new Hono();

app.use("*", jsonLogger("cost-engine"));

const explicitOrigins = new Set<string>();
for (const v of [
  process.env["DASHBOARD_URL"],
  ...(process.env["CORS_ORIGINS"] ?? "").split(","),
]) {
  const o = v?.trim();
  if (o) explicitOrigins.add(o);
}
if (process.env["NODE_ENV"] !== "production") {
  explicitOrigins.add("http://localhost:5173");
  explicitOrigins.add("http://localhost:5174");
  explicitOrigins.add("http://localhost:3000");
}

app.use(
  "*",
  cors({
    origin: (origin) => (origin && explicitOrigins.has(origin) ? origin : null),
    allowHeaders: ["Authorization", "Content-Type", "X-SteadIO-Key"],
    allowMethods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    credentials: true,
  }),
);

const startTime = Date.now();

app.get("/health", (c) =>
  c.json({ status: "ok", service: "cost-engine", timestamp: new Date().toISOString() }),
);

app.get("/healthz", async (c) => {
  const checks: Record<string, "ok" | "error"> = {};
  let overall: "ok" | "error" = "ok";

  try {
    await getDb().execute(sql`SELECT 1`);
    checks["db"] = "ok";
  } catch {
    checks["db"] = "error";
    overall = "error";
  }

  try {
    await getRedis().ping();
    checks["redis"] = "ok";
  } catch {
    checks["redis"] = "error";
    overall = "error";
  }

  const uptime = Math.floor((Date.now() - startTime) / 1000);
  return c.json({ status: overall, checks, uptime }, overall === "ok" ? 200 : 503);
});

// LLM gateway (/v1) — self-guarded (X-SteadIO-Key), mounted before /api/* auth.
app.route("/v1", gatewayRoutes);

// Internal proxy event ingest — service-to-service, no auth (mounted before /api/* JWT).
app.route("/internal/proxy-events", proxyEventsRoutes);

// Proxy key resolution — service-to-service, no JWT (mounted before /api/* auth).
app.route("/api/keys", keyResolveRoutes);

// Public routes (no auth)
app.route("/api/auth", authRoutes);
app.route("/api/demo", demoApiRoutes);
app.route("/api/demo/guardrails", guardrailsDemoRoutes);
app.route("/api/demo/reliability-check", reliabilityCheckRoutes);

// Management routes require a valid dashboard JWT.
app.use("/api/*", managementAuthMiddleware);

app.route("/api/account", accountRoutes);
app.route("/api/teams", teamsRoutes);
app.route("/api/agents", agentRoutes);
app.route("/api/budgets", budgetRoutes);
app.route("/api/attribution", attributionRoutes);
app.route("/api/analytics", analyticsRoutes);
app.route("/api/runaway", runawayRoutes);
app.route("/api/alerts", alertRoutes);
app.route("/api/api-keys", apiKeyRoutes);
app.route("/api/pricing", pricingRoutes);
app.route("/api/guardrail-events", guardrailEventsRoutes);
app.route("/api/guardrail-rules", guardrailRuleRoutes);
app.route("/api/reliability-history", reliabilityHistoryRoutes);
app.route("/api/tool-ledger", toolLedgerRoutes);
app.route("/api/incidents", incidentsRoutes);
app.route("/api/approvals", approvalsRoutes);
app.route("/api/evidence", evidenceRoutes);
app.route("/api/circuit-breakers", circuitBreakerRoutes);
app.route("/api/demo/env", demoRoutes);

app.onError((err, c) => {
  console.error("[cost-engine] error:", err);
  return c.json({ error: "internal_error", message: err.message }, 500);
});

export default app;
