-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_whales
-- Cloud-synced whale / fan roster per performer.
-- Source of truth for hvReturnee signal's 30-day history lookup.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_whales (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  performer_sub     TEXT NOT NULL,               -- Cognito sub
  platform          TEXT NOT NULL,               -- 'chaturbate' | 'stripchat' | 'myfreecams' | 'xtease'
  username          TEXT NOT NULL,
  cumulative_tokens INTEGER NOT NULL DEFAULT 0,
  tier              SMALLINT,                    -- 1 whale | 2 big-tipper | 3 tipper | 4 viewer
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_tip_at       TIMESTAMPTZ,
  session_count     INTEGER DEFAULT 0,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (performer_sub, platform, username)
);

CREATE INDEX IF NOT EXISTS idx_performer_whales_sub_platform
  ON performer_whales (performer_sub, platform);

CREATE INDEX IF NOT EXISTS idx_performer_whales_sub_tier
  ON performer_whales (performer_sub, tier)
  WHERE tier <= 2;  -- fast lookup for whale+big-tipper queries

CREATE INDEX IF NOT EXISTS idx_performer_whales_last_seen
  ON performer_whales (performer_sub, last_seen DESC);

-- Trigger to keep updated_at fresh
CREATE OR REPLACE FUNCTION performer_whales_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_performer_whales_updated_at ON performer_whales;
CREATE TRIGGER trg_performer_whales_updated_at
  BEFORE UPDATE ON performer_whales
  FOR EACH ROW EXECUTE FUNCTION performer_whales_set_updated_at();
