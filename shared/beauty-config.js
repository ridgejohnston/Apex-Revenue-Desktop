/**
 * Apex Revenue — Beauty Filter Configuration
 *
 * Shared between renderer (live filter + settings UI) and main (store
 * persistence). The BeautyFilter class owns the runtime behavior; this
 * module just defines defaults, slider bounds, and the tier gate.
 */

// ─── Gradient color constants ────────────────────────────
//
// "No Color" is the sentinel value used anywhere a gradient slot can be
// disabled. It's a plain string (not null/undefined) so electron-store
// serializes it cleanly and round-trips across IPC without conversion.
// The literal is exported so consumers (UI, filter, persistence) can
// compare against a named constant instead of a magic string.
const GRADIENT_NONE = 'none';

// Recognize valid hex color strings (3 or 6 digit, case-insensitive)
const HEX_RE = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;

// A gradient slot is "active" if it holds a valid hex color. Everything
// else (the sentinel, null, undefined, malformed strings) means "skip
// this slot in the interpolation." Exporting this helper ensures the
// activeness rule is identical in UI, filter, and persistence.
function isGradientSlotActive(value) {
  return typeof value === 'string' && HEX_RE.test(value);
}

// ─── Defaults ────────────────────────────────────────────
const BEAUTY_DEFAULTS = Object.freeze({
  enabled:    false,   // off by default — performer opts in explicitly
  intensity:  50,      // 0–100 — beauty blend
  smoothness: 50,      // 0–100 → bilateral sigma_color
  warmth:     0,       // -100..+100 — R/B tonal shift
  brightness: 0,       // -100..+100 — additive offset
  sharpness:  0,       // 0–100 — unsharp mask
  contrast:   0,       // -100..+100 — pivot around 0.5
  saturation: 0,       // -100..+100 — grayscale ↔ supersaturated
  lowLight:   0,       // 0–100 — shadow lift
  radial:     0,       // -100 vignette .. +100 key light
  // Background
  bgMode:          0,         // 0 off | 1 blur | 2 color | 3 gradient
  bgStrength:      60,        // 0–100 — Gaussian blur intensity
  bgColor:         '#1a1a22', // hex — replacement color (bgMode === 2)
  // Gradient background (bgMode === 3) — 5 slots (A..E) each either a
  // valid #rrggbb hex or the sentinel 'none' meaning the slot is off.
  // Natural-fade semantics: each active slot is anchored at its fixed
  // position (A=0.0, B=0.25, C=0.5, D=0.75, E=1.0) and inactive slots
  // are simply skipped. So with only A+B active, the gradient runs
  // A→B across t=0..0.25 and then holds B for t=0.25..1.0 (A gets
  // more visual space, E gets less — the "natural fade" effect).
  bgGradientA:     '#1a1a22',
  bgGradientB:     '#cc0000',
  bgGradientC:     GRADIENT_NONE,
  bgGradientD:     GRADIENT_NONE,
  bgGradientE:     GRADIENT_NONE,
  bgGradientStyle: 0,         // 0 vertical | 1 horizontal | 2 diag ↘ | 3 diag ↙
                              // 4 circular | 5 tie-dye | 6 square | 7 waves
  // Mask edge handling
  autoFeather:  true,    // true → filter calibrates feather from mask stats
  manualFeather: 50,     // 0–100 — user override (maps to 0.05..0.30 shader units)
  // Auto-Beauty: when true, the renderer samples the live webcam frame
  // every ~2 seconds and autonomously nudges intensity/smoothness/
  // warmth/brightness/contrast/saturation/lowLight toward values that
  // flatter the subject under their current lighting. Updates are
  // gentle (≤5 units per tick) so the preview never jumps — it settles
  // into an optimum over ~30-60 seconds and keeps adapting if the
  // lighting changes. Manual slider changes from the user stop
  // auto-adjustment on that slider for 10 seconds (respect the
  // performer's latest intent).
  autoBeauty:  false,
});

const BEAUTY_BOUNDS = Object.freeze({
  intensity:  { min: 0,    max: 100 },
  smoothness: { min: 0,    max: 100 },
  warmth:     { min: -100, max: 100 },
  brightness: { min: -100, max: 100 },
  sharpness:  { min: 0,    max: 100 },
  contrast:   { min: -100, max: 100 },
  saturation: { min: -100, max: 100 },
  lowLight:   { min: 0,    max: 100 },
  radial:     { min: -100, max: 100 },
  bgMode:     { min: 0,    max: 3   },
  bgStrength: { min: 0,    max: 100 },
  bgGradientStyle: { min: 0, max: 7 },
  manualFeather: { min: 0, max: 100 },
});

// Store key used by electron-store in main, and by window.electronAPI.store
// in the renderer. Single source of truth so the two sides never drift.
const BEAUTY_STORE_KEY = 'beautyFilterConfig';

// ─── Tier gate ───────────────────────────────────────────
/**
 * Feature gate: filters are a paid-tier feature available to Platinum
 * (Tier 2) and Agency (Tier 3) subscribers. Beta users see them (they
 * get Platinum for free), Free users see a locked panel with an upsell,
 * Admins see them regardless via the DEV toggle.
 */
function isBeautyUnlocked(effectivePlan) {
  return effectivePlan === 'platinum' || effectivePlan === 'agency';
}

// ─── Config clamp / migrate ──────────────────────────────
//
// Used on every load-from-disk and every UI write to keep the config
// object in a known-good shape. Handles:
//   • Out-of-range numeric fields → clamped to BEAUTY_BOUNDS
//   • Invalid bgMode / gradient style → reset to 0
//   • Invalid or missing gradient slot values → reset to defaults
//   • Pre-3.4.9 configs missing C/D/E slots → backfilled from defaults
// The gradient slot rule is: accept a valid #rrggbb hex OR the 'none'
// sentinel as valid values. Anything else (null, undefined, garbage
// strings) is treated as missing and replaced from BEAUTY_DEFAULTS.
function validateGradientSlot(value, fallback) {
  if (value === GRADIENT_NONE) return GRADIENT_NONE;
  if (typeof value === 'string' && HEX_RE.test(value)) return value;
  return fallback;
}

function clampConfig(cfg = {}) {
  const c = { ...BEAUTY_DEFAULTS, ...cfg };
  for (const [k, { min, max }] of Object.entries(BEAUTY_BOUNDS)) {
    if (typeof c[k] === 'number') c[k] = Math.max(min, Math.min(max, c[k]));
  }
  c.enabled = !!c.enabled;
  c.autoFeather = c.autoFeather === undefined ? true : !!c.autoFeather;
  c.autoBeauty = !!c.autoBeauty;
  // bgMode is an integer 0..3 — coerce softly
  c.bgMode = Math.round(c.bgMode) | 0;
  if (c.bgMode < 0 || c.bgMode > 3) c.bgMode = 0;
  // bgGradientStyle is an integer 0..7 — coerce softly
  c.bgGradientStyle = Math.round(c.bgGradientStyle) | 0;
  if (c.bgGradientStyle < 0 || c.bgGradientStyle > 7) c.bgGradientStyle = 0;
  // Single-color bg fill must stay a valid hex; otherwise reset to brand default
  if (typeof c.bgColor !== 'string' || !HEX_RE.test(c.bgColor)) c.bgColor = '#1a1a22';
  // Gradient slots — accept hex or 'none', anything else → default
  c.bgGradientA = validateGradientSlot(c.bgGradientA, BEAUTY_DEFAULTS.bgGradientA);
  c.bgGradientB = validateGradientSlot(c.bgGradientB, BEAUTY_DEFAULTS.bgGradientB);
  c.bgGradientC = validateGradientSlot(c.bgGradientC, BEAUTY_DEFAULTS.bgGradientC);
  c.bgGradientD = validateGradientSlot(c.bgGradientD, BEAUTY_DEFAULTS.bgGradientD);
  c.bgGradientE = validateGradientSlot(c.bgGradientE, BEAUTY_DEFAULTS.bgGradientE);
  return c;
}

// ─── Gradient slot helpers ───────────────────────────────
// Used by the UI, filter, and preset-apply logic to iterate gradient
// slots uniformly. Keys match the config field names verbatim so a
// SLOT_KEYS[i] entry is a direct property lookup — no conversion.
const GRADIENT_SLOT_KEYS = Object.freeze([
  'bgGradientA', 'bgGradientB', 'bgGradientC', 'bgGradientD', 'bgGradientE',
]);
const GRADIENT_SLOT_LABELS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
const GRADIENT_SLOT_COUNT = 5;

// ─── Gradient style registry ─────────────────────────────
// 8 spatial patterns. Each style is a pure function of UV → t in [0,1]
// implemented in shaders.js; this registry is just for UI labels /
// persistence / stability.
const BG_GRADIENT_STYLES = Object.freeze([
  { value: 0, label: 'Vertical'   },
  { value: 1, label: 'Horizontal' },
  { value: 2, label: 'Diagonal ↘' },
  { value: 3, label: 'Diagonal ↙' },
  { value: 4, label: 'Circular'   },
  { value: 5, label: 'Tie-Dye'    },
  { value: 6, label: 'Square'     },
  { value: 7, label: 'Waves'      },
]);

// ─── Preset gradients ────────────────────────────────────
// Curated one-tap gradients chosen to read well as cam-model backdrops:
// warm/saturated, premium-feeling, not clinical or corporate. Each
// preset now specifies 5 slots — use the 'none' sentinel for unused
// slots. Two-color classics (Apex, Midnight, Rose Gold, Ocean) keep
// their minimalist feel; the multi-color additions (Aurora, Vaporwave)
// showcase what the 5-slot system can do.
//
// Keep this list to 8 for the 4×2 preset grid. If you add more, the
// UI will wrap to a third row.
const N = GRADIENT_NONE;
const BG_GRADIENT_PRESETS = Object.freeze([
  // 2-color
  { name: 'Apex',         a: '#1a1a22', b: '#cc0000', c: N,         d: N,         e: N,         style: 4 },
  { name: 'Midnight',     a: '#0a1026', b: '#000000', c: N,         d: N,         e: N,         style: 4 },
  { name: 'Rose Gold',    a: '#ffb7a0', b: '#e4c4a3', c: N,         d: N,         e: N,         style: 2 },
  { name: 'Ocean',        a: '#1a8a9a', b: '#1b1d6a', c: N,         d: N,         e: N,         style: 0 },
  // 3-color
  { name: 'Sunset',       a: '#ff7a3d', b: '#e8489d', c: '#6a1bff', d: N,         e: N,         style: 0 },
  { name: 'Warm Studio',  a: '#d99650', b: '#a06840', c: '#5c4a3c', d: N,         e: N,         style: 4 },
  // 5-color
  { name: 'Aurora',       a: '#0a1026', b: '#1a8a9a', c: '#3dc485', d: '#e8d85a', e: '#b81d7a', style: 7 },
  { name: 'Vaporwave',    a: '#ff2ea6', b: '#b48ad9', c: '#6a1bff', d: '#1b1d6a', e: '#0a1026', style: 5 },
]);

module.exports = {
  BEAUTY_DEFAULTS,
  BEAUTY_BOUNDS,
  BEAUTY_STORE_KEY,
  BG_GRADIENT_STYLES,
  BG_GRADIENT_PRESETS,
  GRADIENT_NONE,
  GRADIENT_SLOT_KEYS,
  GRADIENT_SLOT_LABELS,
  GRADIENT_SLOT_COUNT,
  isGradientSlotActive,
  isBeautyUnlocked,
  clampConfig,
};
