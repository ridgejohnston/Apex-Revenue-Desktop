/**
 * Apex Revenue — Beauty Filter
 *
 * Takes an input MediaStream (typically from getUserMedia), routes each
 * video frame through a two-pass WebGL2 bilateral blur + tonal composite,
 * and produces an output MediaStream via canvas.captureStream(30).
 *
 * The output stream plugs into the existing scene-compositing pipeline
 * exactly where the raw stream used to — so the preview canvas, RTMP
 * encoder, and virtual camera all see the beautified frames with no
 * downstream changes.
 *
 *                           ┌─ preview canvas
 *  getUserMedia ─► BeautyFilter ─► MediaStream ─┼─ stream-engine (FFmpeg)
 *                                               └─ virtual camera
 *
 * The filter is resolution-matched to the first received frame (so we
 * don't lock to 1920×1080 when the webcam actually delivers 1280×720).
 * Config changes are applied on the next frame — no restart needed.
 *
 * Graceful degradation: if WebGL2 isn't available or any shader fails
 * to compile, getStream() returns the original input stream unchanged
 * and logs to the main-process error logger. The app continues to work,
 * the user just doesn't get the filter.
 */

import { VERT_SRC, FRAG_BILATERAL, FRAG_GAUSSIAN_BLUR, FRAG_COMPOSITE } from './shaders.js';
import { SelfieSegmenter } from './selfie-segmentation.js';
import { AutoBeautyEngine, TUNED_SLIDERS } from './auto-beauty.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  GRADIENT_SLOT_KEYS,
  GRADIENT_SLOT_COUNT,
  isGradientSlotActive,
} = require('../../../shared/beauty-config');

const DEFAULT_CONFIG = {
  enabled:    true,
  intensity:  50,   // 0–100 — how much of the smoothed result to blend in
  smoothness: 50,   // 0–100 — maps to sigma_color (0.02–0.25)
  warmth:     0,    // -100 to +100 — red/blue tonal shift
  brightness: 0,    // -100 to +100 — additive offset
  sharpness:  0,    // 0–100 — unsharp mask strength (adds detail back)
  contrast:   0,    // -100 to +100 — pivot around 0.5 luma
  saturation: 0,    // -100 to +100 — grayscale ↔ supersaturated
  lowLight:   0,    // 0–100 — shadow lift (gamma) for dim rooms
  radial:     0,    // -100 (full vignette) .. +100 (full key light)
  // Background
  bgMode:       0,
  bgStrength:   60,
  bgColor:      '#1a1a22',
  // Mask edge handling
  autoFeather:  true,     // true → calibrate feather from mask statistics
  manualFeather: 50,      // 0–100 — user override when autoFeather=false
};

// Map a 0–100 slider to a bilateral sigma_color in [0.02, 0.25].
// The low end barely smooths anything; the high end starts looking
// "plasticky" which is intentional — lets performers pick their taste.
function mapSmoothness(v) {
  const n = Math.max(0, Math.min(100, v)) / 100;
  return 0.02 + n * 0.23;
}

// Parse a hex color (#rrggbb or #rgb) to an [r, g, b] triple in 0..1.
// Fallback to opaque black if the string is malformed so the shader
// always gets a sane vec3.
function hexToRgb(hex) {
  if (typeof hex !== 'string') return [0, 0, 0];
  let h = hex.trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (h.length !== 6 || !/^[0-9a-fA-F]{6}$/.test(h)) return [0, 0, 0];
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

export class BeautyFilter {
  constructor(inputStream, config = {}, { onAutoBeautyUpdate } = {}) {
    this.inputStream = inputStream;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._passthrough = false;      // true → getStream() returns inputStream
    this._rafHandle   = null;
    this._outputStream = null;
    this._destroyed   = false;
    this._lastError   = null;
    this._segmenter = null;
    this._segmenterInitStarted = false;
    this._prewarmScheduled = false;

    // Auto-Beauty — AI-driven continuous tuning via Bedrock Claude
    // Haiku vision. Every AUTO_TICK_MS (15s) while enabled, samples
    // the RAW video into a JPEG, ships it to main via electronAPI,
    // and merges the returned slider suggestions through EMA + grace
    // + per-tick-delta-clamp before writing back. See auto-beauty.js
    // for the full design. The Bedrock bridge is pulled off
    // window.electronAPI lazily so this module remains testable
    // outside Electron (no window global in Jest etc).
    const beautyBridge =
      (typeof window !== 'undefined' && window.electronAPI && window.electronAPI.beauty) || null;
    this._autoBeauty = new AutoBeautyEngine(beautyBridge);
    this._autoBeauty.setEnabled(!!this.config.autoBeauty);
    this._onAutoBeautyUpdate = onAutoBeautyUpdate || null;

    // Auto-feather calibration state. u_maskFeather controls how wide
    // the smoothstep transition zone is around the 0.5 confidence line
    // in the composite shader. Too tight → halo (original bg bleeds
    // through around hair). Too wide → hard edge goes soft and the
    // subject detaches from the bg. The right value depends on subject
    // edge characteristics (hair/fabric/glasses) and lighting — so we
    // compute it from the mask's confidence distribution once per
    // second and smooth it with an EMA.
    this._currentFeather      = 0.15;   // seed; actual feather shader uniform
    this._autoFeatherEMA      = 0.15;   // smoothed running value
    this._framesSinceAnalysis = 0;      // frame counter for periodic calibration
    this._lastAnalysis        = null;   // { transitionRatio, rawFeather, ts } — for diagnostics

    try {
      this._setup();
    } catch (err) {
      this._failSafe('setup', err);
    }

    // ─── Diagnostic: one-shot state log on construction ───
    // Prints exactly once per filter lifetime so we can see from the
    // DevTools console what the filter started with. Invaluable when
    // users report "background effects don't work" — tells us
    // immediately whether the config flag reached the filter, whether
    // passthrough is on, whether the initial config requested bg
    // effects, and whether segmenter init was kicked off.
    try {
      // eslint-disable-next-line no-console
      console.log('[BeautyFilter] constructed:', {
        enabled:            !!this.config.enabled,
        bgMode:             this.config.bgMode ?? 0,
        mediapipeInstalled: this.config.mediapipeInstalled === true,
        passthrough:        this._passthrough,
        autoBeauty:         !!this.config.autoBeauty,
      });
    } catch {}

    // If the initial config already has bg effects on AND MediaPipe is
    // already installed (user had bg on last session and already ran
    // the installer), start the segmenter immediately rather than
    // waiting for an update(). If not installed, the renderer will
    // call update({mediapipeInstalled: true}) after install completes.
    const wantsBg = (this.config.bgMode ?? 0) > 0;
    const installed = this.config.mediapipeInstalled === true;
    if (wantsBg && installed && !this._passthrough) {
      this._startSegmenter('ctor');
    } else if (installed && !this._passthrough) {
      // PREWARM: MediaPipe is installed but the user's session starts
      // with blur OFF. Defer-schedule the segmenter so it's ready by
      // the time the user clicks Blur — eliminates the perceptible
      // 500-2000ms cold-start delay they'd otherwise see on first
      // toggle. See _schedulePrewarm for the mechanics.
      this._schedulePrewarm('ctor');
    }
  }

  /**
   * Create + init the SelfieSegmenter with full diagnostic logging.
   * Called from the constructor (if the initial config wants bg) and
   * from update() (if the user enables bg mid-session). Idempotent —
   * the init-started flag prevents double-construction.
   */
  _startSegmenter(whence) {
    if (this._segmenterInitStarted || this._segmenter) return;
    this._segmenterInitStarted = true;
    // eslint-disable-next-line no-console
    console.log('[BeautyFilter] starting segmenter init:', { whence });
    try {
      this._segmenter = new SelfieSegmenter(this.video);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[BeautyFilter] SelfieSegmenter ctor threw:', err?.message || err);
      this._segmenter = null;
      this._segmenterInitStarted = false;
      return;
    }
    this._segmenter.init()
      .then(() => {
        // eslint-disable-next-line no-console
        console.log('[BeautyFilter] segmenter READY');
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn('[BeautyFilter] segmenter init FAILED:', err?.message || err);
      });
  }

  // ─── Public API ────────────────────────────────────────
  getStream() {
    if (this._passthrough || !this._outputStream) return this.inputStream;
    // If the filter is runtime-disabled, still return the processed stream
    // but render a pass-through frame so downstream consumers don't re-bind.
    return this._outputStream;
  }

  update(partial) {
    // Track which of the tuned sliders were just touched by the UI so
    // the auto-engine can grant them a grace period — respects the
    // performer's manual intent without fighting them mid-drag.
    if (partial && this._autoBeauty) {
      for (const k of TUNED_SLIDERS) {
        if (partial[k] !== undefined && partial[k] !== this.config[k]) {
          this._autoBeauty.noteManualTouch(k);
        }
      }
    }

    Object.assign(this.config, partial);

    // Toggle auto-beauty on/off when the config key flips.
    if (this._autoBeauty && partial && 'autoBeauty' in partial) {
      this._autoBeauty.setEnabled(!!this.config.autoBeauty);
    }

    // Diagnostic: log whenever bg-critical config fields change, so
    // the console trace shows exactly what state the filter had when
    // a background effect was requested.
    if (partial && (
      'bgMode' in partial ||
      'mediapipeInstalled' in partial ||
      'enabled' in partial
    )) {
      try {
        // eslint-disable-next-line no-console
        console.log('[BeautyFilter] update:', {
          partial,
          resultingBgMode:    this.config.bgMode ?? 0,
          resultingInstalled: this.config.mediapipeInstalled === true,
          segmenterExists:    !!this._segmenter,
          segmenterReady:     !!(this._segmenter && this._segmenter.ready),
        });
      } catch {}
    }

    // Lazy-load the selfie segmenter the first time the user enables any
    // background effect AND the MediaPipe assets are locally installed.
    // If bg is requested but not installed, silently no-op here; the UI
    // (InstallPrompt in BeautyPanel) is the user-visible gate, and the
    // composite shader's effectiveBgMode check falls back to bgMode=0
    // whenever segmenter.ready is false — nothing breaks.
    const wantsSegmentation = (this.config.bgMode ?? 0) > 0;
    const installed = this.config.mediapipeInstalled === true;
    if (wantsSegmentation && installed && !this._segmenter && !this._segmenterInitStarted) {
      this._startSegmenter('update');
    }

    // Pre-warm path: if MediaPipe is installed but the user hasn't yet
    // flipped on a background effect, start the segmenter anyway in the
    // background. This eliminates the 500-2000ms latency the user would
    // otherwise see the first time they click Blur — worker spawn, WASM
    // fetch, model load, and GPU delegate compile all happen now instead
    // of when the user is waiting. By the time they click Blur, the
    // segmenter is already ready and the mask pops in on the next frame.
    //
    // Deferred via setTimeout so we don't contend with initial UI render
    // or the first few rAF frames of the video preview — this is
    // background work. 300ms is short enough that a user who clicks
    // Blur immediately after opening the app still usually hits the
    // prewarmed path, but long enough that the render loop gets a clean
    // first-frame pass without WASM compile jank.
    if (!wantsSegmentation && installed && !this._segmenter && !this._segmenterInitStarted) {
      this._schedulePrewarm('update');
    }
  }

  _schedulePrewarm(whence) {
    if (this._prewarmScheduled) return;
    this._prewarmScheduled = true;
    const run = () => {
      if (this._destroyed) return;
      // Re-check: the user may have toggled bg on (_startSegmenter
      // already ran) in the interim, or MediaPipe may have become
      // uninstalled. Both are idempotent no-ops inside _startSegmenter.
      if (!this._segmenter && !this._segmenterInitStarted &&
          this.config.mediapipeInstalled === true) {
        this._startSegmenter(`prewarm:${whence}`);
      }
    };
    // Prefer requestIdleCallback when available so we don't burn the
    // browser's animation budget during startup. Fall back to
    // setTimeout on engines without it (Safari < 16.4, etc — not a
    // factor in Electron/Chromium but cheap to guard).
    if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(run, { timeout: 1500 });
    } else {
      setTimeout(run, 300);
    }
  }

  destroy() {
    this._destroyed = true;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    if (this._segmenter) {
      try { this._segmenter.destroy(); } catch {}
      this._segmenter = null;
    }
    if (this.video) { try { this.video.pause(); } catch {} this.video.srcObject = null; }
    if (this.gl) {
      try {
        this.gl.deleteProgram(this.progBilateral);
        this.gl.deleteProgram(this.progGaussian);
        this.gl.deleteProgram(this.progComposite);
        this.gl.deleteTexture(this.texVideo);
        this.gl.deleteTexture(this.texHoriz);
        this.gl.deleteTexture(this.texSmoothed);
        this.gl.deleteTexture(this.texBgHoriz);
        this.gl.deleteTexture(this.texBgBlurred);
        this.gl.deleteTexture(this.texMask);
        this.gl.deleteFramebuffer(this.fbHoriz);
        this.gl.deleteFramebuffer(this.fbSmoothed);
        this.gl.deleteFramebuffer(this.fbBgHoriz);
        this.gl.deleteFramebuffer(this.fbBgBlurred);
      } catch {}
    }
    if (this._outputStream) {
      try { this._outputStream.getTracks().forEach((t) => t.stop()); } catch {}
    }
  }

  // ─── Setup ─────────────────────────────────────────────
  _setup() {
    // Hidden <video> element that plays the input stream. We don't
    // attach it to the DOM — the browser still decodes it because we
    // call play() and it has a MediaStream srcObject.
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.srcObject = this.inputStream;

    // Start with a sane fallback size; we'll resize to the real
    // frame dimensions on the first loadedmetadata event.
    this.canvas = document.createElement('canvas');
    this.canvas.width = 1280;
    this.canvas.height = 720;

    const gl = this.canvas.getContext('webgl2', {
      preserveDrawingBuffer: false,
      alpha: false,
      antialias: false,
      desynchronized: true,
    });
    if (!gl) throw new Error('WebGL2 unavailable');
    this.gl = gl;

    // Build the three shader programs. Compile failures throw so the
    // outer try/catch in the constructor routes to _failSafe().
    this.progBilateral = this._compileProgram(VERT_SRC, FRAG_BILATERAL);
    this.progGaussian  = this._compileProgram(VERT_SRC, FRAG_GAUSSIAN_BLUR);
    this.progComposite = this._compileProgram(VERT_SRC, FRAG_COMPOSITE);

    // Uniform locations (resolved once, used every frame)
    this.locBilateral = {
      tex:        gl.getUniformLocation(this.progBilateral, 'u_tex'),
      texel:      gl.getUniformLocation(this.progBilateral, 'u_texel'),
      direction:  gl.getUniformLocation(this.progBilateral, 'u_direction'),
      sigmaColor: gl.getUniformLocation(this.progBilateral, 'u_sigmaColor'),
    };
    this.locGaussian = {
      tex:       gl.getUniformLocation(this.progGaussian, 'u_tex'),
      texel:     gl.getUniformLocation(this.progGaussian, 'u_texel'),
      direction: gl.getUniformLocation(this.progGaussian, 'u_direction'),
      strength:  gl.getUniformLocation(this.progGaussian, 'u_strength'),
    };
    this.locComposite = {
      original:    gl.getUniformLocation(this.progComposite, 'u_original'),
      smoothed:    gl.getUniformLocation(this.progComposite, 'u_smoothed'),
      bgBlurred:   gl.getUniformLocation(this.progComposite, 'u_bgBlurred'),
      mask:        gl.getUniformLocation(this.progComposite, 'u_mask'),
      intensity:   gl.getUniformLocation(this.progComposite, 'u_intensity'),
      warmth:      gl.getUniformLocation(this.progComposite, 'u_warmth'),
      brightness:  gl.getUniformLocation(this.progComposite, 'u_brightness'),
      sharpness:   gl.getUniformLocation(this.progComposite, 'u_sharpness'),
      contrast:    gl.getUniformLocation(this.progComposite, 'u_contrast'),
      saturation:  gl.getUniformLocation(this.progComposite, 'u_saturation'),
      lowLight:    gl.getUniformLocation(this.progComposite, 'u_lowLight'),
      radial:      gl.getUniformLocation(this.progComposite, 'u_radial'),
      aspect:      gl.getUniformLocation(this.progComposite, 'u_aspect'),
      bgMode:      gl.getUniformLocation(this.progComposite, 'u_bgMode'),
      bgColor:     gl.getUniformLocation(this.progComposite, 'u_bgColor'),
      // u_bgGradSlots is declared as vec4[5] in the fragment shader. WebGL
      // getUniformLocation with the base name (no '[0]' suffix) returns a
      // single location usable with uniform4fv + a Float32Array(20) to
      // update all 5 slots in one call. We keep a parallel array of
      // per-element locations as a fallback in case the driver requires
      // explicit '[i]' suffixes — some older headless-gl builds do.
      bgGradSlots: gl.getUniformLocation(this.progComposite, 'u_bgGradSlots'),
      bgGradSlotsIdx: Array.from({ length: GRADIENT_SLOT_COUNT }, (_, i) =>
        gl.getUniformLocation(this.progComposite, `u_bgGradSlots[${i}]`)
      ),
      bgGradStyle: gl.getUniformLocation(this.progComposite, 'u_bgGradStyle'),
      maskFeather: gl.getUniformLocation(this.progComposite, 'u_maskFeather'),
    };

    // Scratch buffer for gradient slot uniforms. Reused every frame to
    // avoid per-frame Float32Array allocation (which was ~20 bytes per
    // frame × 30 fps = 600 bytes/sec of GC churn — small but free to
    // eliminate). Filled by the hot path.
    this._gradSlotsBuf = new Float32Array(4 * GRADIENT_SLOT_COUNT);

    // WebGL2's single-channel float textures (R32F) require the
    // EXT_color_buffer_float extension to be *written* to as an FBO
    // target, but they can be read as sampler2D without it. We only
    // sample the mask (never render to it), so we don't need the ext.
    // But uploading Float32Array to R32F does need OES_texture_float_linear
    // for LINEAR filtering. It's universally available on desktop GPUs
    // from the last 10 years; we check and fall back to NEAREST if not.
    const hasFloatLinear = !!gl.getExtension('OES_texture_float_linear');
    this._maskFilter = hasFloatLinear ? gl.LINEAR : gl.NEAREST;

    // Create textures + framebuffers sized to the canvas. They get
    // resized in _resizeTo() when we learn the real video dimensions.
    this.texVideo     = this._createTexture();
    this.texHoriz     = this._createTexture();
    this.texSmoothed  = this._createTexture();
    this.texBgHoriz   = this._createTexture();
    this.texBgBlurred = this._createTexture();
    // Mask texture uses NEAREST/LINEAR depending on ext availability
    this.texMask = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, this._maskFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, this._maskFilter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    // Initialize with a 1×1 fully-"person" mask so shader has something
    // safe to sample before segmentation delivers a real mask
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT,
                  new Float32Array([1.0]));

    this.fbHoriz      = gl.createFramebuffer();
    this.fbSmoothed   = gl.createFramebuffer();
    this.fbBgHoriz    = gl.createFramebuffer();
    this.fbBgBlurred  = gl.createFramebuffer();
    this._resizeTo(this.canvas.width, this.canvas.height);

    // Dummy VAO — we draw a triangle with gl_VertexID, no actual
    // attributes needed, but WebGL2 still requires a bound VAO.
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);

    // Create the output MediaStream SYNCHRONOUSLY, before we wait on
    // the video's loadedmetadata event.
    //
    // Why this matters: activateSource() in App.jsx calls
    //   new BeautyFilter(stream, ...)
    //   filteredStream = filter.getStream()
    //   if (filteredStream !== stream) { stash filter; use filteredStream }
    //
    // If _outputStream isn't ready yet, getStream() returns
    // this.inputStream (the raw stream) as a safety fallback — meaning
    // the filter is CONSTRUCTED but IMMEDIATELY DISCARDED. The caller
    // keeps using the raw stream and never stores the filter, so every
    // subsequent handleBeautyChange iterates an empty map and the
    // sliders do nothing. This was the cause of the "install runs but
    // filters don't apply" regression.
    //
    // Canvas.captureStream() doesn't need the underlying video to be
    // playing or sized — it captures whatever the canvas is rendering
    // right now (initially the 1280×720 blank canvas). Once playback
    // starts and the render loop draws frames, the same MediaStream
    // silently carries the new content. Resizing the canvas later in
    // _resizeTo() is also fine — captureStream tracks the canvas's
    // current dimensions dynamically.
    this._outputStream = this.canvas.captureStream(30);

    // Kick off playback + render loop. When metadata is available, we
    // size the canvas to the real video dimensions and start rAF.
    const start = () => {
      if (this.video.videoWidth && this.video.videoHeight) {
        this._resizeTo(this.video.videoWidth, this.video.videoHeight);
      }
      this._renderLoop();
    };
    if (this.video.readyState >= 2) {
      this.video.play().catch(() => {});
      start();
    } else {
      this.video.addEventListener('loadedmetadata', () => {
        this.video.play().catch(() => {});
        start();
      }, { once: true });
    }
  }

  _resizeTo(w, h) {
    if (this.canvas.width === w && this.canvas.height === h) return;
    this.canvas.width = w;
    this.canvas.height = h;
    const gl = this.gl;
    // Re-allocate framebuffer textures at the new size. Both the
    // bilateral-blur and gaussian-blur pipelines have their own H/V
    // framebuffer pair so they never stomp each other.
    for (const t of [this.texHoriz, this.texSmoothed, this.texBgHoriz, this.texBgBlurred]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbHoriz);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texHoriz, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbSmoothed);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texSmoothed, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBgHoriz);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBgHoriz, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBgBlurred);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.texBgBlurred, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  _createTexture() {
    const gl = this.gl;
    const t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    return t;
  }

  _compileProgram(vsSrc, fsSrc) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`Shader compile failed: ${log}`);
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER,   vsSrc);
    const fs = compile(gl.FRAGMENT_SHADER, fsSrc);
    const p  = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`Program link failed: ${log}`);
    }
    return p;
  }

  // ─── Render loop ───────────────────────────────────────
  _renderLoop() {
    if (this._destroyed) return;
    try {
      // Resize if the webcam delivered a different resolution than we assumed
      if (this.video.videoWidth  && this.video.videoHeight &&
         (this.video.videoWidth  !== this.canvas.width ||
          this.video.videoHeight !== this.canvas.height)) {
        this._resizeTo(this.video.videoWidth, this.video.videoHeight);
      }
      this._renderFrame();
    } catch (err) {
      this._failSafe('renderFrame', err);
      return;
    }
    this._rafHandle = requestAnimationFrame(() => this._renderLoop());
  }

  _renderFrame() {
    const gl = this.gl;
    const W  = this.canvas.width;
    const H  = this.canvas.height;

    // Skip if video isn't ready yet (first few frames)
    if (this.video.readyState < 2 || !this.video.videoWidth) return;

    // ─── 1. Upload current video frame into texVideo ───
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);

    // Auto-Beauty tick. Samples the RAW video frame (not the canvas) so
    // decisions are based on actual input characteristics, not the
    // previously-tuned output. Internal 2-second throttle keeps this
    // call cheap — the engine early-returns until it's time to sample.
    // writeBack receives only the delta keys it wants to change, and
    // we forward to the App.jsx callback that persists + re-renders.
    if (this._autoBeauty && this._onAutoBeautyUpdate) {
      this._autoBeauty.maybeTick(
        performance.now(),
        this.video,
        this.config,
        (updates) => {
          // Engine assumes writeBack is the canonical path for applying
          // its changes. Apply to our own config immediately so the
          // shader sees new values THIS frame, then notify App.jsx so
          // it mirrors into React state + electron-store.
          Object.assign(this.config, updates);
          try { this._onAutoBeautyUpdate(updates); } catch {}
        }
      );
    }

    const bgModeActive = (this.config.bgMode ?? 0) > 0;
    const bgBlurActive = (this.config.bgMode ?? 0) === 1;

    // Drive the segmentation worker from the render loop. pushFrame is
    // fire-and-forget: it'll skip if an inference is still in flight,
    // and it'll skip if the segmenter isn't ready yet. No await — we
    // never block compositing on ML inference.
    if (bgModeActive && this._segmenter) {
      this._segmenter.pushFrame(this.video);
    }

    // If the segmenter has a fresh mask, upload it. Happens once per
    // inference result, independent of render frame rate.
    if (bgModeActive && this._segmenter && this._segmenter.ready) {
      // CRITICAL: the mask must be uploaded with the SAME vertical flip
      // as the video texture above. Both MediaPipe's mask and the video
      // arrive in "image coordinates" (top row first, like a raster
      // scan). We upload the video with UNPACK_FLIP_Y_WEBGL=true so its
      // top row lands at UV v=1 — matching the standard GL convention
      // where the shader samples texture(sampler, v_uv) and (0,0) is
      // bottom-left. The mask needs the identical flip so that when the
      // composite shader reads texture(u_mask, v_uv), the person's head
      // at UV v=1 samples the top of the mask (where MediaPipe actually
      // put the head). Without this flip the mask reads upside-down
      // relative to the video — the head gets composited with the
      // mask's bottom-row values (frequently background) and the
      // torso with the mask's top-row values, producing a blur pattern
      // that roughly resembles a flipped cutout of the subject. That's
      // what Ridge's bug screenshot showed.
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      this._segmenter.uploadMaskTo(gl);

      // Auto-feather calibration — once per ~30 frames (roughly 1 sec
      // at 30 fps), analyze the mask's confidence distribution and
      // EMA-smooth toward the computed optimum. Running continuously
      // means we adapt to changing lighting (a lamp flicks on, user
      // changes posture) instead of baking in a bad first-frame
      // estimate forever.
      this._framesSinceAnalysis++;
      if (this.config.autoFeather && this._framesSinceAnalysis >= 30) {
        this._framesSinceAnalysis = 0;
        this._analyzeMaskForHalo();
      }
    } else {
      this._framesSinceAnalysis = 0;
    }

    // If filter is disabled, short-circuit: just blit the video straight
    // to the canvas and skip both bilateral passes. This still keeps the
    // output MediaStream alive so consumers don't lose their track.
    if (!this.config.enabled) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.progComposite);
      // Bind all 4 textures — even unused ones need a valid binding so
      // WebGL doesn't complain about incomplete samplers.
      this._bindCompositeTextures(/*bgMode*/ 0);
      // Every slider at neutral — passthrough
      gl.uniform1f(this.locComposite.intensity,  0.0);
      gl.uniform1f(this.locComposite.warmth,     0.0);
      gl.uniform1f(this.locComposite.brightness, 0.0);
      gl.uniform1f(this.locComposite.sharpness,  0.0);
      gl.uniform1f(this.locComposite.contrast,   0.0);
      gl.uniform1f(this.locComposite.saturation, 0.0);
      gl.uniform1f(this.locComposite.lowLight,   0.0);
      gl.uniform1f(this.locComposite.radial,     0.0);
      gl.uniform1f(this.locComposite.aspect,     W / Math.max(1, H));
      gl.uniform1i(this.locComposite.bgMode,     0);
      gl.uniform3f(this.locComposite.bgColor,    0, 0, 0);
      gl.uniform1f(this.locComposite.maskFeather, this._resolveFeather());
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      return;
    }

    const sigmaColor = mapSmoothness(this.config.smoothness);
    const texel      = [1.0 / W, 1.0 / H];

    // ─── 2. Horizontal bilateral pass: texVideo → fbHoriz ───
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbHoriz);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.progBilateral);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(this.locBilateral.tex,        0);
    gl.uniform2f(this.locBilateral.texel,      texel[0], texel[1]);
    gl.uniform2f(this.locBilateral.direction,  1.0, 0.0);
    gl.uniform1f(this.locBilateral.sigmaColor, sigmaColor);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ─── 3. Vertical bilateral pass: texHoriz → fbSmoothed ───
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbSmoothed);
    gl.viewport(0, 0, W, H);
    gl.bindTexture(gl.TEXTURE_2D, this.texHoriz);
    gl.uniform2f(this.locBilateral.direction,  0.0, 1.0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // ─── 3b. Optional Gaussian bg blur passes (only if bg mode = blur) ───
    // Gaussian runs on the ORIGINAL frame, not the beauty-processed one,
    // so the background stays visually "natural" rather than also being
    // smoothed/color-graded. Matches NVIDIA Broadcast's behavior.
    if (bgBlurActive) {
      const bgStrength = Math.max(0, Math.min(100, this.config.bgStrength ?? 60)) / 100;

      // Horizontal: texVideo → fbBgHoriz
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBgHoriz);
      gl.viewport(0, 0, W, H);
      gl.useProgram(this.progGaussian);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
      gl.uniform1i(this.locGaussian.tex,       0);
      gl.uniform2f(this.locGaussian.texel,     texel[0], texel[1]);
      gl.uniform2f(this.locGaussian.direction, 1.0, 0.0);
      gl.uniform1f(this.locGaussian.strength,  bgStrength);
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      // Vertical: fbBgHoriz → fbBgBlurred
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbBgBlurred);
      gl.viewport(0, 0, W, H);
      gl.bindTexture(gl.TEXTURE_2D, this.texBgHoriz);
      gl.uniform2f(this.locGaussian.direction, 0.0, 1.0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }

    // ─── 4. Composite → screen ───
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, W, H);
    gl.useProgram(this.progComposite);

    // If the segmenter isn't ready yet, fall back to no bg effect — the
    // shader will see bgMode=0 and skip the mask composite.
    const segReady = !!(this._segmenter && this._segmenter.ready);
    const effectiveBgMode = (bgModeActive && segReady) ? (this.config.bgMode | 0) : 0;

    // Diagnostic: log every state transition in the (requestedBgMode,
    // effectiveBgMode, segReady) triple so the console shows exactly
    // when and why the shader chose to composite or skip. Only fires
    // once per transition — render loop spam is worse than silence.
    const stateKey = `${this.config.bgMode | 0}-${effectiveBgMode}-${segReady ? 1 : 0}`;
    if (stateKey !== this._lastBgStateKey) {
      this._lastBgStateKey = stateKey;
      try {
        // eslint-disable-next-line no-console
        console.log('[BeautyFilter] bg state:', {
          requestedBgMode: this.config.bgMode | 0,
          effectiveBgMode,
          segReady,
          segmenterExists: !!this._segmenter,
          mediapipeInstalledFlag: this.config.mediapipeInstalled === true,
        });
      } catch {}
    }

    this._bindCompositeTextures(effectiveBgMode);

    // Slider values are authored in human-friendly ranges (0..100 for
    // unipolar, -100..+100 for bipolar). Normalize to shader space here.
    const c = this.config;
    const uni01  = (v) => Math.max(0,    Math.min(100, v)) / 100;
    const uniPM1 = (v) => Math.max(-100, Math.min(100, v)) / 100;
    gl.uniform1f(this.locComposite.intensity,  uni01(c.intensity));
    gl.uniform1f(this.locComposite.warmth,     uniPM1(c.warmth));
    gl.uniform1f(this.locComposite.brightness, uniPM1(c.brightness));
    gl.uniform1f(this.locComposite.sharpness,  uni01(c.sharpness   ?? 0));
    gl.uniform1f(this.locComposite.contrast,   uniPM1(c.contrast   ?? 0));
    gl.uniform1f(this.locComposite.saturation, uniPM1(c.saturation ?? 0));
    gl.uniform1f(this.locComposite.lowLight,   uni01(c.lowLight    ?? 0));
    gl.uniform1f(this.locComposite.radial,     uniPM1(c.radial     ?? 0));
    gl.uniform1f(this.locComposite.aspect,     W / Math.max(1, H));
    gl.uniform1i(this.locComposite.bgMode,     effectiveBgMode);
    const bgRgb = hexToRgb(c.bgColor ?? '#1a1a22');
    gl.uniform3f(this.locComposite.bgColor,    bgRgb[0], bgRgb[1], bgRgb[2]);
    // Gradient slots A..E. Each packed as vec4(r, g, b, active) into a
    // flat Float32Array(20); single uniform4fv call updates all 5 slots
    // in one driver trip. A slot set to the 'none' sentinel writes
    // (0,0,0,0) so sampleGradient() in the shader skips it. Always
    // written, even when bgMode !== 3 — the shader's branch makes them
    // no-ops in other modes, cheaper than a JS conditional.
    const buf = this._gradSlotsBuf;
    let anyActive = false;
    for (let i = 0; i < GRADIENT_SLOT_COUNT; i++) {
      const key = GRADIENT_SLOT_KEYS[i];
      const val = c[key];
      const base = i * 4;
      if (isGradientSlotActive(val)) {
        const [r, g, b] = hexToRgb(val);
        buf[base]     = r;
        buf[base + 1] = g;
        buf[base + 2] = b;
        buf[base + 3] = 1.0;
        anyActive = true;
      } else {
        buf[base]     = 0;
        buf[base + 1] = 0;
        buf[base + 2] = 0;
        buf[base + 3] = 0;
      }
    }
    // Prefer the array-base location (single driver call); fall back to
    // per-element writes if the driver only exposed explicit indices.
    if (this.locComposite.bgGradSlots) {
      gl.uniform4fv(this.locComposite.bgGradSlots, buf);
    } else {
      for (let i = 0; i < GRADIENT_SLOT_COUNT; i++) {
        const loc = this.locComposite.bgGradSlotsIdx[i];
        if (loc) {
          const b = i * 4;
          gl.uniform4f(loc, buf[b], buf[b + 1], buf[b + 2], buf[b + 3]);
        }
      }
    }

    // One-shot (per mode-entry) diagnostic: when the render loop enters
    // gradient mode from a non-gradient mode, log the full slot state to
    // DevTools. Lets us verify whether uniforms are reaching the shader
    // or being optimized out. Only fires on the transition 0/1/2 → 3 so
    // it doesn't spam the console; re-fires if the user switches modes.
    if (effectiveBgMode === 3 && this._lastLoggedBgMode !== 3) {
      this._lastLoggedBgMode = 3;
      try {
        // eslint-disable-next-line no-console
        console.log('[BeautyFilter] gradient mode diagnostic:', {
          bgMode: effectiveBgMode,
          slots: GRADIENT_SLOT_KEYS.map((k) => c[k]),
          anyActive,
          bgGradSlotsLoc: !!this.locComposite.bgGradSlots,
          bgGradSlotsIdxNonNull: this.locComposite.bgGradSlotsIdx.filter(Boolean).length,
          bgGradStyle: c.bgGradientStyle,
          bufFirstTwoSlots: Array.from(buf.slice(0, 8)),
        });
      } catch {}
    } else if (effectiveBgMode !== 3 && this._lastLoggedBgMode === 3) {
      this._lastLoggedBgMode = effectiveBgMode;
    }

    gl.uniform1i(this.locComposite.bgGradStyle, (c.bgGradientStyle ?? 0) | 0);
    gl.uniform1f(this.locComposite.maskFeather, this._resolveFeather());
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  // Bind the four sampler textures the composite shader expects. Always
  // binds all four even when a sampler is unused for the current mode —
  // WebGL requires every referenced sampler2D to have a valid texture.
  _bindCompositeTextures(/*effectiveBgMode*/) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.uniform1i(this.locComposite.original, 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.texSmoothed);
    gl.uniform1i(this.locComposite.smoothed, 1);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.texBgBlurred);
    gl.uniform1i(this.locComposite.bgBlurred, 2);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.uniform1i(this.locComposite.mask, 3);
  }

  /**
   * Resolve the u_maskFeather uniform value. In auto mode, returns the
   * EMA-smoothed value computed from periodic mask analysis. In manual
   * mode, maps the user's 0..100 slider into the shader's 0.05..0.30
   * working range.
   */
  _resolveFeather() {
    if (this.config.autoFeather !== false) {
      return this._currentFeather;
    }
    const t = Math.max(0, Math.min(100, this.config.manualFeather ?? 50)) / 100;
    return 0.05 + t * 0.25;   // 0.05..0.30
  }

  /**
   * Auto-halo detection. Samples the current mask (owned by the
   * SelfieSegmenter on the main thread), measures how wide the
   * transition band is — the fraction of pixels whose confidence
   * sits between the "definitely bg" and "definitely person" bands.
   *
   * Why this works:
   * • A cleanly-segmented subject on a high-contrast bg produces a
   *   mask with most pixels near 0 or near 1; the transition band is
   *   a thin ring around the silhouette. Small transition ratio →
   *   small feather is enough.
   * • A fuzzy subject (flyaway hair, fabric, glasses) produces lots
   *   of mid-confidence pixels. Large transition ratio → needs more
   *   feather to hide the ambiguity, else we see halo.
   *
   * The raw computed feather is EMA-smoothed into _currentFeather so
   * lighting changes or posture shifts re-settle gradually rather
   * than jumping the shader uniform.
   *
   * Cost: one pass over the mask with stride-2 subsampling. For a
   * 256×256 MediaPipe mask that's ~16k samples — a few hundred µs on
   * any hardware, run once per ~30 render frames (≈ once per second).
   */
  _analyzeMaskForHalo() {
    const seg = this._segmenter;
    if (!seg || !seg._maskData || !seg._maskW || !seg._maskH) return;

    const data = seg._maskData;
    const w = seg._maskW;
    const h = seg._maskH;

    let total = 0;
    let transition = 0;

    // Stride-2 subsample on both axes = 4× speedup, same distribution
    // shape within statistical noise.
    const stride = 2;
    for (let y = 0; y < h; y += stride) {
      for (let x = 0; x < w; x += stride) {
        const v = data[y * w + x];
        total++;
        if (v > 0.1 && v < 0.9) transition++;
      }
    }
    if (total === 0) return;

    const transitionRatio = transition / total;

    // Linear map from transition-ratio to feather width:
    //   ≤ 5 % transition → 0.08 (tight/confident segmentation)
    //   ~15 % transition → ~0.17 (normal cam performer on typical bg)
    //   ≥ 25 % transition → 0.25 (fuzzy edges, low contrast — max feather)
    const rawFeather = Math.max(0.05, Math.min(0.25,
      0.08 + Math.max(0, transitionRatio - 0.05) * 0.9
    ));

    // EMA toward the new value. alpha=0.25 → ~75 % weight on history,
    // 25 % on this measurement. With 1-per-second cadence the feather
    // converges to a steady state within ~4 seconds and won't thrash
    // under transient changes (the subject briefly turning sideways,
    // a webcam AE adjustment, etc.).
    const alpha = 0.25;
    this._autoFeatherEMA = (1 - alpha) * this._autoFeatherEMA + alpha * rawFeather;
    this._currentFeather = this._autoFeatherEMA;

    this._lastAnalysis = {
      transitionRatio,
      rawFeather,
      emaFeather: this._currentFeather,
      ts: performance.now(),
    };
  }

  _failSafe(stage, err) {
    this._lastError = err;
    this._passthrough = true;
    if (this._rafHandle) cancelAnimationFrame(this._rafHandle);
    const msg = err?.message || String(err);
    try {
      window.electronAPI?.errors?.log?.('error', 'beauty-filter', `${stage}: ${msg}`, { stack: err?.stack });
    } catch {}
    // eslint-disable-next-line no-console
    console.warn(`[BeautyFilter] ${stage} failed, falling back to passthrough:`, msg);
  }
}

export { DEFAULT_CONFIG };
