/**
 * Apex Revenue — Selfie Segmentation wrapper
 *
 * Thin adapter over MediaPipe's Tasks Vision ImageSegmenter that:
 *   • Lazy-loads the WASM + model on first activation (so users who
 *     never enable bg blur never pay the ~3 MB download cost).
 *   • Runs its own timing loop, decoupled from the WebGL render loop.
 *     Segmentation is slower than 30 fps on modest hardware; if we
 *     tied it to rAF the whole filter would throttle. Instead we let
 *     it run as fast as the GPU allows and the render loop just uses
 *     whatever mask is freshest.
 *   • Exposes `.getMaskTexture(gl)` — paints the latest mask into a
 *     single-channel WebGL texture that the composite shader samples.
 *   • Graceful failure: if WASM or model fetch fails, `ready` stays
 *     false, `enabled` getter returns false, and the caller can keep
 *     running without background effects.
 *
 * Performance notes:
 *   • MediaPipe's selfie segmenter (float16) is ~2 MB and typically
 *     runs at 30+ fps on any integrated GPU from the last 5 years.
 *   • We use `outputConfidenceMasks: true` for soft 0..1 edges, NOT
 *     `outputCategoryMask: true` which is binary and produces hard
 *     halos around hair/shoulders.
 */

// Load MediaPipe Tasks Vision via dynamic import so its ~400 KB of
// JavaScript is only pulled into the renderer when the user actually
// turns on a background effect. On failure we swallow the error and
// mark the segmenter unavailable.
//
// The WASM binaries and the .tflite model are NOT bundled with the app.
// Users install them on demand via the Install button in the Filters
// panel (see mediapipe-installer.js). By default we look for them at
// the apex-mp:// protocol served from userData/mediapipe/assets/. If
// the caller hasn't installed and still tries to start segmentation,
// init() fails cleanly and the filter runs in no-bg mode.
const DEFAULT_WASM_BASE = 'apex-mp://wasm/';
const DEFAULT_MODEL_URL = 'apex-mp://models/selfie_segmenter.tflite';

export class SelfieSegmenter {
  constructor(videoEl, options = {}) {
    this.video = videoEl;
    this.wasmBase = options.wasmBase || DEFAULT_WASM_BASE;
    this.modelPath = options.modelPath || DEFAULT_MODEL_URL;
    this.segmenter = null;
    this.ready = false;
    this._disposed = false;
    this._lastError = null;

    // Scratch canvas — MediaPipe returns an MPMask object which is
    // cheapest to read as a Float32Array. We upload that straight into
    // a WebGL texture; no intermediate canvas needed.
    this._maskData = null;    // Float32Array of latest mask
    this._maskW = 0;
    this._maskH = 0;

    this._loopHandle = null;
  }

  async init() {
    try {
      // Dynamic import keeps the MediaPipe bundle out of the main chunk.
      // @mediapipe/tasks-vision must be in package.json dependencies.
      const { ImageSegmenter, FilesetResolver } =
        await import('@mediapipe/tasks-vision');

      const fileset = await FilesetResolver.forVisionTasks(this.wasmBase);
      this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: this.modelPath,
          delegate: 'GPU', // falls back to CPU automatically if unavailable
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      this.ready = true;
      this._startLoop();
    } catch (err) {
      this._lastError = err;
      this.ready = false;
      try {
        window.electronAPI?.errors?.log?.(
          'warn',
          'selfie-segmentation',
          `MediaPipe init failed: ${err?.message || err}`,
          { stack: err?.stack }
        );
      } catch {}
      // eslint-disable-next-line no-console
      console.warn('[SelfieSegmenter] init failed — bg effects disabled:', err?.message);
    }
  }

  _startLoop() {
    if (this._disposed || !this.ready) return;

    const tick = () => {
      if (this._disposed || !this.ready || !this.segmenter) return;
      try {
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
          const t = performance.now();
          const result = this.segmenter.segmentForVideo(this.video, t);
          // result.confidenceMasks is an array of MPMask — one per class.
          // For selfie segmenter there's only one: person vs background.
          const mask = result?.confidenceMasks?.[0];
          if (mask) {
            const w = mask.width;
            const h = mask.height;
            // MPMask owns the underlying buffer and frees it when you
            // call .close(). getAsFloat32Array() copies it out.
            const data = mask.getAsFloat32Array();
            this._maskData = data;
            this._maskW = w;
            this._maskH = h;
            mask.close();
          }
          // Some MediaPipe versions return a result object that must be
          // closed to free tensors. Newer API doesn't require this, but
          // calling close() is a no-op if unsupported, so we try both.
          try { result?.close?.(); } catch {}
        }
      } catch (err) {
        // Log once, then continue — a single bad frame shouldn't kill
        // segmentation for the rest of the session.
        if (!this._lastError || this._lastError.message !== err.message) {
          this._lastError = err;
          // eslint-disable-next-line no-console
          console.warn('[SelfieSegmenter] frame inference failed:', err?.message);
        }
      }
      // Use setTimeout(0) rather than rAF so segmentation runs
      // independently of the video render loop. rAF would couple us
      // to the display refresh and waste work when the filter's
      // render loop is already throttling to 30 fps.
      this._loopHandle = setTimeout(tick, 0);
    };
    tick();
  }

  /**
   * Upload the latest mask into a pre-existing WebGL texture. The
   * texture should be bound to TEXTURE_2D by the caller, with LINEAR
   * filtering set (we rely on GPU interpolation to smooth the mask's
   * lower resolution up to the output frame size).
   *
   * Returns `true` if a mask was uploaded, `false` if no mask is yet
   * available (segmenter still initializing, or first frame pending).
   */
  uploadMaskTo(gl, target = gl.TEXTURE_2D) {
    if (!this._maskData || !this._maskW || !this._maskH) return false;
    // R32F texture — single-channel float. The shader samples .r.
    // Internal format must match type to avoid INVALID_OPERATION.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texImage2D(
      target, 0,
      gl.R32F,
      this._maskW, this._maskH, 0,
      gl.RED,
      gl.FLOAT,
      this._maskData
    );
    return true;
  }

  destroy() {
    this._disposed = true;
    if (this._loopHandle) clearTimeout(this._loopHandle);
    if (this.segmenter) {
      try { this.segmenter.close(); } catch {}
      this.segmenter = null;
    }
    this._maskData = null;
  }
}
