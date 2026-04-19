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
  bgMode:     0,    // 0=off, 1=blur, 2=color
  bgStrength: 60,   // 0–100 — Gaussian blur strength when bgMode=1
  bgColor:    '#1a1a22', // hex — replacement color when bgMode=2
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
  constructor(inputStream, config = {}) {
    this.inputStream = inputStream;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this._passthrough = false;      // true → getStream() returns inputStream
    this._rafHandle   = null;
    this._outputStream = null;
    this._destroyed   = false;
    this._lastError   = null;
    this._segmenter = null;
    this._segmenterInitStarted = false;

    try {
      this._setup();
    } catch (err) {
      this._failSafe('setup', err);
    }

    // If the initial config already has bg effects on (e.g. user had
    // them on in the last session and store-hydration kicked in), start
    // the segmenter immediately rather than waiting for an update().
    if ((this.config.bgMode ?? 0) > 0 && !this._passthrough) {
      this._segmenterInitStarted = true;
      this._segmenter = new SelfieSegmenter(this.video);
      this._segmenter.init();
    }
  }

  // ─── Public API ────────────────────────────────────────
  getStream() {
    if (this._passthrough || !this._outputStream) return this.inputStream;
    // If the filter is runtime-disabled, still return the processed stream
    // but render a pass-through frame so downstream consumers don't re-bind.
    return this._outputStream;
  }

  update(partial) {
    Object.assign(this.config, partial);
    // Lazy-load the selfie segmenter the first time the user enables any
    // background effect. Costs ~2–3 MB of one-time network fetch and a
    // few hundred ms of WASM compile. Users who never touch bg never pay.
    const wantsSegmentation = (this.config.bgMode ?? 0) > 0;
    if (wantsSegmentation && !this._segmenter && !this._segmenterInitStarted) {
      this._segmenterInitStarted = true;
      this._segmenter = new SelfieSegmenter(this.video);
      this._segmenter.init(); // async; ready flag flips when model loads
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
      maskFeather: gl.getUniformLocation(this.progComposite, 'u_maskFeather'),
    };

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

    // Kick off playback + render loop
    const start = () => {
      if (this.video.videoWidth && this.video.videoHeight) {
        this._resizeTo(this.video.videoWidth, this.video.videoHeight);
      }
      this._outputStream = this.canvas.captureStream(30);
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

    const bgModeActive = (this.config.bgMode ?? 0) > 0;
    const bgBlurActive = (this.config.bgMode ?? 0) === 1;

    // If the segmenter has a fresh mask, upload it. Happens once per
    // inference result, independent of render frame rate.
    if (bgModeActive && this._segmenter && this._segmenter.ready) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // mask is already in image coords
      gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      this._segmenter.uploadMaskTo(gl);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
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
      gl.uniform1f(this.locComposite.maskFeather, 0.15);
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
    gl.uniform1f(this.locComposite.maskFeather, 0.15);
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
