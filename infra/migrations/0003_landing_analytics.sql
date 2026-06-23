-- Landing page analytics events
-- Captures page views and click events from steadio.ai, attributed by UTM params.

CREATE TABLE IF NOT EXISTS landing_events (
  id          TEXT PRIMARY KEY,
  event       TEXT NOT NULL,          -- 'pageview' | 'click' | etc.
  page        TEXT,
  referrer    TEXT,
  utm_source  TEXT,
  utm_medium  TEXT,
  utm_campaign TEXT,
  utm_content  TEXT,
  utm_term     TEXT,
  props       JSONB,                   -- arbitrary custom properties
  ip_hash     TEXT,                    -- SHA-256 of client IP, never raw IP
  user_agent  TEXT,
  created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS landing_events_event_idx    ON landing_events (event);
CREATE INDEX IF NOT EXISTS landing_events_created_idx  ON landing_events (created_at DESC);
CREATE INDEX IF NOT EXISTS landing_events_source_idx   ON landing_events (utm_source) WHERE utm_source IS NOT NULL;
