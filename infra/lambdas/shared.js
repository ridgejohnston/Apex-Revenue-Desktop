// =============================================================
// Apex Revenue — Shared utilities for all Lambda functions
// =============================================================
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const { Pool } = require('pg');

let _config = null;
let _pool = null;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, content-type, x-api-key, stripe-signature',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json',
};

async function getConfig() {
  if (_config) return _config;
  const client = new SecretsManagerClient({ region: 'us-east-1' });
  const resp = await client.send(new GetSecretValueCommand({ SecretId: 'apexrevenue/config' }));
  _config = JSON.parse(resp.SecretString);
  return _config;
}

async function getPool() {
  if (_pool) return _pool;
  const config = await getConfig();
  _pool = new Pool({ connectionString: config.DATABASE_URL, max: 5, idleTimeoutMillis: 30000 });
  return _pool;
}

async function query(sql, params = []) {
  const pool = await getPool();
  return pool.query(sql, params);
}

function respond(statusCode, body) {
  return { statusCode, headers: CORS_HEADERS, body: JSON.stringify(body) };
}

function handleCors(event) {
  if (event.httpMethod === 'OPTIONS') {
    return respond(200, { ok: true });
  }
  return null;
}

function parseBody(event) {
  if (!event.body) return {};
  try {
    return JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString() : event.body);
  } catch {
    return {};
  }
}

// Extract Cognito user from Authorization header (JWT)
function getUserFromToken(event) {
  // API Gateway Cognito authorizer puts claims in requestContext
  const claims = event.requestContext?.authorizer?.claims;
  if (claims) {
    return { id: claims.sub, email: claims.email, emailVerified: claims.email_verified === 'true' };
  }
  return null;
}

module.exports = { getConfig, getPool, query, respond, handleCors, parseBody, getUserFromToken, CORS_HEADERS };
