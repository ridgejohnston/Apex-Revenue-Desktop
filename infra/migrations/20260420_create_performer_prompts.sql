-- ═══════════════════════════════════════════════════════════════════════════
-- Apex Revenue — 20260420_create_performer_prompts
-- Performer's custom prompt library (extends seed prompts from S3).
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS performer_prompts (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  performer_sub               TEXT NOT NULL,
  category                    TEXT NOT NULL,    -- 'whale', 'audience', 'momentum', 'cascade',
                                                -- 'churn-whale', 'milestone', 'competition',
                                                -- 'first-tip', 'surge', 'hv-returnee',
                                                -- 'dead-air', 'anchor', 'streak',
                                                -- 'grey.conversion', 'tip.verbal.authentic'
  text                        TEXT NOT NULL,
  tone                        TEXT,             -- 'playful', 'warm', 'direct', 'grateful', etc.
  tts_voice                   TEXT,             -- 'Joanna', 'Salli', 'Danielle', 'Ruth'
  physical_reaction_required  BOOLEAN NOT NULL DEFAULT TRUE,
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_performer_prompts_sub
  ON performer_prompts (performer_sub, category, enabled);
