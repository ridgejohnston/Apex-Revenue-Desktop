// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — auth.js (Electron adaptation)
// AWS Cognito auth. Replaces chrome.storage.local with electronAPI.store
// ═══════════════════════════════════════════════════════════════════════════════

var APEX_COGNITO_REGION    = 'us-east-1';
var APEX_COGNITO_CLIENT_ID = '2q57i2f3sl6lcl8rlu7tt3dgdf';
var APEX_COGNITO_ENDPOINT  = 'https://cognito-idp.us-east-1.amazonaws.com';
var APEX_COGNITO_ISSUER    = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EjYUEgmKm';
var APEX_API_BASE          = 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod';
var APEX_SESSION_KEY       = 'apexSession';
var APEX_LINKED_KEY        = 'apexLinkedAccounts';
var APEX_ADMIN_KEY         = 'apexIsAdmin';
var APEX_MIGRATION_KEY     = 'apexMigratedToCognito';

// ── Storage helpers (Electron-safe) ──────────────────────────────────────────
function apexStoreGet(key) {
  return window.electronAPI.store.get(key);
}
function apexStoreSet(key, value) {
  return window.electronAPI.store.set(key, value);
}
function apexStoreDelete(key) {
  return window.electronAPI.store.delete(key);
}

// ── JWT parser ────────────────────────────────────────────────────────────────
function apexParseJwt(token) {
  try {
    var payload = token.split('.')[1];
    var decoded = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decoded);
  } catch(e) { return {}; }
}

// ── Session helpers ───────────────────────────────────────────────────────────
function apexGetSession() {
  return apexStoreGet(APEX_SESSION_KEY);
}
function apexSetSession(session) {
  return apexStoreSet(APEX_SESSION_KEY, session);
}
function apexClearSession() {
  return Promise.all([
    apexStoreDelete(APEX_SESSION_KEY),
    apexStoreDelete(APEX_LINKED_KEY),
    apexStoreDelete(APEX_ADMIN_KEY)
  ]);
}

// ── Session validation ────────────────────────────────────────────────────────
function apexIsValidCognitoSession(session) {
  if (!session || !session.access_token) return false;
  var claims = apexParseJwt(session.access_token);
  if (!claims.iss || claims.iss !== APEX_COGNITO_ISSUER) return false;
  var now = Math.floor(Date.now() / 1000);
  if (claims.exp && now > (claims.exp + 30)) return false;
  if (!claims.sub) return false;
  return true;
}

// ── Token refresh ─────────────────────────────────────────────────────────────
async function apexRefreshSession(session) {
  if (!session || !session.refresh_token) return null;
  try {
    var resp = await fetch(APEX_COGNITO_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
      },
      body: JSON.stringify({
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        ClientId: APEX_COGNITO_CLIENT_ID,
        AuthParameters: { REFRESH_TOKEN: session.refresh_token }
      })
    });
    var data = await resp.json();
    if (data.AuthenticationResult) {
      var newSession = {
        access_token:  data.AuthenticationResult.AccessToken,
        id_token:      data.AuthenticationResult.IdToken,
        refresh_token: session.refresh_token,
        expires_at:    Date.now() + (data.AuthenticationResult.ExpiresIn || 3600) * 1000
      };
      await apexSetSession(newSession);
      return newSession;
    }
    return null;
  } catch(e) {
    console.warn('[ApexAuth] Refresh failed:', e.message);
    return null;
  }
}

// ── Get valid session (auto-refresh) ─────────────────────────────────────────
async function apexGetValidSession() {
  var session = await apexGetSession();
  if (!session) return null;
  if (apexIsValidCognitoSession(session)) return session;
  return await apexRefreshSession(session);
}

// ── Sign in ───────────────────────────────────────────────────────────────────
async function apexSignIn(email, password) {
  var resp = await fetch(APEX_COGNITO_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-amz-json-1.1',
      'X-Amz-Target': 'AWSCognitoIdentityProviderService.InitiateAuth'
    },
    body: JSON.stringify({
      AuthFlow: 'USER_PASSWORD_AUTH',
      ClientId: APEX_COGNITO_CLIENT_ID,
      AuthParameters: { USERNAME: email, PASSWORD: password }
    })
  });
  var data = await resp.json();
  if (data.__type) throw new Error(data.message || data.__type);
  var session = {
    access_token:  data.AuthenticationResult.AccessToken,
    id_token:      data.AuthenticationResult.IdToken,
    refresh_token: data.AuthenticationResult.RefreshToken,
    expires_at:    Date.now() + (data.AuthenticationResult.ExpiresIn || 3600) * 1000
  };
  await apexSetSession(session);
  return session;
}

// ── Sign out ──────────────────────────────────────────────────────────────────
async function apexSignOut() {
  await apexClearSession();
}

// ── API fetch helper (auto-attaches Bearer token) ────────────────────────────
async function apexApiFetch(endpoint, options) {
  var session = await apexGetValidSession();
  var headers = Object.assign({
    'Content-Type': 'application/json'
  }, options && options.headers ? options.headers : {});
  if (session && session.access_token) {
    headers['Authorization'] = 'Bearer ' + session.access_token;
  }
  var resp = await fetch(APEX_API_BASE + endpoint, Object.assign({}, options, { headers }));
  var data = await resp.json();
  if (!resp.ok) throw new Error(data.message || data.error || 'API error ' + resp.status);
  return data;
}

// ── Get current user info from session ────────────────────────────────────────
async function apexGetUser() {
  var session = await apexGetValidSession();
  if (!session) return null;
  var claims = apexParseJwt(session.id_token || session.access_token);
  return {
    sub:   claims.sub,
    email: claims.email,
    username: claims['cognito:username'] || claims.email
  };
}
