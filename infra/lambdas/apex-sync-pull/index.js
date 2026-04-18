/**
 * apex-sync-pull
 *
 * GET /sync/pull
 * Authorization: Bearer <Cognito ID token>  (validated by API Gateway authorizer)
 *
 * Returns all cloud-synced performer data in one shot. Desktop calls this on
 * app launch (with valid session) to seed electron-store cache.
 *
 * Response shape:
 *   {
 *     whales:      [{ platform, username, cumulative_tokens, tier, first_seen,
 *                     last_seen, last_tip_at, session_count, notes }],
 *     prompts:     [{ id, category, text, tone, tts_voice,
 *                     physical_reaction_required, enabled }],
 *     preferences: { [key]: value },
 *     thresholds:  { whaleMin, bigTipperMin, tipperMin },
 *     history30d:  { [username]: { total } },
 *     pulledAt:    <server timestamp ms>
 *   }
 *
 * Environment:
 *   DB_SECRET_ARN  Secrets Manager ARN for { host, port, user, password, dbname }
 *                  — reuses existing VPC Secrets Manager endpoint pattern.
 *   DB_CONNECT_TIMEOUT_MS  optional, defaults to 3000
 *
 * Deployment: VPC-bound (same config as the 41 existing Lambdas), RDS Proxy
 * endpoint, 10s timeout, 512MB memory, Node 20.x.
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

exports.handler = async (event) => {
  const claims = event.requestContext && event.requestContext.authorizer && event.requestContext.authorizer.claims;
  const sub = claims && claims.sub;
  if (!sub) return respond(401, { error: 'unauthenticated' });

  const cfg = await getDbConfig();
  const client = new Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.dbname,
    connectionTimeoutMillis: Number(process.env.DB_CONNECT_TIMEOUT_MS) || 3000,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await client.connect();

    // Run pulls in parallel — all read-only
    const [whalesR, promptsR, preferencesR, thresholdsR, history30dR] = await Promise.all([
      client.query(
        `SELECT platform, username, cumulative_tokens, tier,
                first_seen, last_seen, last_tip_at, session_count, notes
           FROM performer_whales
          WHERE performer_sub = $1
          ORDER BY cumulative_tokens DESC
          LIMIT 5000`,
        [sub],
      ),
      client.query(
        `SELECT id, category, text, tone, tts_voice,
                physical_reaction_required, enabled
           FROM performer_prompts
          WHERE performer_sub = $1 AND enabled = TRUE
          ORDER BY category, updated_at DESC`,
        [sub],
      ),
      client.query(
        `SELECT key, value_json
           FROM performer_preferences
          WHERE performer_sub = $1`,
        [sub],
      ),
      client.query(
        `SELECT whale_min, big_tipper_min, tipper_min
           FROM performer_signal_thresholds
          WHERE performer_sub = $1`,
        [sub],
      ),
      // 30-day per-username history (drives hvReturnee signal). Groups by username,
      // rolls up tokens across all platforms the performer works on.
      client.query(
        `SELECT w.username, SUM(w.cumulative_tokens)::INTEGER AS total
           FROM performer_whales w
          WHERE w.performer_sub = $1
            AND w.last_seen >= NOW() - INTERVAL '30 days'
          GROUP BY w.username
         HAVING SUM(w.cumulative_tokens) > 0`,
        [sub],
      ),
    ]);

    const preferences = {};
    preferencesR.rows.forEach((r) => { preferences[r.key] = r.value_json; });

    const thresholds = thresholdsR.rows[0] || { whale_min: 200, big_tipper_min: 50, tipper_min: 10 };

    const history30d = {};
    history30dR.rows.forEach((r) => { history30d[r.username] = { total: r.total }; });

    return respond(200, {
      whales: whalesR.rows,
      prompts: promptsR.rows,
      preferences,
      thresholds: {
        whaleMin: thresholds.whale_min,
        bigTipperMin: thresholds.big_tipper_min,
        tipperMin: thresholds.tipper_min,
      },
      history30d,
      pulledAt: Date.now(),
    });
  } catch (err) {
    console.error('[apex-sync-pull]', err);
    return respond(500, { error: 'internal', detail: err.message });
  } finally {
    await client.end().catch(() => {});
  }
};
