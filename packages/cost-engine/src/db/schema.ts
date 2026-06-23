import {
  pgTable,
  text,
  timestamp,
  numeric,
  integer,
  boolean,
  jsonb,
  primaryKey,
} from "drizzle-orm/pg-core";

export const teams = pgTable("teams", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: text("id").primaryKey(),
  teamId: text("team_id").references(() => teams.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  keyHash: text("key_hash").notNull().unique(),
  teamId: text("team_id")
    .notNull()
    .references(() => teams.id),
  name: text("name").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  revokedAt: timestamp("revoked_at"),
});

// TimescaleDB hypertable, partitioned by recorded_at
export const costEvents = pgTable("cost_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  teamId: text("team_id").notNull(),
  apiKeyId: text("api_key_id"),
  workflowId: text("workflow_id"),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  cacheReadTokens: integer("cache_read_tokens").notNull().default(0),
  cacheWriteTokens: integer("cache_write_tokens").notNull().default(0),
  inputCostUsd: numeric("input_cost_usd", { precision: 18, scale: 8 })
    .notNull()
    .default("0"),
  outputCostUsd: numeric("output_cost_usd", { precision: 18, scale: 8 })
    .notNull()
    .default("0"),
  cacheReadCostUsd: numeric("cache_read_cost_usd", { precision: 18, scale: 8 })
    .notNull()
    .default("0"),
  cacheWriteCostUsd: numeric("cache_write_cost_usd", {
    precision: 18,
    scale: 8,
  })
    .notNull()
    .default("0"),
  totalCostUsd: numeric("total_cost_usd", { precision: 18, scale: 8 })
    .notNull()
    .default("0"),
  requestId: text("request_id").notNull(),
  latencyMs: integer("latency_ms").notNull().default(0),
  toolCallCount: integer("tool_call_count").notNull().default(0),
  streaming: boolean("streaming").notNull().default(false),
  statusCode: integer("status_code").notNull().default(200),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});

export const toolCallLogs = pgTable("tool_call_logs", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  teamId: text("team_id").notNull(),
  requestId: text("request_id").notNull(),
  toolName: text("tool_name").notNull(),
  parameters: jsonb("parameters"),
  resultStatus: text("result_status").notNull(), // success | error
  errorType: text("error_type"),
  latencyMs: integer("latency_ms"),
  recordedAt: timestamp("recorded_at").defaultNow().notNull(),
});

export const budgets = pgTable("budgets", {
  id: text("id").primaryKey(),
  scope: text("scope").notNull(), // agent | team
  scopeId: text("scope_id").notNull(),
  period: text("period").notNull(), // daily | weekly | monthly
  capUsd: numeric("cap_usd", { precision: 18, scale: 4 }).notNull(),
  warningThresholdPercent: integer("warning_threshold_percent")
    .notNull()
    .default(80),
  enforcementMode: text("enforcement_mode").notNull(), // alert | throttle | kill
  throttleModelId: text("throttle_model_id"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const runaways = pgTable("runaway_events", {
  id: text("id").primaryKey(),
  agentId: text("agent_id").notNull(),
  teamId: text("team_id").notNull(),
  triggerType: text("trigger_type").notNull(), // velocity | loop
  tokenCount: integer("token_count").notNull(),
  estimatedCostUsd: numeric("estimated_cost_usd", {
    precision: 18,
    scale: 8,
  }).notNull(),
  actionTaken: text("action_taken").notNull(), // circuit_break | alert
  cooldownUntil: timestamp("cooldown_until"),
  overriddenAt: timestamp("overridden_at"),
  overrideReason: text("override_reason"),
  detectedAt: timestamp("detected_at").defaultNow().notNull(),
});

export const landingEvents = pgTable("landing_events", {
  id: text("id").primaryKey(),
  event: text("event").notNull(),
  page: text("page"),
  referrer: text("referrer"),
  utmSource: text("utm_source"),
  utmMedium: text("utm_medium"),
  utmCampaign: text("utm_campaign"),
  utmContent: text("utm_content"),
  utmTerm: text("utm_term"),
  props: jsonb("props"),
  ipHash: text("ip_hash"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const alertConfigs = pgTable("alert_configs", {
  id: text("id").primaryKey(),
  teamId: text("team_id").notNull(),
  alertType: text("alert_type").notNull(),
  channel: text("channel").notNull(), // webhook | slack
  destination: text("destination").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
