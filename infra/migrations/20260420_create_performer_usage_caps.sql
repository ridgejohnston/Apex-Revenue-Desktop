-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_usage_caps
-- Daily usage tracking for metered AWS services (Bedrock, Polly, Transcribe,
-- Translate, MediaLive). Every metered call decrements here and is bounded by
-- per-performer daily caps.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_usage_caps (
  performer_sub       TEXT NOT NULL,
  service             TEXT NOT NULL,      -- 'bedrock' | 'polly' | 'transcribe' | 'translate' | 'medialive'
  day                 DATE NOT NULL,
  units_used          INTEGER NOT NULL DEFAULT 0,   -- service-specific unit: tokens / chars / minutes
  daily_cap           INTEGER NOT NULL DEFAULT 0,   -- 0 = unlimited
  cost_cents          INTEGER NOT NULL DEFAULT 0,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (performer_sub, service, day)
);

CREATE INDEX IF NOT EXISTS idx_performer_usage_caps_recent
  ON performer_usage_caps (day DESC, service);

-- Helper: atomically increment usage, return new total.
-- Caller checks the returned total against daily_cap client-side.
CREATE OR REPLACE FUNCTION increment_usage(
  p_sub    TEXT,
  p_service TEXT,
  p_units  INTEGER,
  p_cost_cents INTEGER
) RETURNS INTEGER AS $$
DECLARE
  new_total INTEGER;
BEGIN
  INSERT INTO performer_usage_caps (performer_sub, service, day, units_used, cost_cents)
  VALUES (p_sub, p_service, CURRENT_DATE, p_units, p_cost_cents)
  ON CONFLICT (performer_sub, service, day) DO UPDATE
    SET units_used = performer_usage_caps.units_used + p_units,
        cost_cents = performer_usage_caps.cost_cents + p_cost_cents,
        updated_at = NOW()
  RETURNING units_used INTO new_total;
  RETURN new_total;
END;
$$ LANGUAGE plpgsql;
