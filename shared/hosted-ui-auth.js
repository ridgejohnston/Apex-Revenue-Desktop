/**
 * Apex Revenue — Cognito Hosted UI (OAuth 2.0 Authorization Code + PKCE)
 *
 * Flow:
 *   1. Generate PKCE verifier + challenge, store verifier in memory.
 *   2. Open Hosted UI /oauth2/authorize in the system browser (via main).
 *   3. Cognito redirects to apexrevenue://auth/callback?code=...
 *   4. Custom protocol handler in main.js delivers the code here.
 *   5. Exchange code for {id,access,refresh} tokens at /oauth2/token.
 *   6. Parse ID token for `cognito:groups` — drives admin/beta detection.
 *
 * The Desktop client is a public client (no secret), so token exchange
 * requires PKCE rather than client_secret.
 */

const crypto = require('crypto');
const https  = require('https');
const {
  COGNITO_HOSTED_UI_DOMAIN,
  COGNITO_CLIENT_ID,
  COGNITO_REDIRECT_URI,
  COGNITO_LOGOUT_URI,
  COGNITO_OAUTH_SCOPES,
} = require('./aws-config');

// ─── PKCE helpers ───────────────────────────────────────────
function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkcePair() {
  const verifier  = base64urlEncode(crypto.randomBytes(32));
  const challenge = base64urlEncode(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

// ─── Authorize URL ──────────────────────────────────────────
function buildAuthorizeUrl(challenge, state) {
  const params = new URLSearchParams({
    client_id:             COGNITO_CLIENT_ID,
    response_type:         'code',
    scope:                 COGNITO_OAUTH_SCOPES,
    redirect_uri:          COGNITO_REDIRECT_URI,
    code_challenge:        challenge,
    code_challenge_method: 'S256',
    state,
  });
  return `https://${COGNITO_HOSTED_UI_DOMAIN}/oauth2/authorize?${params.toString()}`;
}

function buildLogoutUrl() {
  const params = new URLSearchParams({
    client_id:   COGNITO_CLIENT_ID,
    logout_uri:  COGNITO_LOGOUT_URI,
  });
  return `https://${COGNITO_HOSTED_UI_DOMAIN}/logout?${params.toString()}`;
}

// ─── Token exchange ─────────────────────────────────────────
function postForm(pathname, body) {
  return new Promise((resolve, reject) => {
    const payload = new URLSearchParams(body).toString();
    const options = {
      host: COGNITO_HOSTED_UI_DOMAIN,
      path: pathname,
      method: 'POST',
      headers: {
        'Content-Type':   'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error_description || parsed.error || data));
          else resolve(parsed);
        } catch (e) { reject(new Error(`Token endpoint returned non-JSON: ${data}`)); }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function exchangeCodeForTokens(code, verifier) {
  const tokens = await postForm('/oauth2/token', {
    grant_type:    'authorization_code',
    client_id:     COGNITO_CLIENT_ID,
    code,
    redirect_uri:  COGNITO_REDIRECT_URI,
    code_verifier: verifier,
  });
  return normalizeTokens(tokens);
}

async function refreshTokens(refreshToken) {
  const tokens = await postForm('/oauth2/token', {
    grant_type:    'refresh_token',
    client_id:     COGNITO_CLIENT_ID,
    refresh_token: refreshToken,
  });
  // Refresh response does NOT include a new refresh_token — preserve the old one.
  return { ...normalizeTokens({ ...tokens, refresh_token: refreshToken }) };
}

function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

function normalizeGroups(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    return raw.trim().replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
  }
  return [];
}

function normalizeTokens(tokens) {
  const claims = tokens.id_token ? parseJwt(tokens.id_token) : null;
  const groups = normalizeGroups(claims?.['cognito:groups']);
  return {
    idToken:       tokens.id_token,
    accessToken:   tokens.access_token,
    refreshToken:  tokens.refresh_token,
    expiresIn:     tokens.expires_in,
    tokenType:     tokens.token_type,
    claims,
    email:         claims?.email || null,
    groups,
    isAdmin:       groups.includes('admins'),
    isBeta:        groups.includes('beta'),
    issuedAt:      Date.now(),
  };
}

function isSessionValid(session) {
  if (!session?.idToken) return false;
  const claims = parseJwt(session.idToken);
  if (!claims?.exp) return false;
  return (claims.exp * 1000) > (Date.now() + 30000); // 30s skew
}

function needsRefresh(session) {
  if (!session?.idToken || !session?.refreshToken) return false;
  const claims = parseJwt(session.idToken);
  if (!claims?.exp) return true;
  // Refresh if the ID token expires in under 5 minutes.
  return (claims.exp * 1000) < (Date.now() + 5 * 60 * 1000);
}

module.exports = {
  generatePkcePair,
  buildAuthorizeUrl,
  buildLogoutUrl,
  exchangeCodeForTokens,
  refreshTokens,
  parseJwt,
  normalizeGroups,
  isSessionValid,
  needsRefresh,
};
