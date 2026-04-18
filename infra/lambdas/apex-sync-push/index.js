/**
 * apex-sync-push
 *
 * POST /sync/push
 * Authorization: Bearer <Cognito ID token>  (validated by API Gateway authorizer)
 *
 * Request body: { kind, payload }
 *
 * Supported kinds:
 *   'whale.upsert'       payload: { platform, username, cumulative_tokens?, tier?,
 *                                    last_tip_at?, session_count?, notes? }
 *   'whale.delete'       payload: { platform, username }
 *   'prompt.upsert'      payload: { id?, category, text, tone?, tts_voice?,
 *                                    physical_reaction_required?, enabled? }
 *   'prompt.delete'      payload: { id }
 *   'preference.set'     payload: { key, value }
 *   'thresholds.update'  payload: { whaleMin?, bigTipperMin?, tipperMin? }
 *
 * Idempotent by design. Runs UPSERTs on natural keys so the Desktop's offline
 * push queue can retry without creating duplicates.
 */

const { Client } = require('pg');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const sm = new SecretsManagerClient({});
let cachedSecret = null;

async function getDbConfig() {
  if (cachedSecret) return cachedSecret;
  const { SecretString } = await sm.send(new GetSecretValueCommand({ SecretId: process.env.DB_SECRET_ARN }));
  cachedSecret = JSON.parse(SecretString);
  return cachedSecret;
}

function respond(statusCode, body) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

async function applyMutation(client, sub, kind, payload) {
  switch (kind) {
    case 'whale.upsert': {
      const { platform, username, cumulative_tokens, tier, last_tip_at, session_count, notes } = payload;
      if (!platform || !username) throw new Error('platform and username required');
      await client.query(
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
      await client.query(
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
        await client.query(
          `UPDATE performer_prompts
              SET category = $3, text = $4, tone = $5, tts_voice = $6,
                  physical_reaction_required = COALESCE($7, physical_reaction_required),
                  enabled = COALESCE($8, enabled),
                  updated_at = NOW()
            WHERE id = $1 AND performer_sub = $2`,
          [id, sub, category, text, tone, tts_voice, physical_reaction_required, enabled],
        );
      } else {
        await client.query(
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
      await client.query(
        `DELETE FROM performer_prompts WHERE id = $1 AND performer_sub = $2`,
        [id, sub],
      );
      return { ok: true };
    }

    case 'preference.set': {
      const { key, value } = payload;
      if (!key) throw new Error('key required');
      await client.query(
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
      await client.query(
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
  const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims;
  const sub = claims && claims.sub;
  if (!sub) return respond(401, { error: 'unauthenticated' });

  let body;
  try {
    body = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'invalid_json' });
  }

  const { kind, payload } = body;
  if (!kind || !payload) return respond(400, { error: 'kind and payload required' });

  const cfg = await getDbConfig();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.dbname,
    connectionTimeoutMillis: 3000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();
    const result = await applyMutation(client, sub, kind, payload);
    return respond(200, result);
  } catch (err) {
    console.error('[apex-sync-push]', kind, err);
    return respond(err.message && err.message.endsWith('required') ? 400 : 500, {
      error: 'mutation_failed',
      kind,
      detail: err.message,
    });
  } finally {
    await client.end().catch(() => {});
  }
};
