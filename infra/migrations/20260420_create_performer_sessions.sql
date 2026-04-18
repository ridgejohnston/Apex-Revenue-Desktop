-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_sessions
-- Historical session roll-up. Each Desktop session writes a final row on end.
-- Powers the 30-day history lookup that drives hvReturnee signal.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  performer_sub   TEXT NOT NULL,
  platform        TEXT NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL,
  ended_at        TIMESTAMPTZ,
  total_tokens    INTEGER DEFAULT 0,
  peak_viewers    INTEGER DEFAULT 0,
  unique_tippers  INTEGER DEFAULT 0,
  conversion_rate NUMERIC(5,2),
  largest_tip     INTEGER DEFAULT 0,
  raw_snapshot    JSONB
);

CREATE INDEX IF NOT EXISTS idx_performer_sessions_sub_started
  ON performer_sessions (performer_sub, started_at DESC);

-- Plain (non-partial) index on ended_at. Postgres rejects partial indexes
-- with predicates referencing volatile functions like NOW(), so we use a
-- full index and let query-time filtering narrow to the 30-day window.
CREATE INDEX IF NOT EXISTS idx_performer_sessions_ended_at
  ON performer_sessions (performer_sub, ended_at DESC);
