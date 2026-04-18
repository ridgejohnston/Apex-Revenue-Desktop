/**
 * Apex Revenue — Cloud Sync Client
 *
 * Pulls and pushes performer data against the Apex API:
 *   GET  /sync/pull    → { whales, prompts, preferences, thresholds, history30d }
 *   POST /sync/push    → upserts individual rows with optimistic concurrency
 *
 * Authentication: Cognito ID token from shared/auth.js.
 *
 * Local cache: electron-store. RDS is the source of truth. On launch with valid
 * session, pulls fresh state and writes it to the local cache. On mutation,
 * writes locally immediately (optimistic) and enqueues a push. If the push
 * fails, the mutation stays in the queue and retries with exponential backoff.
 */

const https = require('https');
const Store = require('electron-store');
const { API_ENDPOINT } = require('../shared/aws-config');

const store = new Store({ name: 'apex-revenue-cloud-cache' });

const KEY_CACHE      = 'cloud.cache';           // { whales, prompts, preferences, thresholds, history30d, pulledAt }
const KEY_QUEUE      = 'cloud.pushQueue';       // [{ id, kind, payload, attempts, lastAttemptAt }]
const KEY_LAST_SYNC  = 'cloud.lastSuccessfulSync';

function apiFetch(path, idToken, options) {
  options = options || {};
  return new Promise((resolve, reject) => {
    const url = new URL(API_ENDPOINT + path);
    const headers = Object.assign(
      {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + idToken,
      },
      options.headers || {},
    );
    const req = https.request(
      {
        method: options.method || 'GET',
        hostname: url.hostname,
        path: url.pathname + url.search,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          try {
            const parsed = data ? JSON.parse(data) : {};
            if (res.statusCode >= 400) return reject(Object.assign(new Error('API error'), { status: res.statusCode, body: parsed }));
            resolve(parsed);
          } catch (e) {
            reject(e);
          }
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(JSON.stringify(options.body));
    req.end();
  });
}

// ── Pull ──────────────────────────────────────────────────────────────────────

async function pullAll(idToken) {
  const data = await apiFetch('/sync/pull', idToken, { method: 'GET' });
  const cache = {
    whales:      data.whales      || [],
    prompts:     data.prompts     || [],
    preferences: data.preferences || {},
    thresholds:  data.thresholds  || { whaleMin: 200, bigTipperMin: 50, tipperMin: 10 },
    history30d:  data.history30d  || {},
    pulledAt:    Date.now(),
  };
  store.set(KEY_CACHE, cache);
  store.set(KEY_LAST_SYNC, Date.now());
  return cache;
}

function getCached() {
  return store.get(KEY_CACHE) || null;
}

// ── Push (with offline queue) ─────────────────────────────────────────────────

/**
 * enqueuePush({ kind, payload })
 *   kind    — one of 'whale.upsert' | 'prompt.upsert' | 'preference.set' |
 *             'thresholds.update' | 'whale.delete' | 'prompt.delete'
 *   payload — row to upsert (server interprets based on kind)
 *
 * Writes locally immediately (caller should do the optimistic local cache update)
 * and enqueues the mutation for server push.
 */
function enqueuePush(item) {
  const queue = store.get(KEY_QUEUE) || [];
  queue.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    kind: item.kind,
    payload: item.payload,
    attempts: 0,
    lastAttemptAt: 0,
  });
  store.set(KEY_QUEUE, queue);
}

async function flushQueue(idToken) {
  const queue = store.get(KEY_QUEUE) || [];
  if (queue.length === 0) return { flushed: 0, remaining: 0 };

  let flushed = 0;
  const remaining = [];

  for (const item of queue) {
    // Exponential backoff: skip items whose next retry time hasn't arrived
    const backoff = Math.min(60000, 1000 * Math.pow(2, item.attempts));
    if (item.lastAttemptAt && Date.now() - item.lastAttemptAt < backoff) {
      remaining.push(item);
      continue;
    }
    try {
      await apiFetch('/sync/push', idToken, {
        method: 'POST',
        body: { kind: item.kind, payload: item.payload },
      });
      flushed += 1;
    } catch (e) {
      item.attempts += 1;
      item.lastAttemptAt = Date.now();
      if (item.attempts < 10) {
        remaining.push(item);
      } else {
        // 10 failed attempts → drop and log. In Phase 1 we'll surface a UI toast.
        console.warn('[CloudSync] Dropping push after 10 attempts:', item);
      }
    }
  }

  store.set(KEY_QUEUE, remaining);
  if (flushed > 0) store.set(KEY_LAST_SYNC, Date.now());
  return { flushed, remaining: remaining.length };
}

// ── Convenience wrappers for common mutations ────────────────────────────────

function upsertWhale(whale) {
  const cache = getCached() || { whales: [] };
  const idx = cache.whales.findIndex((w) => w.platform === whale.platform && w.username === whale.username);
  if (idx >= 0) {
    cache.whales[idx] = { ...cache.whales[idx], ...whale };
  } else {
    cache.whales.push(whale);
  }
  store.set(KEY_CACHE, cache);
  enqueuePush({ kind: 'whale.upsert', payload: whale });
}

function upsertPrompt(prompt) {
  const cache = getCached() || { prompts: [] };
  const idx = cache.prompts.findIndex((p) => p.id === prompt.id);
  if (idx >= 0) cache.prompts[idx] = { ...cache.prompts[idx], ...prompt };
  else cache.prompts.push(prompt);
  store.set(KEY_CACHE, cache);
  enqueuePush({ kind: 'prompt.upsert', payload: prompt });
}

function setPreference(key, value) {
  const cache = getCached() || { preferences: {} };
  cache.preferences[key] = value;
  store.set(KEY_CACHE, cache);
  enqueuePush({ kind: 'preference.set', payload: { key, value } });
}

function updateThresholds(thresholds) {
  const cache = getCached() || {};
  cache.thresholds = { ...(cache.thresholds || {}), ...thresholds };
  store.set(KEY_CACHE, cache);
  enqueuePush({ kind: 'thresholds.update', payload: thresholds });
}

module.exports = {
  pullAll,
  getCached,
  enqueuePush,
  flushQueue,
  upsertWhale,
  upsertPrompt,
  setPreference,
  updateThresholds,
};
