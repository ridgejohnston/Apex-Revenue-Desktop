/**
 * Apex Revenue — App-level constants
 *
 * v3.2.0 — Phase 0 parity drop
 *
 * Backward-compatibility note: WHALE_TIERS retains the legacy static `.min`
 * fields so existing consumers (renderer/src/components/RightPanel.jsx lines
 * 502-504 and the compiled renderer/dist/bundle.js) continue to work
 * unchanged. New code should prefer `tierFromTotal(total, thresholds)` which
 * uses the model's own thresholds pulled from RDS.
 *
 * Terminology: "model" (the on-camera user of this app). Older code uses
 * "performer" interchangeably — both refer to the same person. Going forward
 * new UI strings, system prompts, and public-facing copy should use "model".
 */

const DEFAULT_THRESHOLDS = Object.freeze({
  whaleMin:     200,
  bigTipperMin: 50,
  tipperMin:    10,
});

const WHALE_TIERS = {
  TIER_1: { min: DEFAULT_THRESHOLDS.whaleMin,     label: 'Whale',       color: '#FFD700', emoji: '🐋' },
  TIER_2: { min: DEFAULT_THRESHOLDS.bigTipperMin, label: 'Big Tipper',  color: '#C0C0C0', emoji: '🐬' },
  TIER_3: { min: DEFAULT_THRESHOLDS.tipperMin,    label: 'Tipper',      color: '#CD7F32', emoji: '🐟' },
  TIER_4: { min: 0,                               label: 'Viewer',      color: '#666',    emoji: '👤' },
};

/**
 * Resolves a cumulative token total to a whale tier using the model's
 * dynamic thresholds (falling back to DEFAULT_THRESHOLDS if not provided).
 */
function tierFromTotal(total, thresholds) {
  const t = thresholds || DEFAULT_THRESHOLDS;
  if (total >= t.whaleMin)     return { ...WHALE_TIERS.TIER_1, min: t.whaleMin };
  if (total >= t.bigTipperMin) return { ...WHALE_TIERS.TIER_2, min: t.bigTipperMin };
  if (total >= t.tipperMin)    return { ...WHALE_TIERS.TIER_3, min: t.tipperMin };
  return WHALE_TIERS.TIER_4;
}

module.exports = {
  APP_NAME: 'Apex Revenue',
  EXTENSION_ID: 'desktop',
  VERSION: '3.4.33',

  DEFAULT_PLATFORMS: {
    'Live Cams': [
      { name: 'Chaturbate',  url: 'https://chaturbate.com/',       tracked: true,  icon: '🔥' },
      { name: 'Stripchat',   url: 'https://stripchat.com/',        tracked: true,  icon: '💎' },
      { name: 'MyFreeCams',  url: 'https://www.myfreecams.com/',   tracked: true,  icon: '🌟' },
      { name: 'xTease',      url: 'https://xtease.com/',           tracked: true,  icon: '⚡' },
      { name: 'CamSoda',     url: 'https://www.camsoda.com/',      tracked: false, icon: '🎥' },
      { name: 'Flirt4Free',  url: 'https://www.flirt4free.com/',   tracked: false, icon: '💬' },
      { name: 'LiveJasmin',  url: 'https://www.livejasmin.com/',   tracked: false, icon: '🌹' },
      { name: 'BongaCams',   url: 'https://bongacams.com/',        tracked: false, icon: '🎤' },
      { name: 'Cam4',        url: 'https://www.cam4.com/',         tracked: false, icon: '4️⃣' },
      { name: 'ImLive',      url: 'https://www.imlive.com/',       tracked: false, icon: '👁️' },
      { name: 'Streamate',   url: 'https://www.streamate.com/',    tracked: false, icon: '📡' },
    ],
    'Fan Sites': [
      { name: 'OnlyFans',   url: 'https://onlyfans.com/',     icon: '🅾️' },
      { name: 'Fansly',     url: 'https://fansly.com/',       icon: '💙' },
      { name: 'ManyVids',   url: 'https://www.manyvids.com/', icon: '🎬' },
      { name: 'Fanvue',     url: 'https://fanvue.com/',       icon: '👀' },
      { name: 'Patreon',    url: 'https://www.patreon.com/',  icon: '🎨' },
      { name: 'LoyalFans',  url: 'https://www.loyalfans.com/',icon: '❤️' },
    ],
    'Clip Stores': [
      { name: 'Clips4Sale',  url: 'https://www.clips4sale.com/',  icon: '🎞️' },
      { name: 'iWantClips',  url: 'https://iwantclips.com/',      icon: '🛒' },
      { name: 'Modelhub',    url: 'https://www.modelhub.com/',    icon: '📦' },
      { name: 'NiteFlirt',   url: 'https://www.niteflirt.com/',   icon: '📞' },
    ],
  },

  DEFAULT_THRESHOLDS,
  WHALE_TIERS,
  tierFromTotal,

  /**
   * Broadcast policy.
   *
   * Models on the Platinum (Tier 2) and Agency (Tier 3) subscription
   * plans get UNLIMITED broadcasting as part of their subscription.
   * There is no hourly cap, no overage billing, no STS scoping — if
   * the model is on a paid tier, they stream as long as they want.
   *
   * The Free tier has no broadcast-duration limits imposed by this app
   * either. Whatever broadcast limits exist for Free users come from
   * feature gating elsewhere (e.g. the Beauty Filter unlock check in
   * shared/beauty-config.js), not from a time-based quota.
   *
   * This object is intentionally minimal. It exists as a single
   * documented source of truth so anyone reading the codebase sees
   * "broadcasting is unlimited on paid tiers" directly rather than
   * having to infer it from the absence of cap-checking code. The
   * broadcast-ledger module records session data for analytics only —
   * never for enforcement.
   */
  BROADCAST_POLICY: Object.freeze({
    PLANS_WITH_UNLIMITED_BROADCAST: Object.freeze(['platinum', 'agency']),
    ENFORCE_DURATION_CAP: false,
    OVERAGE_BILLING_ENABLED: false,
  }),

  AI_TRIGGERS: {
    // Legacy triggers (preserved — fireTrigger in main/main.js references these)
    DEAD_AIR:         { key: 'dead_air',         cooldownMs: 180000, label: 'Dead Air' },
    VIEWER_SURGE:     { key: 'viewer_surge',     cooldownMs: 300000, label: 'Viewer Surge' },
    WHALE_PRESENT:    { key: 'whale_present',    cooldownMs: 120000, label: 'Whale Alert' },
    HOT_STREAK:       { key: 'hot_streak',       cooldownMs: 300000, label: 'Hot Streak' },

    // Phase 0 additions — platinum-tier signals ported from extension overlay.js
    CASCADE:          { key: 'cascade',          cooldownMs: 120000, label: 'Tip Cascade' },
    CHURN_RISK_WHALE: { key: 'churn_risk_whale', cooldownMs: 180000, label: 'Whale Drifting' },
    HV_RETURNEE:      { key: 'hv_returnee',      cooldownMs: 240000, label: 'Returning VIP' },
    ANCHOR:           { key: 'anchor',           cooldownMs: 300000, label: 'Anchor Fan' },
  },
};
