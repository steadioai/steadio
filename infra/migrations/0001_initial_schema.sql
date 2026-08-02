-- SteadIO OSS v0.2 — consolidated initial schema.
-- Requires TimescaleDB extension (PostgreSQL 16).

BEGIN;

CREATE EXTENSION IF NOT EXISTS timescaledb;

-- Enums
DO $$ BEGIN CREATE TYPE period_type AS ENUM ('daily', 'weekly', 'monthly', 'rolling_30d'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE enforcement_mode AS ENUM ('alert', 'throttle', 'kill'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE runaway_trigger AS ENUM ('velocity', 'loop', 'manual'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE alert_channel AS ENUM ('webhook', 'slack'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE guardrail_action AS ENUM ('allow', 'alert', 'throttle', 'hold', 'block'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'denied', 'expired'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- set_updated_at trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Users
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email TEXT NOT NULL,
  name TEXT,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',
  team_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_idx ON users(email);

DO $$ BEGIN
  CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Teams
CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name TEXT NOT NULL,
  slug TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS teams_slug_idx ON teams(slug);

-- Agents
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  external_id TEXT,
  provider TEXT,
  model TEXT,
  allowed_tools JSONB NOT NULL DEFAULT '[]',
  guardrail_mode TEXT NOT NULL DEFAULT 'monitor',
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agents_team_id_idx ON agents(team_id);
CREATE INDEX IF NOT EXISTS agents_external_id_idx ON agents(external_id);

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'agents_guardrail_mode_check'
  ) THEN
    ALTER TABLE agents ADD CONSTRAINT agents_guardrail_mode_check
      CHECK (guardrail_mode IN ('monitor', 'block'));
  END IF;
END $$;

-- API Keys
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  name TEXT NOT NULL,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS api_keys_key_hash_idx ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS api_keys_team_id_idx ON api_keys(team_id);

-- Provider Keys (BYOK credentials, encrypted)
CREATE TABLE IF NOT EXISTS provider_keys (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}',
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS provider_keys_team_provider_idx ON provider_keys(team_id, provider);
CREATE INDEX IF NOT EXISTS provider_keys_team_id_idx ON provider_keys(team_id);

-- Budgets
CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  period_type period_type NOT NULL,
  limit_cents INTEGER NOT NULL,
  alert_threshold_percent INTEGER NOT NULL DEFAULT 80,
  hard_limit BOOLEAN NOT NULL DEFAULT FALSE,
  enforcement_mode enforcement_mode NOT NULL DEFAULT 'alert',
  throttle_model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS budgets_team_id_idx ON budgets(team_id);
CREATE INDEX IF NOT EXISTS budgets_agent_id_idx ON budgets(agent_id);

-- Cost Events (TimescaleDB hypertable)
CREATE TABLE IF NOT EXISTS cost_events (
  id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  request_id TEXT,
  workflow_id TEXT,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  duration_ms BIGINT,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
);
CREATE INDEX IF NOT EXISTS cost_events_agent_id_created_at_idx ON cost_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_team_id_created_at_idx ON cost_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cost_events_request_id_idx ON cost_events(request_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('cost_events', 'created_at', if_not_exists => TRUE);
  END IF;
END $$;

-- Tool Call Logs
CREATE TABLE IF NOT EXISTS tool_call_logs (
  id TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  workflow_id TEXT,
  tool_name TEXT NOT NULL,
  parameters JSONB NOT NULL DEFAULT '{}',
  result_status TEXT NOT NULL DEFAULT 'success',
  error_type TEXT,
  error_message TEXT,
  latency_ms BIGINT,
  cost_cents INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, created_at)
);
CREATE INDEX IF NOT EXISTS tool_call_logs_agent_id_idx ON tool_call_logs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_call_logs_team_id_idx ON tool_call_logs(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_call_logs_request_id_idx ON tool_call_logs(request_id);
CREATE INDEX IF NOT EXISTS tool_call_logs_tool_name_idx ON tool_call_logs(tool_name);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN
    PERFORM create_hypertable('tool_call_logs', 'created_at', if_not_exists => TRUE);
  END IF;
END $$;

-- Runaway Events
CREATE TABLE IF NOT EXISTS runaway_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  agent_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  trigger_type runaway_trigger NOT NULL,
  token_count INTEGER,
  estimated_cost_cents INTEGER,
  evidence JSONB NOT NULL DEFAULT '{}',
  action_taken TEXT NOT NULL DEFAULT 'circuit_break',
  overridden_at TIMESTAMPTZ,
  override_reason TEXT,
  cooldown_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS runaway_events_agent_id_idx ON runaway_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS runaway_events_team_id_idx ON runaway_events(team_id, created_at DESC);

-- Alert Configs
CREATE TABLE IF NOT EXISTS alert_configs (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  channel alert_channel NOT NULL,
  webhook_url TEXT,
  enabled_events JSONB NOT NULL DEFAULT '[]',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS alert_configs_team_id_idx ON alert_configs(team_id);

-- Guardrail Events
CREATE TABLE IF NOT EXISTS guardrail_events (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  agent_id TEXT,
  action guardrail_action NOT NULL,
  rule_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  evidence JSONB NOT NULL DEFAULT '{}',
  findings JSONB NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL DEFAULT 'request',
  content_preview TEXT,
  http_status INTEGER,
  enforced BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guardrail_events_team_id_idx ON guardrail_events(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guardrail_events_agent_id_idx ON guardrail_events(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS guardrail_events_action_idx ON guardrail_events(action);

-- Agent Freezes (kill-switch)
CREATE TABLE IF NOT EXISTS agent_freezes (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool_name TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT,
  actor_user_id TEXT,
  cleared_by TEXT,
  cleared_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS agent_freezes_team_agent_idx ON agent_freezes(team_id, agent_id);
CREATE INDEX IF NOT EXISTS agent_freezes_active_idx ON agent_freezes(active);

-- Approval Requests (HITL queue)
CREATE TABLE IF NOT EXISTS approval_requests (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  agent_id TEXT,
  key_id TEXT,
  status approval_status NOT NULL DEFAULT 'pending',
  rule_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  action_payload JSONB NOT NULL DEFAULT '{}',
  findings JSONB NOT NULL DEFAULT '[]',
  content_preview TEXT,
  guardrail_event_id TEXT,
  resume_token TEXT NOT NULL,
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS approval_requests_team_id_idx ON approval_requests(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_status_idx ON approval_requests(status);
CREATE UNIQUE INDEX IF NOT EXISTS approval_requests_resume_token_idx ON approval_requests(resume_token);

-- Reliability Snapshots
CREATE TABLE IF NOT EXISTS reliability_snapshots (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  agent_id TEXT,
  score INTEGER NOT NULL,
  grade TEXT NOT NULL,
  attacks_total INTEGER NOT NULL,
  attacks_caught INTEGER NOT NULL,
  controls_total INTEGER NOT NULL DEFAULT 0,
  false_positives INTEGER NOT NULL DEFAULT 0,
  unprotected_exposure INTEGER NOT NULL DEFAULT 0,
  by_category JSONB NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'cron',
  regression BOOLEAN NOT NULL DEFAULT FALSE,
  regression_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS reliability_snapshots_team_id_idx ON reliability_snapshots(team_id, created_at DESC);
CREATE INDEX IF NOT EXISTS reliability_snapshots_agent_id_idx ON reliability_snapshots(agent_id, created_at DESC);

-- Tool Ledger (NSA-compliant audit)
CREATE TABLE IF NOT EXISTS tool_ledger (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  agent_id TEXT,
  identity TEXT,
  tool_name TEXT NOT NULL,
  params_masked JSONB NOT NULL DEFAULT '{}',
  result_status TEXT NOT NULL,
  rule_id TEXT,
  result_hash TEXT NOT NULL,
  ts TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tool_ledger_team_id_ts_idx ON tool_ledger(team_id, ts);
CREATE INDEX IF NOT EXISTS tool_ledger_agent_id_idx ON tool_ledger(agent_id, ts);

-- Evidence (immutable records)
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL,
  issue_ref TEXT NOT NULL,
  type TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}',
  producer_role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS evidence_team_id_issue_ref_idx ON evidence(team_id, issue_ref);
CREATE INDEX IF NOT EXISTS evidence_issue_ref_idx ON evidence(issue_ref);
CREATE INDEX IF NOT EXISTS evidence_created_at_idx ON evidence(created_at);

-- Guardrail Rules (per-workspace enforcement config)
CREATE TABLE IF NOT EXISTS guardrail_rules (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'alert',
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  name TEXT NOT NULL,
  description TEXT,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS guardrail_rules_team_id_idx ON guardrail_rules(team_id);
CREATE UNIQUE INDEX IF NOT EXISTS guardrail_rules_team_rule_id_idx ON guardrail_rules(team_id, rule_id);

COMMIT;
