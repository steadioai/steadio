-- SteadIO - Initial Schema
-- Requires TimescaleDB extension (PostgreSQL 16)

CREATE EXTENSION IF NOT EXISTS timescaledb;

CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  team_id TEXT REFERENCES teams(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  name TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);

CREATE TABLE cost_events (
  id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  workflow_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  input_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
  output_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
  cache_read_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
  cache_write_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
  total_cost_usd NUMERIC(18, 8) NOT NULL DEFAULT 0,
  request_id TEXT NOT NULL,
  latency_ms INTEGER NOT NULL DEFAULT 0,
  tool_call_count INTEGER NOT NULL DEFAULT 0,
  streaming BOOLEAN NOT NULL DEFAULT FALSE,
  status_code INTEGER NOT NULL DEFAULT 200,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Convert to TimescaleDB hypertable
SELECT create_hypertable('cost_events', 'recorded_at');
CREATE INDEX ON cost_events (agent_id, recorded_at DESC);
CREATE INDEX ON cost_events (team_id, recorded_at DESC);

CREATE TABLE tool_call_logs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  parameters JSONB,
  result_status TEXT NOT NULL, -- success | error
  error_type TEXT,
  latency_ms INTEGER,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON tool_call_logs (agent_id, recorded_at DESC);
CREATE INDEX ON tool_call_logs (team_id, tool_name, recorded_at DESC);

CREATE TABLE budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,        -- agent | team
  scope_id TEXT NOT NULL,
  period TEXT NOT NULL,       -- daily | weekly | monthly
  cap_usd NUMERIC(18, 4) NOT NULL,
  warning_threshold_percent INTEGER NOT NULL DEFAULT 80,
  enforcement_mode TEXT NOT NULL, -- alert | throttle | kill
  throttle_model_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX budgets_scope_scopeid_period ON budgets (scope, scope_id, period);

CREATE TABLE runaway_events (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  trigger_type TEXT NOT NULL,  -- velocity | loop
  token_count INTEGER NOT NULL,
  estimated_cost_usd NUMERIC(18, 8) NOT NULL,
  action_taken TEXT NOT NULL,  -- circuit_break | alert
  cooldown_until TIMESTAMPTZ,
  overridden_at TIMESTAMPTZ,
  override_reason TEXT,
  detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE alert_configs (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL,
  alert_type TEXT NOT NULL,    -- budget_warning | budget_exceeded | runaway_detected | tool_call_failure
  channel TEXT NOT NULL,       -- webhook | slack
  destination TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
