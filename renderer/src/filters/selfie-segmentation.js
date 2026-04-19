/**
 * Apex Revenue — Selfie Segmentation (main-thread wrapper)
 *
 * Owns a dedicated Web Worker that runs MediaPipe Selfie Segmentation.
 * The main thread never sees an ImageSegmenter instance — it only
 * transfers ImageBitmaps in and receives Float32Array masks back,
 * over transferable postMessages so nothing is copied across threads.
 *
 * The previous implementation ran MediaPipe inline on the renderer
 * thread. On weaker GPUs that caused visible frame hitches because
 * WASM inference and WebGL compositing fought for the same event
 * loop. Moving to a worker gives the inference its own thread and
 * its own GC rhythm — the render loop never waits on it.
 *
 * External API (unchanged from the previous version):
 *   • new SelfieSegmenter(videoEl, { wasmBase?, modelPath? })
 *   • await .init()         — spawns worker, waits for 'ready'
 *   • .pushFrame(videoEl)   — non-blocking; kicks off async inference
 *                             on the latest frame if no request is
 *                             in flight. Fire-and-forget.
 *   • .uploadMaskTo(gl)     — uploads latest mask to a bound WebGL
 *                             texture. Called from the render loop.
 *   • .ready                — boolean; true once worker init succeeded
 *   • .destroy()            — terminates worker, releases resources
 *
 * The BeautyFilter render loop drives pushFrame() itself — the worker
 * has no timer of its own. This keeps segmentation naturally synced
 * to video playback (no frames sent when the video is paused) and
 * lets the filter skip segmentation entirely when bgMode = 0.
 */

const DEFAULT_WASM_BASE = 'apex-mp://wasm/';
const DEFAULT_MODEL_URL = 'apex-mp://models/selfie_segmenter.tflite';

export class SelfieSegmenter {
  constructor(videoEl, options = {}) {
    this.video = videoEl;
    this.wasmBase = options.wasmBase || DEFAULT_WASM_BASE;
    this.modelPath = options.modelPath || DEFAULT_MODEL_URL;

    this.ready = false;
    this._disposed = false;
    this._lastError = null;

    // Latest mask state (updated when worker posts back)
    this._maskData = null;
    this._maskW = 0;
    this._maskH = 0;

    // Backpressure: only one frame in flight at a time. Naturally
    // throttles the effective segmentation rate to whatever the worker
    // can sustain — no queue buildup, no stale frames piling up.
    this._frameInFlight = false;

    // Init promise state
    this._worker = null;
    this._initPromise = null;
    this._initResolve = null;
    this._initReject  = null;
  }

  async init() {
    if (this._initPromise) return this._initPromise;
    this._initPromise = new Promise((resolve, reject) => {
      this._initResolve = resolve;
      this._initReject  = reject;
    });

    try {
      // Module worker — webpack 5 bundles the referenced file as a
      // separate chunk and rewrites the URL at build time. Works in
      // both dev (webpack-dev-server) and prod (file://-loaded
      // bundle) without any additional config.
      this._worker = new Worker(
        new URL('./segmentation-worker.js', import.meta.url),
        { type: 'module' }
      );
      this._worker.onmessage = (e) => this._handleMessage(e.data);
      this._worker.onerror   = (e) => this._onWorkerError(e);

      // Tell the worker to load MediaPipe. Once it does, it'll post
      // back { type: 'ready' } and we flip this.ready + resolve init.
      this._worker.postMessage({
        type: 'init',
        wasmBase: this.wasmBase,
        modelPath: this.modelPath,
      });
    } catch (err) {
      this._logError('setup', err);
      this._initReject?.(err);
    }

    return this._initPromise;
  }

  _handleMessage(msg) {
    switch (msg?.type) {
      case 'ready':
        this.ready = true;
        this._initResolve?.();
        return;

      case 'mask':
        this._frameInFlight = false;
        // Wrap the transferred ArrayBuffer back into a typed view. The
        // worker owns nothing here anymore — we fully own the buffer.
        this._maskData = new Float32Array(msg.buffer);
        this._maskW = msg.width;
        this._maskH = msg.height;
        return;

      case 'mask-missed':
        this._frameInFlight = false;
        return;

      case 'error':
        this._frameInFlight = false;
        this._logError(msg.stage || 'worker', new Error(msg.message || 'unknown'));
        if (msg.stage === 'init') this._initReject?.(this._lastError);
        return;

      default:
        // Unknown message type; ignore
        return;
    }
  }

  _onWorkerError(e) {
    this._frameInFlight = false;
    const err = new Error(e?.message || 'worker error');
    this._logError('worker', err);
    // If we haven't hit 'ready' yet, fail init
    if (!this.ready) this._initReject?.(err);
  }

  /**
   * Non-blocking frame push. Called from the WebGL render loop. Creates
   * an ImageBitmap from the live video element (fast, GPU-backed) and
   * transfers its ownership to the worker via postMessage. The main
   * thread never holds the bitmap's decoded bytes — it just proxies
   * the handle.
   *
   * Dedup: if an inference is still running on a previous frame, this
   * call returns immediately without sending. That keeps the worker's
   * inbox at size ≤ 1 and makes stale-frame buildup impossible.
   */
  async pushFrame(videoEl) {
    if (this._disposed || !this.ready) return;
    if (this._frameInFlight) return;
    if (!videoEl || videoEl.readyState < 2 || !videoEl.videoWidth) return;

    this._frameInFlight = true;
    let bitmap = null;
    try {
      // createImageBitmap from a video element is ~1-2 ms and runs
      // off the main thread internally. We still await it here so the
      // transfer argument is valid, but this doesn't block rendering
      // because the render loop has already completed its draw calls
      // by the time pushFrame is invoked.
      bitmap = await createImageBitmap(videoEl);
      if (this._disposed) { try { bitmap.close(); } catch {} return; }
      this._worker.postMessage(
        { type: 'frame', imageBitmap: bitmap, timestamp: performance.now() },
        [bitmap]
      );
    } catch (err) {
      // Single frame failed — don't lock the in-flight flag
      this._frameInFlight = false;
      try { bitmap?.close?.(); } catch {}
    }
  }

  /**
   * Upload the latest mask to a currently-bound WebGL texture. Same
   * signature as the previous inline version — beauty-filter.js
   * doesn't need any changes to switch between worker and inline.
   */
  uploadMaskTo(gl, target = gl.TEXTURE_2D) {
    if (!this._maskData || !this._maskW || !this._maskH) return false;
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
    if (this._worker) {
      try { this._worker.postMessage({ type: 'close' }); } catch {}
      try { this._worker.terminate(); } catch {}
      this._worker = null;
    }
    this._maskData = null;
    this._frameInFlight = false;
    this.ready = false;
  }

  _logError(stage, err) {
    this._lastError = err;
    try {
      window.electronAPI?.errors?.log?.(
        'warn',
        'selfie-segmentation',
        `${stage}: ${err?.message || err}`,
        { stack: err?.stack }
      );
    } catch {}
    // eslint-disable-next-line no-console
    console.warn(`[SelfieSegmenter] ${stage}:`, err?.message || err);
  }
}
