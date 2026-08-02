import {
  pgTable,
  text,
  integer,
  bigint,
  boolean,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  pgEnum,
} from "drizzle-orm/pg-core";

export const periodTypeEnum = pgEnum("period_type", [
  "daily",
  "weekly",
  "monthly",
  "rolling_30d",
]);

export const enforcementModeEnum = pgEnum("enforcement_mode", [
  "alert",
  "throttle",
  "kill",
]);

export const runawayTriggerEnum = pgEnum("runaway_trigger", [
  "velocity",
  "loop",
  "manual",
]);

export const alertChannelEnum = pgEnum("alert_channel", [
  "webhook",
  "slack",
]);

export const guardrailActionEnum = pgEnum("guardrail_action", [
  "allow",
  "alert",
  "throttle",
  "hold",
  "block",
]);

export const approvalStatusEnum = pgEnum("approval_status", [
  "pending",
  "approved",
  "denied",
  "expired",
]);

// Users — dashboard users
export const users = pgTable(
  "users",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    email: text("email").notNull(),
    name: text("name"),
    passwordHash: text("password_hash").notNull(),
    role: text("role").notNull().default("viewer"), // "admin" | "viewer"
    teamId: text("team_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("users_email_idx").on(t.email)],
);

// Teams — top-level grouping for agents and budgets
export const teams = pgTable(
  "teams",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("teams_slug_idx").on(t.slug)],
);

// Agents — individual AI agents being tracked
export const agents = pgTable(
  "agents",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    externalId: text("external_id"),
    provider: text("provider"),
    model: text("model"),
    // Per-agent tool allowlist. When non-empty, the firewall switches this
    // agent to a positive security model: ONLY tools named here may be invoked.
    // Empty/absent = denylist mode (unchanged behavior).
    allowedTools: jsonb("allowed_tools").notNull().default([]),
    guardrailMode: text("guardrail_mode").notNull().default("monitor"),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agents_team_id_idx").on(t.teamId),
    index("agents_external_id_idx").on(t.externalId),
  ],
);

// API keys — for authenticating agents/teams against the proxy
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    keyHash: text("key_hash").notNull(), // SHA-256 hash of the actual key
    keyPrefix: text("key_prefix").notNull(), // First 8 chars for display
    name: text("name").notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("api_keys_key_hash_idx").on(t.keyHash),
    index("api_keys_team_id_idx").on(t.teamId),
  ],
);

// Provider keys — encrypted customer provider credentials for BYOK forwarding.
// `encryptedKey` stores an authenticated envelope; no plaintext provider secret
// is persisted in the database.
export const providerKeys = pgTable(
  "provider_keys",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    encryptedKey: text("encrypted_key").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("provider_keys_team_provider_idx").on(t.teamId, t.provider),
    index("provider_keys_team_id_idx").on(t.teamId),
    index("provider_keys_provider_idx").on(t.provider),
  ],
);

// Budgets — cost limits per team or per agent
export const budgets = pgTable(
  "budgets",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    periodType: periodTypeEnum("period_type").notNull(),
    limitCents: integer("limit_cents").notNull(),
    alertThresholdPercent: integer("alert_threshold_percent")
      .notNull()
      .default(80),
    hardLimit: boolean("hard_limit").notNull().default(false),
    enforcementMode: enforcementModeEnum("enforcement_mode")
      .notNull()
      .default("alert"),
    throttleModel: text("throttle_model"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("budgets_team_id_idx").on(t.teamId),
    index("budgets_agent_id_idx").on(t.agentId),
  ],
);

// cost_events — TimescaleDB hypertable for time-series cost tracking
// NOTE: The actual hypertable conversion is done via migration SQL:
//   SELECT create_hypertable('cost_events', 'created_at');
export const costEvents = pgTable(
  "cost_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id").notNull(),
    teamId: text("team_id").notNull(),
    requestId: text("request_id"),
    workflowId: text("workflow_id"),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    costCents: integer("cost_cents").notNull().default(0),
    durationMs: bigint("duration_ms", { mode: "number" }),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("cost_events_agent_id_created_at_idx").on(t.agentId, t.createdAt),
    index("cost_events_team_id_created_at_idx").on(t.teamId, t.createdAt),
    index("cost_events_request_id_idx").on(t.requestId),
  ],
);

// tool_call_logs — per-request tool call records
export const toolCallLogs = pgTable(
  "tool_call_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id").notNull(),
    teamId: text("team_id").notNull(),
    requestId: text("request_id").notNull(),
    workflowId: text("workflow_id"),
    toolName: text("tool_name").notNull(),
    parameters: jsonb("parameters").notNull().default({}),
    resultStatus: text("result_status").notNull().default("success"), // "success" | "error" | "timeout"
    errorType: text("error_type"), // "malformed_params" | "auth_failure" | "rate_limit" | "timeout" | "other"
    errorMessage: text("error_message"),
    latencyMs: bigint("latency_ms", { mode: "number" }),
    costCents: integer("cost_cents").notNull().default(0),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tool_call_logs_agent_id_idx").on(t.agentId, t.createdAt),
    index("tool_call_logs_team_id_idx").on(t.teamId, t.createdAt),
    index("tool_call_logs_request_id_idx").on(t.requestId),
    index("tool_call_logs_tool_name_idx").on(t.toolName),
  ],
);

// runaway_events — records of runaway detection fires
export const runawayEvents = pgTable(
  "runaway_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    agentId: text("agent_id").notNull(),
    teamId: text("team_id").notNull(),
    triggerType: runawayTriggerEnum("trigger_type").notNull(),
    tokenCount: integer("token_count"),
    estimatedCostCents: integer("estimated_cost_cents"),
    evidence: jsonb("evidence").notNull().default({}), // prompt similarity, velocity data
    actionTaken: text("action_taken").notNull().default("circuit_break"),
    overriddenAt: timestamp("overridden_at", { withTimezone: true }),
    overrideReason: text("override_reason"),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("runaway_events_agent_id_idx").on(t.agentId, t.createdAt),
    index("runaway_events_team_id_idx").on(t.teamId, t.createdAt),
  ],
);

// guardrail_events — persisted record of every inline guardrail decision
// that was not "allow". Drives the reliability-events feed on the dashboard.
// Written fire-and-forget in the gateway after auth passes; a failure to
// persist must never block the request path.
export const guardrailEvents = pgTable(
  "guardrail_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    agentId: text("agent_id"),
    // The guardrail verdict for this request.
    action: guardrailActionEnum("action").notNull(),
    // The single rule that set the action (the most-severe finding).
    ruleId: text("rule_id").notNull(),
    ruleType: text("rule_type").notNull(),
    reason: text("reason").notNull(),
    // Redacted, mask-safe evidence blob — never contains a full secret.
    evidence: jsonb("evidence").notNull().default({}),
    // Full findings array (all rules that fired, not just the determinant).
    findings: jsonb("findings").notNull().default([]),
    // Request metadata for the feed (direction, first 512 chars of content).
    direction: text("direction").notNull().default("request"),
    contentPreview: text("content_preview"),
    // HTTP status returned to the caller (403/429/202 etc.).
    httpStatus: integer("http_status"),
    // Whether the verdict was actually enforced. In OSS all verdicts are
    // enforced by default (no monitor-only tier gating).
    enforced: boolean("enforced").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("guardrail_events_team_id_idx").on(t.teamId, t.createdAt),
    index("guardrail_events_agent_id_idx").on(t.agentId, t.createdAt),
    index("guardrail_events_action_idx").on(t.action),
  ],
);

// agent_freezes — the operator kill-switch / runtime circuit breaker.
//
// An operator can FREEZE an agent (or a single tool for that agent) in one click.
// While a freeze is active the gateway blocks that agent's next call inline.
// Unfreeze clears it and normal evaluation resumes.
//
// toolName NULL = the whole agent is frozen; a value = only that one tool is
// frozen and every other tool still evaluates normally. Unfreeze sets active=false
// (rows are kept for the audit trail rather than deleted).
export const agentFreezes = pgTable(
  "agent_freezes",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    // The external agent identifier the gateway sees (x-steadio-agent-id).
    agentId: text("agent_id").notNull(),
    // NULL = whole-agent freeze; otherwise only this tool is frozen.
    toolName: text("tool_name"),
    active: boolean("active").notNull().default(true),
    reason: text("reason"),
    // Who froze / unfroze it (management JWT sub), for the audit trail.
    actorUserId: text("actor_user_id"),
    clearedBy: text("cleared_by"),
    clearedAt: timestamp("cleared_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("agent_freezes_team_agent_idx").on(t.teamId, t.agentId),
    index("agent_freezes_active_idx").on(t.active),
  ],
);

// approval_requests — the human-in-the-loop queue.
//
// When the inline guardrail returns a "hold" verdict, the action is NOT executed.
// Instead a row is written here and the caller receives HTTP 202 with the
// approvalId + a resumeToken. An operator approves or denies in the dashboard;
// the agent re-issues the request with the resumeToken to resume (approved) or
// receives a hard 403 (denied).
export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    agentId: text("agent_id"),
    keyId: text("key_id"),
    status: approvalStatusEnum("status").notNull().default("pending"),
    // The rule that produced the hold (the determinant finding).
    ruleId: text("rule_id").notNull(),
    ruleType: text("rule_type").notNull(),
    reason: text("reason").notNull(),
    // The full held action so an operator has complete context and the agent
    // can resume the exact request: { direction, content, toolCalls }.
    actionPayload: jsonb("action_payload").notNull().default({}),
    // All findings that fired on the held request.
    findings: jsonb("findings").notNull().default([]),
    // Redacted preview of the content for the queue list.
    contentPreview: text("content_preview"),
    // Optional link back to the guardrail_events feed row.
    guardrailEventId: text("guardrail_event_id"),
    // Secret the agent presents (X-SteadIO-Approval header) to resume. Never
    // exposed in the dashboard list — only returned once to the held caller.
    resumeToken: text("resume_token").notNull(),
    // Resolution metadata.
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    resolutionNote: text("resolution_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("approval_requests_team_id_idx").on(t.teamId, t.createdAt),
    index("approval_requests_status_idx").on(t.status),
    uniqueIndex("approval_requests_resume_token_idx").on(t.resumeToken),
  ],
);

// alert_configs — webhook/Slack destinations for alerts
export const alertConfigs = pgTable(
  "alert_configs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id")
      .notNull()
      .references(() => teams.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    channel: alertChannelEnum("channel").notNull(),
    webhookUrl: text("webhook_url"),
    enabledEvents: jsonb("enabled_events").notNull().default([]), // ["budget_threshold", "runaway", "tool_failure"]
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("alert_configs_team_id_idx").on(t.teamId)],
);

// reliability_snapshots — score/grade history per team over time.
//
// The Continuous Reliability Check runs the attack pack on a schedule and records
// one row per run so we can plot the score over time and alert when a team's
// safety posture regresses between runs.
export const reliabilitySnapshots = pgTable(
  "reliability_snapshots",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    // Optional agent scope; null = the team's whole guardrail config.
    agentId: text("agent_id"),
    // Headline coverage over the attack cases (0-100) and its letter grade.
    score: integer("score").notNull(),
    grade: text("grade").notNull(),
    attacksTotal: integer("attacks_total").notNull(),
    attacksCaught: integer("attacks_caught").notNull(),
    controlsTotal: integer("controls_total").notNull().default(0),
    falsePositives: integer("false_positives").notNull().default(0),
    // How many attacks would land with no reliability layer, for contrast.
    unprotectedExposure: integer("unprotected_exposure").notNull().default(0),
    // Per-category coverage: [{ category, attacks, caught }].
    byCategory: jsonb("by_category").notNull().default([]),
    // "cron" (scheduled) or "manual" (dashboard run).
    source: text("source").notNull().default("cron"),
    // Whether this snapshot tripped a regression alert vs the prior one, and why.
    regression: boolean("regression").notNull().default(false),
    regressionReason: text("regression_reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("reliability_snapshots_team_id_idx").on(t.teamId, t.createdAt),
    index("reliability_snapshots_agent_id_idx").on(t.agentId, t.createdAt),
  ],
);

// tool_ledger — the NSA-compliant tool audit ledger.
//
// Every tool invocation an agent makes is recorded and checked — not only the
// ones that trip a guardrail. One row per tool call in a request, allowed or not,
// written fire-and-forget after inline guardrail evaluation. Params are masked
// (secrets/PII stripped) and only a sha256 of the (masked) call is kept for
// tamper-evidence — never a raw secret.
export const toolLedger = pgTable(
  "tool_ledger",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    // Which agent invoked the tool, and on whose behalf (auditor needs both).
    agentId: text("agent_id"),
    identity: text("identity"),
    toolName: text("tool_name").notNull(),
    // Redacted arguments — secrets/PII masked, long values truncated. Safe to store.
    paramsMasked: jsonb("params_masked").notNull().default({}),
    // The guardrail verdict for this specific tool call
    // (allowed | blocked | held | throttled | alerted).
    resultStatus: text("result_status").notNull(),
    // The rule that determined the status, when the call was not a plain allow.
    ruleId: text("rule_id"),
    // Tamper-evident fingerprint: sha256 of the canonical {toolName, paramsMasked}.
    resultHash: text("result_hash").notNull(),
    // Logical timestamp of the call (ISO-8601), stored as tz.
    ts: timestamp("ts", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("tool_ledger_team_id_ts_idx").on(t.teamId, t.ts),
    index("tool_ledger_agent_id_idx").on(t.agentId, t.ts),
  ],
);

// evidence — immutable evidence records attachable to issues.
// Append-only: the application layer rejects all UPDATE and DELETE operations.
export const evidence = pgTable(
  "evidence",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    teamId: text("team_id").notNull(),
    issueRef: text("issue_ref").notNull(),
    type: text("type").notNull(), // 'command_output' | 'event_delta' | 'url_check' | 'screenshot_ref'
    payload: jsonb("payload").notNull().default({}),
    producerRole: text("producer_role").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("evidence_team_id_issue_ref_idx").on(t.teamId, t.issueRef),
    index("evidence_issue_ref_idx").on(t.issueRef),
    index("evidence_created_at_idx").on(t.createdAt),
  ],
);

// Per-workspace guardrail rule overrides. Operators create, enable, disable, and
// configure individual guardrail rules — replacing hardcoded defaults with a
// per-workspace enforcement posture.
export const guardrailRules = pgTable("guardrail_rules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  ruleId: text("rule_id").notNull(),
  ruleType: text("rule_type").notNull(),
  mode: text("mode").notNull().default("alert"),
  enabled: boolean("enabled").notNull().default(true),
  name: text("name").notNull(),
  description: text("description"),
  config: jsonb("config").notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index("guardrail_rules_team_id_idx").on(t.teamId),
  uniqueIndex("guardrail_rules_team_rule_id_idx").on(t.teamId, t.ruleId),
]);
