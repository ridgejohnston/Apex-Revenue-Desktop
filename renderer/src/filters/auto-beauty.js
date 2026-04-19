/**
 * Apex Revenue — Auto-Beauty Engine (vision-backed)
 *
 * Every AUTO_TICK_MS (15 seconds) while enabled, samples the live
 * webcam video to a small JPEG and asks Claude Haiku (running on
 * Bedrock in the main process) for recommended beauty-filter slider
 * values. Claude's suggestions go through an EMA smoother, a grace
 * window on manually-touched sliders, and a per-tick delta clamp
 * before they're written back into the filter config.
 *
 * WHY VISION INSTEAD OF PIXEL STATS
 *
 * An earlier draft of this engine computed pixel histograms locally.
 * That caught brightness / contrast / color-temperature imbalance but
 * was blind to aesthetic judgments — it couldn't tell whether the
 * subject's skin looked flattering or waxy, or whether unflattering
 * shadows fell across the jawline. Claude with vision can. The cost
 * is an API call per tick; at ~$0.00025/image, a 4-hour stream is
 * about $0.24. Trivial next to the aesthetic win.
 *
 * TICK FLOW
 *
 *   1. Cadence gate — 15 seconds since last tick.
 *   2. Busy gate — don't start a new analysis while one is in flight.
 *   3. Sample the video element to an offscreen 512x288 canvas, encode
 *      as JPEG quality 0.75 (~40KB typical). Keeps bandwidth trivial.
 *   4. Base64 -> IPC -> main -> Bedrock Haiku -> suggestions back.
 *   5. For each suggested slider that hasn't been manually touched in
 *      the last USER_GRACE_MS:
 *        - EMA target toward suggestion (ALPHA=0.30 — a bit more
 *          decisive than local-stats mode since Claude's judgment is
 *          already the thing we want to land on).
 *        - Delta-clamp to MAX_DELTA_PER_TICK so no slider jumps more
 *          than 8 units per tick even when Claude suggests a big shift.
 *      Writes back via the onAutoBeautyUpdate callback which merges
 *      into App.jsx's config state and persists to electron-store.
 *
 * FAILURE MODES
 *
 * If the IPC call fails or Bedrock returns a { reason } object without
 * slider values, the engine silently does nothing and retries on the
 * next tick. No UI surface for errors — Auto-Beauty is a background
 * optimization, not a feature the performer actively monitors.
 *
 * DISABLING
 *
 * When config.autoBeauty flips false, setEnabled(false) is called. The
 * tick gate short-circuits and the in-flight promise, if any, resolves
 * but its result is discarded. Re-enabling resumes from the CURRENT
 * slider values — no reset, no reversion.
 */

// Sliders the engine can adjust. Must match the response schema in
// main/auto-beauty-vision.js.
const TUNED_SLIDERS = Object.freeze([
  'intensity',
  'smoothness',
  'warmth',
  'brightness',
  'contrast',
  'saturation',
  'lowLight',
]);

// Cadence of vision calls. 15 seconds balances responsiveness (catch
// lighting changes) against cost (one Haiku image call per tick).
const AUTO_TICK_MS = 15000;

// After a manual slider edit, hands-off that slider for this long so
// the engine doesn't fight the performer mid-drag.
const USER_GRACE_MS = 10000;

// JPEG downscale — 512x288 is enough for Claude to read facial
// details, skin tone, and lighting without wasting bandwidth. At
// quality 0.75 this is typically 30-50 KB.
const ANALYSIS_W = 512;
const ANALYSIS_H = 288;
const JPEG_QUALITY = 0.75;

// EMA smoothing factor. Higher than the local-stats version (0.15)
// because Claude's recommendation is itself already a considered
// judgment — we don't need as much history-weighting.
const ALPHA = 0.30;

// Maximum per-tick slider delta. Prevents jarring jumps even when
// Claude suggests a large shift. At 15s ticks and up to 8 units/tick,
// the engine can move a slider from 0 to 50 in about 95 seconds —
// fast enough to feel adaptive, slow enough to feel organic.
const MAX_DELTA_PER_TICK = 8;

/**
 * Downscale a video element to the analysis size and encode as JPEG.
 * Reuses the canvas across calls so we're not allocating per-tick.
 */
class FrameSampler {
  constructor() {
    this._canvas = document.createElement('canvas');
    this._canvas.width = ANALYSIS_W;
    this._canvas.height = ANALYSIS_H;
    this._ctx = this._canvas.getContext('2d');
  }

  /**
   * Draw videoEl into the canvas and return a base64 JPEG (no data:
   * prefix). Returns null if the video isn't ready or canvas tainted.
   */
  sample(videoEl) {
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return null;
    try {
      this._ctx.drawImage(videoEl, 0, 0, ANALYSIS_W, ANALYSIS_H);
      // toDataURL returns "data:image/jpeg;base64,XXXX..."; strip the
      // prefix because Bedrock's Messages API wants just the bytes.
      const dataUrl = this._canvas.toDataURL('image/jpeg', JPEG_QUALITY);
      const comma = dataUrl.indexOf(',');
      return comma >= 0 ? dataUrl.slice(comma + 1) : null;
    } catch {
      // toDataURL throws SecurityError if the canvas is tainted, which
      // shouldn't happen for a same-origin MediaStream but we guard
      // anyway so a tainted-canvas bug doesn't crash the render loop.
      return null;
    }
  }
}

/**
 * Auto-Beauty engine. Instantiated per-BeautyFilter.
 *
 *   const engine = new AutoBeautyEngine(window.electronAPI?.beauty);
 *   engine.setEnabled(true);
 *   // in render loop:
 *   engine.maybeTick(performance.now(), videoEl, currentConfig, writeBack);
 *   // on UI slider change:
 *   engine.noteManualTouch('warmth');
 */
export class AutoBeautyEngine {
  constructor(beautyBridge) {
    this._bridge = beautyBridge || null;
    this._sampler = new FrameSampler();
    this._enabled = false;
    this._lastTickTs = 0;
    this._inFlight = false;

    // Per-slider last-manual-touch timestamps. Initialized in a loop
    // so future additions to TUNED_SLIDERS don't need companion edits.
    this._lastManualTouch = {};
    for (const k of TUNED_SLIDERS) this._lastManualTouch[k] = 0;

    // Latest smoothed-target value for each slider. Stored as floats
    // so fractional EMA increments accumulate across ticks; we round
    // to int only when writing back. Null until the first tick
    // populates it (seeded from the live config).
    this._smoothedTargets = null;

    // Last reason string from Claude — purely for debug; we log it
    // to the console once per unique reason so we can see what the
    // vision model is noticing without flooding the log.
    this._lastLoggedReason = null;
  }

  setEnabled(enabled) {
    const next = !!enabled;
    if (next === this._enabled) return;
    this._enabled = next;
    if (!next) {
      // Reset smoothed state so the next enable re-seeds from the
      // config the user has at that time (they may have dragged
      // sliders while auto was off).
      this._smoothedTargets = null;
    }
  }

  /**
   * Record that the user manually changed a slider. The engine will
   * skip auto-adjustment on that slider for USER_GRACE_MS.
   */
  noteManualTouch(key) {
    if (TUNED_SLIDERS.includes(key)) {
      this._lastManualTouch[key] = performance.now();
    }
  }

  /**
   * Drive one auto-tune tick if the cadence has elapsed. Safe to call
   * every render frame — the internal timer + busy flag gate work.
   *
   * @param {number}   nowMs     — performance.now()
   * @param {HTMLVideoElement} videoEl
   * @param {object}   config    — current live config (read-only)
   * @param {function} writeBack — writeBack(partialConfig) applies updates
   */
  maybeTick(nowMs, videoEl, config, writeBack) {
    if (!this._enabled) return;
    if (this._inFlight) return;
    if (nowMs - this._lastTickTs < AUTO_TICK_MS) return;
    if (!this._bridge || !this._bridge.analyzeFrame) return;

    // Move the clock forward BEFORE kicking off the async work so a
    // failed IPC doesn't cause back-to-back retries.
    this._lastTickTs = nowMs;

    const base64Jpeg = this._sampler.sample(videoEl);
    if (!base64Jpeg) return;

    this._inFlight = true;
    this._bridge.analyzeFrame(base64Jpeg)
      .then((result) => this._applyResult(result, config, writeBack))
      .catch(() => { /* swallow — try again next tick */ })
      .finally(() => { this._inFlight = false; });
  }

  /**
   * Merge Claude's slider suggestions into the current config using
   * EMA + grace-window + per-tick-delta-clamp. Called on the main
   * thread after the IPC promise resolves.
   */
  _applyResult(result, config, writeBack) {
    if (!this._enabled) return;       // disabled during the in-flight call
    if (!result || !result.ok) return; // handler-level error
    if (result.reason && this._lastLoggedReason !== result.reason) {
      this._lastLoggedReason = result.reason;
      // eslint-disable-next-line no-console
      console.log('[AutoBeauty]', result.reason);
    }

    // Initialize smoothed state from the current config on the first
    // successful tick after enable, so the EMA starts from where the
    // user is and drifts toward Claude's target rather than snapping.
    if (!this._smoothedTargets) {
      this._smoothedTargets = {};
      for (const k of TUNED_SLIDERS) this._smoothedTargets[k] = (config[k] ?? 0);
    }

    const nowMs = performance.now();
    const updates = {};
    let anyChange = false;

    for (const k of TUNED_SLIDERS) {
      // Skip sliders Claude didn't mention — no opinion, no change.
      if (result[k] === undefined) continue;
      // Skip sliders the user touched recently.
      if (nowMs - this._lastManualTouch[k] < USER_GRACE_MS) continue;

      // EMA toward Claude's target
      const claudeTarget = Number(result[k]);
      if (!Number.isFinite(claudeTarget)) continue;
      this._smoothedTargets[k] =
        (1 - ALPHA) * this._smoothedTargets[k] + ALPHA * claudeTarget;

      const current = config[k] ?? 0;
      const desired = Math.round(this._smoothedTargets[k]);

      // Clamp per-tick delta so we never jump more than MAX_DELTA_PER_TICK.
      const delta = desired - current;
      const clamped = Math.max(-MAX_DELTA_PER_TICK, Math.min(MAX_DELTA_PER_TICK, delta));
      const next = current + clamped;

      if (next !== current) {
        updates[k] = next;
        anyChange = true;
      }
    }

    if (anyChange) {
      try { writeBack(updates); } catch {}
    }
  }
}

export { TUNED_SLIDERS, AUTO_TICK_MS, USER_GRACE_MS };
