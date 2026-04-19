/**
 * Apex Revenue — Beauty Filter Configuration
 *
 * Shared between renderer (live filter + settings UI) and main (store
 * persistence). The BeautyFilter class owns the runtime behavior; this
 * module just defines defaults, slider bounds, and the tier gate.
 */

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
  // Gradient background (bgMode === 3)
  bgGradientA:     '#1a1a22', // hex — gradient color A
  bgGradientB:     '#cc0000', // hex — gradient color B (Apex crimson default)
  bgGradientStyle: 0,         // 0 vertical | 1 horizontal | 2 diag ↘ | 3 diag ↙
                              // 4 circular | 5 tie-dye | 6 square | 7 waves
  // Mask edge handling
  autoFeather:  true,    // true → filter calibrates feather from mask stats
  manualFeather: 50,     // 0–100 — user override (maps to 0.05..0.30 shader units)
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
  c.autoFeather = c.autoFeather === undefined ? true : !!c.autoFeather;
  // bgMode is an integer 0..3 — coerce softly
  c.bgMode = Math.round(c.bgMode) | 0;
  if (c.bgMode < 0 || c.bgMode > 3) c.bgMode = 0;
  // bgGradientStyle is an integer 0..7 — coerce softly
  c.bgGradientStyle = Math.round(c.bgGradientStyle) | 0;
  if (c.bgGradientStyle < 0 || c.bgGradientStyle > 7) c.bgGradientStyle = 0;
  // All three hex color fields must stay valid; otherwise reset to brand defaults
  const HEX = /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/;
  if (typeof c.bgColor !== 'string' || !HEX.test(c.bgColor)) c.bgColor = '#1a1a22';
  if (typeof c.bgGradientA !== 'string' || !HEX.test(c.bgGradientA)) c.bgGradientA = '#1a1a22';
  if (typeof c.bgGradientB !== 'string' || !HEX.test(c.bgGradientB)) c.bgGradientB = '#cc0000';
  return c;
}

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
// Curated one-tap gradients chosen to read well as cam-model
// backdrops: warm/saturated, premium-feeling, not clinical or
// corporate. Each preset carries a default style that looks best
// with those two colors — user can change the style after applying.
//
// Keep this list to 8 to fit the UI swatch row. If you add more,
// the UI will wrap to a second row.
const BG_GRADIENT_PRESETS = Object.freeze([
  { name: 'Apex',         a: '#1a1a22', b: '#cc0000', style: 4 }, // brand: ink → crimson, circular
  { name: 'Sunset',       a: '#ff7a3d', b: '#b81d7a', style: 0 }, // orange → magenta, vertical
  { name: 'Midnight',     a: '#0a1026', b: '#000000', style: 4 }, // navy → black, circular
  { name: 'Rose Gold',    a: '#ffb7a0', b: '#e4c4a3', style: 2 }, // soft pink → champagne, diag
  { name: 'Neon',         a: '#ff2ea6', b: '#6a1bff', style: 5 }, // hot pink → purple, tie-dye
  { name: 'Ocean',        a: '#1a8a9a', b: '#1b1d6a', style: 0 }, // teal → indigo, vertical
  { name: 'Warm Studio',  a: '#d99650', b: '#5c4a3c', style: 4 }, // amber → taupe, circular
  { name: 'Lavender Dusk',a: '#b48ad9', b: '#3e1d5c', style: 7 }, // lavender → plum, waves
]);

module.exports = {
  BEAUTY_DEFAULTS,
  BEAUTY_BOUNDS,
  BEAUTY_STORE_KEY,
  BG_GRADIENT_STYLES,
  BG_GRADIENT_PRESETS,
  isBeautyUnlocked,
  clampConfig,
};
