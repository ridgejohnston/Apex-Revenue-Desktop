/**
 * Apex Revenue — Beauty Filter Configuration
 *
 * Shared between renderer (live filter + settings UI) and main (store
 * persistence). The BeautyFilter class owns the runtime behavior; this
 * module just defines defaults, slider bounds, and the tier gate.
 */

const BEAUTY_DEFAULTS = Object.freeze({
  enabled:    false,   // off by default — performer opts in explicitly
  intensity:  50,      // 0–100
  smoothness: 50,      // 0–100 → bilateral sigma_color
  warmth:     0,       // -100..+100
  brightness: 0,       // -100..+100
});

const BEAUTY_BOUNDS = Object.freeze({
  intensity:  { min: 0,    max: 100 },
  smoothness: { min: 0,    max: 100 },
  warmth:     { min: -100, max: 100 },
  brightness: { min: -100, max: 100 },
});

// Store key used by electron-store in main, and by window.electronAPI.store
// in the renderer. Single source of truth so the two sides never drift.
const BEAUTY_STORE_KEY = 'beautyFilterConfig';

/**
 * Feature gate: beauty filter is a Platinum feature. Beta users see it
 * (they get Platinum for free), Free users see a locked panel with an
 * upsell, Admins see it regardless via the DEV toggle.
 */
function isBeautyUnlocked(effectivePlan) {
  return effectivePlan === 'platinum';
}

function clampConfig(cfg = {}) {
  const c = { ...BEAUTY_DEFAULTS, ...cfg };
  for (const [k, { min, max }] of Object.entries(BEAUTY_BOUNDS)) {
    if (typeof c[k] === 'number') c[k] = Math.max(min, Math.min(max, c[k]));
  }
  c.enabled = !!c.enabled;
  return c;
}

module.exports = {
  BEAUTY_DEFAULTS,
  BEAUTY_BOUNDS,
  BEAUTY_STORE_KEY,
  isBeautyUnlocked,
  clampConfig,
};
