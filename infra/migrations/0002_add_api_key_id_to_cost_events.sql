-- Add api_key_id to cost_events for per-key usage attribution
ALTER TABLE cost_events ADD COLUMN IF NOT EXISTS api_key_id TEXT;
CREATE INDEX IF NOT EXISTS cost_events_api_key_id_created_at ON cost_events (api_key_id, created_at DESC);
