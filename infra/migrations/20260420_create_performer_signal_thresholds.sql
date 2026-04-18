-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_signal_thresholds
-- User-configurable tier thresholds (replaces hardcoded 200/50/10 in
-- shared/apex-config.js). One row per performer.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_signal_thresholds (
  performer_sub       TEXT PRIMARY KEY,
  whale_min           INTEGER NOT NULL DEFAULT 200,
  big_tipper_min      INTEGER NOT NULL DEFAULT 50,
  tipper_min          INTEGER NOT NULL DEFAULT 10,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (whale_min > big_tipper_min),
  CHECK (big_tipper_min > tipper_min),
  CHECK (tipper_min >= 1)
);
