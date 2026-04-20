/**
 * Apex Revenue — AWS Cognito Authentication
 */

const https = require('https');
const { REGION, COGNITO_USER_POOL_ID, COGNITO_CLIENT_ID } = require('./aws-config');

const COGNITO_ENDPOINT = `https://cognito-idp.${REGION}.amazonaws.com/`;

function cognitoRequest(action, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const options = {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(COGNITO_ENDPOINT, options, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(parsed);
          else resolve(parsed);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function parseJwt(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64').toString());
  } catch { return null; }
}

async function signIn(email, password) {
  const result = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  const auth = result.AuthenticationResult;
  return {
    accessToken: auth.AccessToken,
    idToken: auth.IdToken,
    refreshToken: auth.RefreshToken,
    expiresIn: auth.ExpiresIn,
    claims: parseJwt(auth.IdToken),
  };
}

async function refreshSession(refreshToken) {
  const result = await cognitoRequest('InitiateAuth', {
    AuthFlow: 'REFRESH_TOKEN_AUTH',
    ClientId: COGNITO_CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: refreshToken },
  });
  const auth = result.AuthenticationResult;
  return {
    accessToken: auth.AccessToken,
    idToken: auth.IdToken,
    expiresIn: auth.ExpiresIn,
    claims: parseJwt(auth.IdToken),
  };
}

function isSessionValid(session) {
  if (!session?.idToken) return false;
  const claims = parseJwt(session.idToken);
  if (!claims?.exp) return false;
  return (claims.exp * 1000) > (Date.now() + 30000);
}

function getEmail(session) {
  if (!session?.idToken) return null;
  const claims = parseJwt(session.idToken);
  return claims?.email || null;
}

/** Cognito `sub` — stable per user, used for S3 prefixes and sync key material. */
function getSub(session) {
  if (!session?.idToken) return null;
  const claims = parseJwt(session.idToken);
  return claims?.sub || null;
}

module.exports = { signIn, refreshSession, isSessionValid, getEmail, getSub, parseJwt };
