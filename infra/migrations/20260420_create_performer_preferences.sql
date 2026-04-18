-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_preferences
-- Generic key/value store for per-performer preferences.
-- Examples: 'voice_alerts_enabled', 'default_platform', 'inbox_notify_sound'.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_preferences (
  performer_sub TEXT NOT NULL,
  key           TEXT NOT NULL,
  value_json    JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (performer_sub, key)
);

CREATE INDEX IF NOT EXISTS idx_performer_preferences_key
  ON performer_preferences (key);
