// ApexRevenue — apex-sync-push
// POST /sync/push — applies a single mutation { kind, payload } to cloud state.
// Idempotent where the natural key allows (whale upserts, preferences, thresholds).

const { query, respond, handleCors, getUserFromToken, parseBody } = require('./shared');

async function applyMutation(sub, kind, payload) {
  switch (kind) {
    case 'whale.upsert': {
      const { platform, username, cumulative_tokens, tier, last_tip_at, session_count, notes } = payload;
      if (!platform || !username) throw new Error('platform and username required');
      await query(
        `INSERT INTO performer_whales
           (performer_sub, platform, username, cumulative_tokens, tier, last_tip_at, session_count, notes, first_seen, last_seen)
         VALUES ($1, $2, $3, COALESCE($4, 0), $5, $6, COALESCE($7, 0), $8, NOW(), NOW())
         ON CONFLICT (performer_sub, platform, username) DO UPDATE SET
           cumulative_tokens = GREATEST(performer_whales.cumulative_tokens, COALESCE(EXCLUDED.cumulative_tokens, performer_whales.cumulative_tokens)),
           tier              = COALESCE(EXCLUDED.tier, performer_whales.tier),
           last_tip_at       = COALESCE(EXCLUDED.last_tip_at, performer_whales.last_tip_at),
           session_count     = GREATEST(performer_whales.session_count, COALESCE(EXCLUDED.session_count, performer_whales.session_count)),
           notes             = COALESCE(EXCLUDED.notes, performer_whales.notes),
           last_seen         = NOW()`,
        [sub, platform, username, cumulative_tokens, tier, last_tip_at, session_count, notes],
      );
      return { ok: true };
    }

    case 'whale.delete': {
      const { platform, username } = payload;
      if (!platform || !username) throw new Error('platform and username required');
      await query(
        `DELETE FROM performer_whales
          WHERE performer_sub = $1 AND platform = $2 AND username = $3`,
        [sub, platform, username],
      );
      return { ok: true };
    }

    case 'prompt.upsert': {
      const { id, category, text, tone, tts_voice, physical_reaction_required, enabled } = payload;
      if (!category || !text) throw new Error('category and text required');
      if (id) {
        await query(
          `UPDATE performer_prompts
              SET category = $3, text = $4, tone = $5, tts_voice = $6,
                  physical_reaction_required = COALESCE($7, physical_reaction_required),
                  enabled = COALESCE($8, enabled),
                  updated_at = NOW()
            WHERE id = $1 AND performer_sub = $2`,
          [id, sub, category, text, tone, tts_voice, physical_reaction_required, enabled],
        );
      } else {
        await query(
          `INSERT INTO performer_prompts
             (performer_sub, category, text, tone, tts_voice, physical_reaction_required, enabled)
           VALUES ($1, $2, $3, $4, $5, COALESCE($6, TRUE), COALESCE($7, TRUE))`,
          [sub, category, text, tone, tts_voice, physical_reaction_required, enabled],
        );
      }
      return { ok: true };
    }

    case 'prompt.delete': {
      const { id } = payload;
      if (!id) throw new Error('id required');
      await query(
        `DELETE FROM performer_prompts WHERE id = $1 AND performer_sub = $2`,
        [id, sub],
      );
      return { ok: true };
    }

    case 'preference.set': {
      const { key, value } = payload;
      if (!key) throw new Error('key required');
      await query(
        `INSERT INTO performer_preferences (performer_sub, key, value_json, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (performer_sub, key) DO UPDATE
           SET value_json = EXCLUDED.value_json,
               updated_at = NOW()`,
        [sub, key, JSON.stringify(value)],
      );
      return { ok: true };
    }

    case 'thresholds.update': {
      const { whaleMin, bigTipperMin, tipperMin } = payload;
      await query(
        `INSERT INTO performer_signal_thresholds (performer_sub, whale_min, big_tipper_min, tipper_min, updated_at)
         VALUES ($1, COALESCE($2, 200), COALESCE($3, 50), COALESCE($4, 10), NOW())
         ON CONFLICT (performer_sub) DO UPDATE
           SET whale_min      = COALESCE($2, performer_signal_thresholds.whale_min),
               big_tipper_min = COALESCE($3, performer_signal_thresholds.big_tipper_min),
               tipper_min     = COALESCE($4, performer_signal_thresholds.tipper_min),
               updated_at     = NOW()`,
        [sub, whaleMin, bigTipperMin, tipperMin],
      );
      return { ok: true };
    }

    default:
      throw new Error('unknown kind: ' + kind);
  }
}

exports.handler = async (event) => {
  const cors = handleCors(event);
  if (cors) return cors;

  const user = getUserFromToken(event);
  if (!user) return respond(401, { error: 'Unauthorized' });

  const body = parseBody(event);
  const { kind, payload } = body;
  if (!kind || !payload) return respond(400, { error: 'kind and payload required' });

  try {
    const result = await applyMutation(user.id, kind, payload);
    return respond(200, result);
  } catch (err) {
    console.error('[apex-sync-push]', kind, err);
    const is400 = err.message && err.message.endsWith('required');
    return respond(is400 ? 400 : 500, {
      error: 'mutation_failed',
      kind,
      detail: err.message,
    });
  }
};
