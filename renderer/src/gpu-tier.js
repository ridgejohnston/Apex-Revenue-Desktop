/**
 * GPU tier detection + WebGPU feature probe.
 *
 * Classifies the current GPU as 'integrated', 'discrete', or 'unknown'
 * based on Chromium's UNMASKED_RENDERER_WEBGL string. Integrated GPUs
 * (Intel UHD/Iris/Xe; AMD Radeon Vega on Ryzen APUs; Apple Silicon
 * integrated) struggle with the combination the pipe-stream path
 * asks of them: WebGL bilateral blur + MediaPipe selfie segmentation
 * + hardware H.264 encode at 1080p30, all sharing GPU cycles. On those
 * machines the compositor stalls, MediaRecorder starves, and Chaturbate
 * drops the stalled stream with -10053. v3.4.43 callers use the tier
 * to pick lower defaults (skip segmenter prewarm, shorter MediaRecorder
 * warm-up, conservative autoconfig resolution) when safe.
 *
 * Also probes for WebGPU availability. Chromium 113+ exposes
 * navigator.gpu on most recent GPUs; a future port of the bilateral
 * passes to WebGPU compute shaders would measurably cut the per-frame
 * cost on the same iGPU hardware that struggles with the current WebGL
 * bilateral. For now we just record availability so we know what a
 * future port would cover.
 *
 * Classification rules: bias toward over-flagging 'integrated'. A false
 * positive (discrete GPU flagged as integrated) costs the user a small
 * amount of default visual quality — recoverable by manually bumping
 * resolution. A false negative (integrated GPU flagged as discrete)
 * keeps the starvation chain in play. Asymmetric cost → asymmetric bias.
 */

export const GPU_TIER_INTEGRATED = 'integrated';
export const GPU_TIER_DISCRETE   = 'discrete';
export const GPU_TIER_UNKNOWN    = 'unknown';

// Discrete-GPU signatures. Checked FIRST so a Ryzen gaming laptop
// (which reports both an integrated Vega iGPU AND a discrete RX card
// when Chromium picks the discrete one for WebGL) doesn't get
// misclassified by a later Vega match. These names are all
// unambiguously discrete; none of them ship as integrated silicon.
const DISCRETE_PATTERNS = [
  /GeForce/i,
  /Quadro/i,
  /\bTesla\b/i,
  /\bRTX\b/i,
  /\bGTX\b/i,
  /NVIDIA/i,
  /Radeon (RX|Pro) [0-9]/i,
  /\bArc\s*A[0-9]/i,   // Intel Arc discrete (A380, A750, A770...)
];

// Integrated-GPU signatures. Covers Intel's full line (HD/UHD/Iris/Xe
// and their numbered variants), AMD's on-APU Radeon integrated (Vega
// and "Graphics" without a discrete model number), and Apple Silicon.
// Intentionally broad on Intel because Chromium's renderer string
// varies substantially between driver versions.
const INTEGRATED_PATTERNS = [
  /Intel\(?R?\)?\s+(HD|UHD|Iris|Xe)/i,
  /Intel\(?R?\)?\s+Graphics\s*[36789][0-9]{2}/i,  // 630, 730, 770, etc.
  /Intel.* (HD|UHD|Iris|Xe) Graphics/i,
  // AMD integrated (Ryzen APUs). "Vega ... Graphics" and the generic
  // "Radeon(TM) Graphics" mobile-APU renderer string both indicate
  // integrated — discrete AMD cards always have RX/Pro + a number.
  /AMD.* Radeon.* Vega.* Graphics/i,
  /Radeon\s*\(TM\)\s*Graphics/i,
  // Apple Silicon GPU
  /Apple (M[1-9]|GPU)/i,
];

/**
 * Classify a WebGL renderer string into a tier. Exposed separately from
 * detectGpuTier so tests can pass arbitrary strings without spinning
 * up a WebGL context.
 */
export function classifyRenderer(rendererString) {
  if (!rendererString || typeof rendererString !== 'string') {
    return GPU_TIER_UNKNOWN;
  }
  for (const re of DISCRETE_PATTERNS) {
    if (re.test(rendererString)) return GPU_TIER_DISCRETE;
  }
  for (const re of INTEGRATED_PATTERNS) {
    if (re.test(rendererString)) return GPU_TIER_INTEGRATED;
  }
  return GPU_TIER_UNKNOWN;
}

/**
 * Probe the current renderer for GPU info. Creates a throwaway WebGL
 * context, pulls the unmasked renderer string, and disposes aggressively
 * via WEBGL_lose_context so this probe doesn't hold a slot in Chromium's
 * GPU context pool (the pool is capped at 16 — holding one forever
 * would eventually starve the rest of the app).
 *
 * Result is memoized: the return value is stable across an app session,
 * so repeated calls are O(1) after the first.
 *
 * Returns { tier, vendor, renderer, webgl, hasWebGPU }. Any string
 * field may be null if WebGL initialization or extension negotiation
 * failed — callers must tolerate missing values.
 */
let _cached = null;
export function detectGpuTier() {
  if (_cached) return _cached;

  let vendor   = null;
  let renderer = null;
  let webgl    = null;

  try {
    const canvas = document.createElement('canvas');
    const gl2 = canvas.getContext('webgl2');
    const gl  = gl2 || canvas.getContext('webgl');
    if (gl) {
      webgl = gl2 ? 'webgl2' : 'webgl';
      const dbg = gl.getExtension('WEBGL_debug_renderer_info');
      if (dbg) {
        vendor   = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
        renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      } else {
        // Some privacy-hardened builds strip the debug extension. Fall
        // back to the plain VENDOR/RENDERER params — usually returns
        // generic strings like "WebKit" / "WebKit WebGL" but we try
        // anyway rather than leaving both null.
        vendor   = gl.getParameter(gl.VENDOR);
        renderer = gl.getParameter(gl.RENDERER);
      }
      // Aggressive context teardown — this probe should not hold a GPU
      // slot for the lifetime of the app.
      const loseExt = gl.getExtension('WEBGL_lose_context');
      if (loseExt) loseExt.loseContext();
    }
  } catch (err) {
    // Any GL setup failure leaves vendor/renderer as null and tier
    // will resolve to 'unknown' — the correct fail-open default.
    console.warn('[gpu-tier] detection failed:', err?.message || err);
  }

  const hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;

  _cached = {
    tier: classifyRenderer(renderer),
    vendor,
    renderer,
    webgl,
    hasWebGPU,
  };

  // One-line log with the classification + full renderer string so if
  // a user's tier comes up 'unknown' and they hit perf issues, their
  // errors.log has enough context to improve the patterns in a later
  // version. Use console.log not console.warn — 'unknown' is expected
  // on some hardened browsers and shouldn't pollute the error stream.
  console.log(
    `[gpu-tier] tier=${_cached.tier}, vendor="${vendor || '?'}", ` +
    `renderer="${renderer || '?'}", webgl=${webgl || '?'}, webgpu=${hasWebGPU}`
  );

  return _cached;
}

/**
 * Convenience: returns true if the detected tier is integrated or the
 * renderer couldn't be probed. 'unknown' is treated as low-end because
 * it happens on hardened/privacy builds that tend to run on older
 * hardware anyway, and defaulting to conservative perf settings in
 * that case is a safer choice than assuming discrete.
 */
export function isLowEndGpu() {
  const { tier } = detectGpuTier();
  return tier === GPU_TIER_INTEGRATED || tier === GPU_TIER_UNKNOWN;
}
