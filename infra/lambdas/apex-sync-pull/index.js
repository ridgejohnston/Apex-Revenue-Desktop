// ApexRevenue — apex-sync-pull
// GET /sync/pull — returns all cloud-synced data for the authenticated performer.
// Called by the Desktop on app launch and on-demand.

const { query, respond, handleCors, getUserFromToken } = require('./shared');

exports.handler = async (event) => {
  const cors = handleCors(event);
  if (cors) return cors;

  const user = getUserFromToken(event);
  if (!user) return respond(401, { error: 'Unauthorized' });
  const sub = user.id;

  try {
    const [whalesR, promptsR, preferencesR, thresholdsR, history30dR] = await Promise.all([
      query(
        `SELECT platform, username, cumulative_tokens, tier,
                first_seen, last_seen, last_tip_at, session_count, notes
           FROM performer_whales
          WHERE performer_sub = $1
          ORDER BY cumulative_tokens DESC
          LIMIT 5000`,
        [sub],
      ),
      query(
        `SELECT id, category, text, tone, tts_voice,
                physical_reaction_required, enabled
           FROM performer_prompts
          WHERE performer_sub = $1 AND enabled = TRUE
          ORDER BY category, updated_at DESC`,
        [sub],
      ),
      query(
        `SELECT key, value_json
           FROM performer_preferences
          WHERE performer_sub = $1`,
        [sub],
      ),
      query(
        `SELECT whale_min, big_tipper_min, tipper_min
           FROM performer_signal_thresholds
          WHERE performer_sub = $1`,
        [sub],
      ),
      query(
        `SELECT username, SUM(cumulative_tokens)::INTEGER AS total
           FROM performer_whales
          WHERE performer_sub = $1 AND last_seen >= NOW() - INTERVAL '30 days'
          GROUP BY username
         HAVING SUM(cumulative_tokens) > 0`,
        [sub],
      ),
    ]);

    const preferences = {};
    preferencesR.rows.forEach((r) => { preferences[r.key] = r.value_json; });

    const t = thresholdsR.rows[0] || { whale_min: 200, big_tipper_min: 50, tipper_min: 10 };

    const history30d = {};
    history30dR.rows.forEach((r) => { history30d[r.username] = { total: r.total }; });

    return respond(200, {
      whales: whalesR.rows,
      prompts: promptsR.rows,
      preferences,
      thresholds: {
        whaleMin: t.whale_min,
        bigTipperMin: t.big_tipper_min,
        tipperMin: t.tipper_min,
      },
      history30d,
      pulledAt: Date.now(),
    });
  } catch (err) {
    console.error('[apex-sync-pull]', err);
    return respond(500, { error: 'internal', detail: err.message });
  }
};
