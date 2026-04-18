/**
 * apex-extension-migrate
 *
 * POST /extension/migrate
 * Authorization: Bearer <Cognito ID token>  (validated by API Gateway authorizer)
 *
 * Called by the last Chrome extension release when the performer clicks
 * "Migrate to Desktop." Bulk-imports the extension's local state into RDS
 * under the authenticated Cognito sub. Idempotent — safe to run multiple times.
 *
 * Request body (extension payload):
 *   {
 *     extensionVersion: string,
 *     exportedAt: number,
 *     whales: [
 *       { platform, username, cumulative_tokens, tier?, notes?,
 *         first_seen?, last_seen?, last_tip_at?, session_count? }
 *     ],
 *     customPrompts: [
 *       { category, text, tone?, enabled? }
 *     ],
 *     preferences: { [key]: value },
 *     thresholds: { whaleMin?, bigTipperMin?, tipperMin? }
 *   }
 *
 * Returns:
 *   {
 *     migrated: { whales: N, prompts: N, preferences: N, thresholds: boolean },
 *     migratedAt: <server ms>,
 *     idempotencyKey: <hash> — future migrations with same key are no-ops
 *   }
 *
 * Idempotency: each extension payload generates a hash key. If the same
 * performer submits the same payload twice within 24h, the second call
 * short-circuits to success. Stored in performer_preferences under key
 * '_migration.extension'.
 */

const crypto = require('crypto');
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

function payloadHash(p) {
  const canonical = JSON.stringify({
    w: (p.whales || []).map((x) => [x.platform, x.username, x.cumulative_tokens]).sort(),
    pr: (p.customPrompts || []).map((x) => [x.category, x.text]).sort(),
    pf: Object.keys(p.preferences || {}).sort().map((k) => [k, p.preferences[k]]),
    t: p.thresholds || {},
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

exports.handler = async (event) => {
  const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims;
  const sub = claims && claims.sub;
  if (!sub) return respond(401, { error: 'unauthenticated' });

  let payload;
  try {
    payload = JSON.parse(event.body || '{}');
  } catch {
    return respond(400, { error: 'invalid_json' });
  }

  const whales = Array.isArray(payload.whales) ? payload.whales : [];
  const prompts = Array.isArray(payload.customPrompts) ? payload.customPrompts : [];
  const preferences = payload.preferences || {};
  const thresholds = payload.thresholds || null;

  const hash = payloadHash(payload);
  const cfg = await getDbConfig();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.dbname,
    connectionTimeoutMillis: 5000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Idempotency check
    const prior = await client.query(
      `SELECT value_json FROM performer_preferences
         WHERE performer_sub = $1 AND key = $2`,
      [sub, '_migration.extension'],
    );
    if (prior.rows[0]) {
      const v = prior.rows[0].value_json;
      if (v && v.hash === hash && Date.now() - (v.migratedAt || 0) < 24 * 3600 * 1000) {
        return respond(200, {
          migrated: v.counts || {},
          migratedAt: v.migratedAt,
          idempotencyKey: hash,
          note: 'replay',
        });
      }
    }

    // Transaction wraps the whole migration so a mid-import failure doesn't
    // leave partial state.
    await client.query('BEGIN');

    // Whales
    let whalesMigrated = 0;
    for (const w of whales) {
      if (!w.platform || !w.username) continue;
      await client.query(
        `INSERT INTO performer_whales
           (performer_sub, platform, username, cumulative_tokens, tier, notes,
            first_seen, last_seen, last_tip_at, session_count)
         VALUES ($1, $2, $3, COALESCE($4, 0), $5, $6,
                 COALESCE(to_timestamp($7 / 1000.0), NOW()),
                 COALESCE(to_timestamp($8 / 1000.0), NOW()),
                 CASE WHEN $9 IS NULL THEN NULL ELSE to_timestamp($9 / 1000.0) END,
                 COALESCE($10, 0))
         ON CONFLICT (performer_sub, platform, username) DO UPDATE SET
           cumulative_tokens = GREATEST(performer_whales.cumulative_tokens, EXCLUDED.cumulative_tokens),
           tier              = COALESCE(EXCLUDED.tier, performer_whales.tier),
           notes             = COALESCE(EXCLUDED.notes, performer_whales.notes),
           last_seen         = GREATEST(performer_whales.last_seen, EXCLUDED.last_seen),
           last_tip_at       = GREATEST(performer_whales.last_tip_at, EXCLUDED.last_tip_at),
           session_count     = GREATEST(performer_whales.session_count, EXCLUDED.session_count)`,
        [
          sub, w.platform, w.username,
          w.cumulative_tokens, w.tier, w.notes,
          w.first_seen, w.last_seen, w.last_tip_at, w.session_count,
        ],
      );
      whalesMigrated += 1;
    }

    // Prompts
    let promptsMigrated = 0;
    for (const p of prompts) {
      if (!p.category || !p.text) continue;
      // Dedupe on (performer_sub, category, text) — if the exact prompt already
      // exists we skip rather than creating a duplicate row.
      const existing = await client.query(
        `SELECT id FROM performer_prompts
           WHERE performer_sub = $1 AND category = $2 AND text = $3
           LIMIT 1`,
        [sub, p.category, p.text],
      );
      if (existing.rows[0]) continue;
      await client.query(
        `INSERT INTO performer_prompts
           (performer_sub, category, text, tone, physical_reaction_required, enabled)
         VALUES ($1, $2, $3, $4, COALESCE($5, TRUE), COALESCE($6, TRUE))`,
        [sub, p.category, p.text, p.tone, p.physical_reaction_required, p.enabled],
      );
      promptsMigrated += 1;
    }

    // Preferences
    let preferencesMigrated = 0;
    for (const [key, value] of Object.entries(preferences)) {
      if (!key || key.startsWith('_migration.')) continue; // reserved namespace
      await client.query(
        `INSERT INTO performer_preferences (performer_sub, key, value_json, updated_at)
         VALUES ($1, $2, $3::jsonb, NOW())
         ON CONFLICT (performer_sub, key) DO UPDATE
           SET value_json = EXCLUDED.value_json,
               updated_at = NOW()`,
        [sub, key, JSON.stringify(value)],
      );
      preferencesMigrated += 1;
    }

    // Thresholds
    let thresholdsMigrated = false;
    if (thresholds && (thresholds.whaleMin || thresholds.bigTipperMin || thresholds.tipperMin)) {
      await client.query(
        `INSERT INTO performer_signal_thresholds
           (performer_sub, whale_min, big_tipper_min, tipper_min, updated_at)
         VALUES ($1, COALESCE($2, 200), COALESCE($3, 50), COALESCE($4, 10), NOW())
         ON CONFLICT (performer_sub) DO UPDATE
           SET whale_min      = COALESCE($2, performer_signal_thresholds.whale_min),
               big_tipper_min = COALESCE($3, performer_signal_thresholds.big_tipper_min),
               tipper_min     = COALESCE($4, performer_signal_thresholds.tipper_min),
               updated_at     = NOW()`,
        [sub, thresholds.whaleMin, thresholds.bigTipperMin, thresholds.tipperMin],
      );
      thresholdsMigrated = true;
    }

    // Record idempotency marker
    const counts = {
      whales: whalesMigrated,
      prompts: promptsMigrated,
      preferences: preferencesMigrated,
      thresholds: thresholdsMigrated,
    };
    const migratedAt = Date.now();
    await client.query(
      `INSERT INTO performer_preferences (performer_sub, key, value_json, updated_at)
       VALUES ($1, '_migration.extension', $2::jsonb, NOW())
       ON CONFLICT (performer_sub, key) DO UPDATE
         SET value_json = EXCLUDED.value_json,
             updated_at = NOW()`,
      [sub, JSON.stringify({ hash, migratedAt, counts, extensionVersion: payload.extensionVersion })],
    );

    await client.query('COMMIT');

    return respond(200, {
      migrated: counts,
      migratedAt,
      idempotencyKey: hash,
    });
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('[apex-extension-migrate]', err);
    return respond(500, { error: 'migration_failed', detail: err.message });
  } finally {
    await client.end().catch(() => {});
  }
};
