/**
 * Apex Revenue — Subscription & Billing Manager
 *
 * Talks to /check-subscription for the source-of-truth tier, but layers on
 * Desktop-specific behavior the web app doesn't need:
 *
 *   • 3-day offline grace period — if the check fails (network / API down),
 *     the last known plan stays active for up to 3 days past the last
 *     successful check. After that, plan soft-expires to `free`.
 *
 *   • Expiry warning ledger — tracks which notification windows (72h, 24h)
 *     have already fired per subscription period so the user doesn't get
 *     spammed on every tick.
 *
 *   • Admin toggle override — admins in the UI can force the effective
 *     tier to `free` or `platinum` without affecting their actual backend
 *     entitlement (used for Dev Access QA).
 *
 * All state is passed in/out of this module; persistence is handled by
 * main.js via electron-store. This keeps the module pure and testable.
 */

const https = require('https');
const {
  API_ENDPOINT,
  SUBSCRIPTION_OFFLINE_GRACE_MS,
  EXPIRY_WARNING_HOURS,
} = require('./aws-config');

// ─── Feature map (mirrors the platinum/free split in the Chrome ext) ────
const FEATURE_MAP = {
  free: {
    aiPrompts:    false,
    voiceAlerts:  false,
    s3Backup:     false,
    obsStreaming: false,
    virtualCam:   false,
    cloudSync:    false,
    whaleAlerts:  false,
    beautyFilter: false,
  },
  platinum: {
    aiPrompts:    true,
    voiceAlerts:  true,
    s3Backup:     true,
    obsStreaming: true,
    virtualCam:   true,
    cloudSync:    true,
    whaleAlerts:  true,
    beautyFilter: true,
  },
};

function hasFeature(plan, feature) {
  return FEATURE_MAP[plan]?.[feature] ?? false;
}

// ─── Live check against /check-subscription ─────────────────────────────
function callCheckSubscription(idToken) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_ENDPOINT}/check-subscription`);
    const options = {
      method:  'GET',
      host:    url.host,
      path:    url.pathname + url.search,
      headers: { Authorization: `Bearer ${idToken}` },
      timeout: 10000,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(parsed.error || `HTTP ${res.statusCode}`));
          else resolve(parsed);
        } catch (e) { reject(new Error('Bad response from /check-subscription')); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Fetch the live plan; on failure, return the cached plan with an
 * `offline: true` flag and a `graceRemainingMs` countdown.
 *
 * @param {string} idToken
 * @param {object|null} cached  { plan, expiresAt, checkedAt, billingSource, groups, ... }
 * @returns {Promise<{plan, expiresAt, billingSource, groups, offline, softExpired, graceRemainingMs, raw?}>}
 */
async function fetchSubscription(idToken, cached) {
  try {
    const raw = await callCheckSubscription(idToken);
    return {
      plan:          raw.plan || 'free',
      expiresAt:     raw.subscription?.current_period_end || null,
      billingSource: raw.billingSource || 'stripe',
      groups:        raw.groups || [],
      features:      raw.features || [],
      featureMap:    raw.feature_map || null,
      verified:      raw.verified !== false,
      offline:       false,
      softExpired:   false,
      graceRemainingMs: null,
      checkedAt:     Date.now(),
      raw,
    };
  } catch (err) {
    // Network error — fall back to cache with grace window
    if (!cached || !cached.checkedAt) {
      return {
        plan: 'free', expiresAt: null, billingSource: 'offline',
        groups: [], features: [], featureMap: null, verified: false,
        offline: true, softExpired: true, graceRemainingMs: 0,
        checkedAt: null, error: err.message,
      };
    }
    const age = Date.now() - cached.checkedAt;
    const graceRemainingMs = Math.max(0, SUBSCRIPTION_OFFLINE_GRACE_MS - age);
    const softExpired = graceRemainingMs <= 0;
    return {
      plan:          softExpired ? 'free' : (cached.plan || 'free'),
      expiresAt:     cached.expiresAt || null,
      billingSource: cached.billingSource || 'offline',
      groups:        cached.groups || [],
      features:      cached.features || [],
      featureMap:    cached.featureMap || null,
      verified:      false,
      offline:       true,
      softExpired,
      graceRemainingMs,
      checkedAt:     cached.checkedAt,
      error:         err.message,
    };
  }
}

// ─── Expiry notifications ──────────────────────────────────────────────
/**
 * Given the current subscription and a notification ledger, return the
 * warning windows that should fire right now and an updated ledger.
 *
 * Ledger key format: `${periodEndISO}:${hours}` — this auto-resets the
 * warnings when Stripe renews the subscription (new period_end).
 *
 * Beta & admin tiers never trigger warnings (they don't expire).
 *
 * @param {object} sub         { plan, expiresAt, billingSource }
 * @param {object} ledger      { [key]: timestamp } — fired markers
 * @returns {{toFire: Array<{hours, expiresAt, hoursRemaining}>, ledger}}
 */
function computeExpiryWarnings(sub, ledger = {}) {
  const toFire = [];
  const nextLedger = { ...ledger };

  if (!sub || !sub.expiresAt)             return { toFire, ledger: nextLedger };
  if (sub.billingSource === 'admin')      return { toFire, ledger: nextLedger };
  if (sub.billingSource === 'beta')       return { toFire, ledger: nextLedger };
  if (sub.plan !== 'platinum')            return { toFire, ledger: nextLedger };

  const expiresAt = new Date(sub.expiresAt).getTime();
  const now = Date.now();
  const msRemaining = expiresAt - now;
  if (msRemaining <= 0) return { toFire, ledger: nextLedger };

  const hoursRemaining = msRemaining / (60 * 60 * 1000);

  // Sort descending so the 72h warning always fires before the 24h one
  const windows = [...EXPIRY_WARNING_HOURS].sort((a, b) => b - a);
  for (const hours of windows) {
    if (hoursRemaining > hours) continue; // not yet in window
    const key = `${sub.expiresAt}:${hours}`;
    if (nextLedger[key]) continue; // already fired for this period
    nextLedger[key] = now;
    toFire.push({ hours, expiresAt: sub.expiresAt, hoursRemaining: Math.round(hoursRemaining) });
  }

  return { toFire, ledger: nextLedger };
}

// ─── Effective tier (applies admin toggle override) ─────────────────────
/**
 * Resolve the tier the UI should actually render.
 *
 * @param {object} session  { isAdmin, isBeta, ... }
 * @param {object} sub      { plan, billingSource, softExpired, ... }
 * @param {'free'|'platinum'|null} adminToggle  Only honored if isAdmin
 * @returns {{effectivePlan, source, isAdminOverride}}
 */
function resolveEffectivePlan(session, sub, adminToggle) {
  if (session?.isAdmin && (adminToggle === 'free' || adminToggle === 'platinum')) {
    return {
      effectivePlan:   adminToggle,
      source:          'admin-toggle',
      isAdminOverride: true,
    };
  }
  return {
    effectivePlan:   sub?.plan || 'free',
    source:          sub?.billingSource || 'unknown',
    isAdminOverride: false,
  };
}

module.exports = {
  FEATURE_MAP,
  hasFeature,
  fetchSubscription,
  computeExpiryWarnings,
  resolveEffectivePlan,
};
