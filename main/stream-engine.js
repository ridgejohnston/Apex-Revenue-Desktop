/**
 * Apex Revenue — Stream Engine
 * RTMP streaming + local recording via FFmpeg
 * Virtual camera output
 */

const { EventEmitter } = require('events');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { findFFmpegPath } = require('./ffmpeg-installer');
const errorLogger = require('./error-logger');
const { STREAM_RESOLUTIONS_16_9 } = require('./autoconfig');

function findFFmpeg() {
  return findFFmpegPath() || 'ffmpeg';
}

// H.264 encoder preference order. Ordered hardware-first (zero CPU cost)
// → software fallback (works anywhere). CRITICAL: being in this list and
// being returned by `ffmpeg -encoders` only means the encoder is COMPILED
// INTO the FFmpeg binary — runtime availability depends on the user's
// actual GPU and drivers. _probeEncoderRuntime() verifies that the
// encoder can actually open on this specific machine.
//
// Order rationale:
//   h264_nvenc   → NVIDIA GPU + nvcuda.dll from drivers
//   h264_qsv     → Intel CPU with integrated graphics (most Intel laptops)
//   h264_amf     → AMD GPU + AMF runtime from drivers
//   libopenh264  → Cisco's BSD software encoder. Ships in our bundled
//                  FFmpeg (--enable-libopenh264) and runs anywhere that
//                  FFmpeg runs. This is the reliable no-hardware fallback.
//   libx264      → Disabled in our bundle (--disable-libx264), but may
//                  be present in a system-wide FFmpeg the user installed.
//   h264_mf      → Windows Media Foundation. Only in FFmpeg builds that
//                  were compiled with --enable-mediafoundation. Our
//                  current bundle does NOT have this.
const H264_ENCODER_CANDIDATES = [
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'libopenh264',
  'libx264',
  'h264_mf',
];

class StreamEngine extends EventEmitter {
  constructor() {
    super();
    this.ffmpegPath = findFFmpeg();
    this._h264Encoder = null; // resolved lazily on first stream start
    this.streamProcess = null;
    this.recordProcess = null;
    this.virtualCamProcess = null;
    this.status = {
      streaming: false,
      recording: false,
      virtualCam: false,
      streamUptime: 0,
      recordDuration: 0,
      droppedFrames: 0,
      fps: 0,
      bitrate: 0,
      cpuUsage: 0,
    };
    this._uptimeInterval = null;
    this._recordInterval = null;
  }

  // ─── Encoder Detection ────────────────────────────────
  // Two-phase detection:
  //   1. Compile-time: which H.264 encoders does this FFmpeg binary have
  //      built in? (answered by `ffmpeg -encoders`)
  //   2. Runtime:      which of those can actually INITIALIZE on this
  //      specific machine? (answered by attempting a tiny test encode)
  //
  // The runtime phase is what we were missing — FFmpeg cheerfully lists
  // h264_nvenc in its -encoders output even on machines with no NVIDIA
  // driver, then fails at stream time with "Cannot load nvcuda.dll".
  // Same story for h264_amf (AMF runtime DLL) and h264_qsv (libvpl).
  //
  // Results are cached on the instance, so we only pay the probe cost
  // once per app session. The probe itself runs in ~300-500ms per encoder
  // and is skipped entirely for encoders not compiled in.
  _detectH264Encoder(preferred) {
    this._ensureAvailableEncoders();

    // Honor user's preferred encoder when it's actually usable here.
    if (preferred && this._usableH264Encoders.includes(preferred)) {
      return preferred;
    }
    if (preferred) {
      console.warn(`[StreamEngine] Preferred encoder "${preferred}" is not usable on this machine. Usable: ${this._usableH264Encoders.join(', ') || 'none'}`);
    }

    // Auto-select the first usable encoder from the priority order.
    if (this._usableH264Encoders.length > 0) {
      return this._usableH264Encoders[0];
    }

    // Absolute last resort — no encoders probed clean. h264_mf is always
    // available on Windows 10+ IF it was compiled in; worst case FFmpeg
    // will fail with a clearer error than we'd otherwise produce.
    console.warn('[StreamEngine] No H.264 encoder survived runtime probing — falling back blindly to h264_mf');
    return 'h264_mf';
  }

  // Populate this._usableH264Encoders with the encoders that both (a) are
  // compiled into this FFmpeg binary AND (b) pass a runtime open test.
  // Populated on first call, cached for the rest of the app session.
  _ensureAvailableEncoders() {
    if (this._usableH264Encoders) return;

    // Phase 1: compile-time list
    let compiled = [];
    try {
      const out = execFileSync(this.ffmpegPath, ['-encoders', '-v', 'quiet'], {
        timeout: 8000,
        windowsHide: true,
      }).toString();
      compiled = H264_ENCODER_CANDIDATES.filter((enc) => out.includes(` ${enc} `));
      console.log('[StreamEngine] Compile-time H.264 encoders:', compiled);
    } catch (e) {
      console.warn('[StreamEngine] -encoders probe failed:', e.message);
      this._usableH264Encoders = [];
      return;
    }

    // Phase 2: runtime probe each. Keep only the ones that actually open.
    const usable = [];
    for (const enc of compiled) {
      if (this._probeEncoderRuntime(enc)) {
        usable.push(enc);
      } else {
        console.warn(`[StreamEngine] Runtime probe failed for ${enc} — not usable on this machine`);
      }
    }
    this._usableH264Encoders = usable;
    console.log('[StreamEngine] Runtime-usable H.264 encoders:', usable);
  }

  // Run a tiny test encode to verify the encoder can actually initialize
  // on this machine. We generate 0.05 seconds of 128x72 null video and
  // try to push it through the encoder to a null sink — if the encoder
  // can't load its runtime dependencies (nvcuda.dll, amfrt, etc.), the
  // ffmpeg call exits non-zero and we know to skip it.
  //
  // Returns true if the encoder opened cleanly, false otherwise.
  _probeEncoderRuntime(encoder) {
    try {
      execFileSync(this.ffmpegPath, [
        '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'nullsrc=s=128x72:d=0.05',
        '-c:v', encoder,
        ...this._presetArgsFor(encoder),
        '-t', '0.05',
        '-f', 'null', '-',
      ], {
        timeout: 5000,
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'], // capture stderr for debugging
      });
      return true;
    } catch (err) {
      // Non-zero exit = encoder can't init. Log stderr in case we need it.
      const stderr = (err.stderr && err.stderr.toString()) || '';
      if (stderr) {
        console.warn(`[StreamEngine] Probe stderr for ${encoder}:`, stderr.trim().split('\n').slice(-3).join(' | '));
      }
      return false;
    }
  }

  // Build the video encoding args for the detected encoder.
  _videoEncodeArgs(encoder, videoBitrate, fps, resolution) {
    const base = [
      '-c:v', encoder,
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${videoBitrate}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2),
    ];
    // Scale to target resolution
    const scaleArgs = ['-vf', `scale=${resolution.width}:${resolution.height}`];
    const presetArgs = this._presetArgsFor(encoder);
    return [...scaleArgs, ...base, ...presetArgs];
  }

  // v3.4.47 — Build FFmpeg filter_complex graph for scene-overlay
  // compositing over the webcam pipe.
  //
  // The renderer (App.jsx buildOverlayList) hands us a list of overlay
  // descriptors already translated into target-resolution absolute
  // pixel coords. This method generates:
  //
  //   - extraInputArgs : additional `-i` flags for image/video overlay
  //                       inputs. These are appended AFTER the pipe
  //                       input so the pipe stays at input index 0
  //                       (the existing -fflags/-thread_queue_size
  //                       flags are per-input and need to bind to the
  //                       matroska pipe, not an image).
  //   - filterComplex  : the full `-filter_complex` string describing
  //                       the composite pipeline. Pipe input 0 is
  //                       scaled to target resolution, then each
  //                       overlay is applied in z-order.
  //   - outputLabel    : the final filter label to `-map` for encoding.
  //                       Always '[out]' when overlays are present.
  //   - textFiles      : tmp .txt files created for drawtext sources
  //                       (drawtext's textfile= option avoids the
  //                       escaping nightmare of inline text with
  //                       colons/backslashes/commas). Caller cleans
  //                       these up when the stream stops.
  //
  // Overlay type handling:
  //   image : extra -i input, scale to overlay w/h, optional alpha
  //           mix via format=yuva420p,colorchannelmixer=aa=opacity,
  //           then overlay=x:y onto the running base.
  //   video : same as image but with -stream_loop -1 when loop=true.
  //           Audio tracks are IGNORED — this commit does video-only
  //           compositing; mixing video-file audio is deferred.
  //   color : drawbox filter on the running base, no extra input.
  //   text  : drawtext filter with textfile= for safe escaping.
  _buildOverlayFilterComplex(overlays, resolution) {
    if (!overlays || !overlays.length) return null;

    const path = require('path');
    const os = require('os');
    const fs = require('fs');

    const tgtW = resolution.width;
    const tgtH = resolution.height;
    const chains = [];
    const extraInputArgs = [];
    const textFiles = [];

    // Base: scale the pipe input to exact target resolution in yuv420p.
    // filter_complex expects labeled inputs via [index:stream] syntax —
    // pipe is input 0, video track 0, so [0:v].
    chains.push(`[0:v]scale=${tgtW}:${tgtH},format=yuv420p[base0]`);
    let currentLabel = 'base0';
    let nextInputIdx = 1; // image/video overlays get -i at index 1, 2, 3...

    overlays.forEach((ov, i) => {
      const nextLabel = `base${i + 1}`;
      const opacity = typeof ov.opacity === 'number' ? Math.max(0, Math.min(1, ov.opacity)) : 1;

      if (ov.type === 'image') {
        // Still image loop: -loop 1 -framerate 30 -i PATH
        // Without -framerate the encoder sees one duration-less frame
        // and filter_complex hangs waiting for more.
        extraInputArgs.push('-loop', '1', '-framerate', '30', '-i', ov.path);
        const alphaChain = (opacity < 1)
          ? `,format=yuva420p,colorchannelmixer=aa=${opacity.toFixed(3)}`
          : `,format=yuva420p`;
        const srcLabel = `src${i}`;
        chains.push(`[${nextInputIdx}:v]scale=${ov.w}:${ov.h}${alphaChain}[${srcLabel}]`);
        chains.push(`[${currentLabel}][${srcLabel}]overlay=${ov.x}:${ov.y}[${nextLabel}]`);
        nextInputIdx++;
        currentLabel = nextLabel;

      } else if (ov.type === 'video') {
        // Looping video file. -stream_loop -1 before the input wraps
        // playback infinitely. Applies per-input; this is input-level,
        // not filter-level.
        if (ov.loop) extraInputArgs.push('-stream_loop', '-1');
        extraInputArgs.push('-i', ov.path);
        const alphaChain = (opacity < 1)
          ? `,format=yuva420p,colorchannelmixer=aa=${opacity.toFixed(3)}`
          : '';
        const srcLabel = `src${i}`;
        chains.push(`[${nextInputIdx}:v]scale=${ov.w}:${ov.h}${alphaChain}[${srcLabel}]`);
        chains.push(`[${currentLabel}][${srcLabel}]overlay=${ov.x}:${ov.y}[${nextLabel}]`);
        nextInputIdx++;
        currentLabel = nextLabel;

      } else if (ov.type === 'color') {
        // Flat color rect via drawbox — no extra input needed.
        // FFmpeg's color syntax accepts 0xRRGGBB@opacity.
        const hex = (ov.color || '#000000').replace(/^#/, '');
        chains.push(
          `[${currentLabel}]drawbox=x=${ov.x}:y=${ov.y}:w=${ov.w}:h=${ov.h}:color=0x${hex}@${opacity.toFixed(3)}:t=fill[${nextLabel}]`
        );
        currentLabel = nextLabel;

      } else if (ov.type === 'text') {
        // Text via drawtext. Write the literal text to a tmp file and
        // reference it with textfile=PATH, bypassing the escape rules
        // that apply to inline drawtext=text= strings (colons,
        // backslashes, percent signs, commas all need escaping, and
        // Windows paths make it worse). The tmp file is cleaned up
        // by the caller when the stream stops.
        const tmpPath = path.join(os.tmpdir(), `apex-text-${process.pid}-${Date.now()}-${i}.txt`);
        try {
          fs.writeFileSync(tmpPath, String(ov.text || ''), 'utf8');
          textFiles.push(tmpPath);
        } catch (e) {
          // If we can't write the tmp file, skip this overlay rather
          // than crash the whole stream.
          console.warn('[stream-engine] overlay text write failed:', e.message);
          // Pass through the previous label as the next one so the
          // chain stays contiguous.
          chains.push(`[${currentLabel}]null[${nextLabel}]`);
          currentLabel = nextLabel;
          return;
        }
        // Escape the path for filter-string use. Inside filter
        // strings FFmpeg treats ':' and '\' as metacharacters.
        // Quadruple-backslash = single backslash in the final string
        // because JS escapes once and FFmpeg parses once more.
        const escPath = tmpPath
          .replace(/\\/g, '\\\\\\\\')
          .replace(/:/g, '\\:');
        const colorHex = (ov.color || '#ffffff').replace(/^#/, '');
        // Center the text vertically within the source box; draw a
        // translucent background box for legibility against varied
        // scene content (matches the PreviewCanvas rendering style).
        const baselineY = ov.y + Math.round(ov.h / 2) - Math.round(ov.fontSize / 2);
        chains.push(
          `[${currentLabel}]drawtext=textfile=${escPath}` +
          `:x=${ov.x + 8}:y=${baselineY}` +
          `:fontsize=${ov.fontSize}:fontcolor=0x${colorHex}@${opacity.toFixed(3)}` +
          `:box=1:boxcolor=black@0.3:boxborderw=8` +
          `[${nextLabel}]`
        );
        currentLabel = nextLabel;

      } else {
        // Unknown overlay type — pass through unchanged so the chain
        // stays contiguous (don't let a typo in one overlay break the
        // whole composite).
        chains.push(`[${currentLabel}]null[${nextLabel}]`);
        currentLabel = nextLabel;
      }
    });

    // Rename the final label to [out] for uniform downstream mapping.
    if (currentLabel !== 'out') {
      chains.push(`[${currentLabel}]null[out]`);
    }

    return {
      filterComplex: chains.join(';'),
      extraInputArgs,
      outputLabel: '[out]',
      textFiles,
    };
  }

  // Small util used by startStreamFromPipe to strip the `-vf scale=...`
  // pair out of _videoEncodeArgs when filter_complex is producing the
  // output (the two can't coexist — FFmpeg errors out with 'Filtergraph
  // simple/complex conflict'). Keeps all the encoder bitrate/gop/preset
  // args intact.
  _stripVfArgs(args) {
    const out = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-vf') { i++; continue; }
      out.push(args[i]);
    }
    return out;
  }

  // Each H.264 encoder uses its own preset vocabulary. Mixing them produces
  // cryptic "Invalid argument" errors at startup — e.g. NVENC rejects the
  // x264 name 'veryfast' because NVENC's presets are p1 (fastest) through
  // p7 (slowest). Keep each encoder's presets in its own lane.
  _presetArgsFor(encoder) {
    switch (encoder) {
      case 'libx264':
        // x264 software encoder: classic speed/quality presets
        return ['-preset', 'veryfast'];
      case 'h264_nvenc':
        // NVIDIA NVENC (modern API): p2 is roughly the 'veryfast' equivalent
        return ['-preset', 'p2'];
      case 'h264_qsv':
        // Intel QuickSync accepts x264-style names
        return ['-preset', 'veryfast'];
      case 'libopenh264':
        // Cisco OpenH264: no preset vocabulary, but -rc_mode bitrate is
        // the sensible default for live streaming (matches our CBR-ish
        // -b:v/-maxrate config). Without -rc_mode it may pick quality mode
        // and ignore bitrate entirely.
        //
        // -allow_skip_frames 1 is CRITICAL. Without it, libopenh264 prints
        // the warning "bEnableFrameSkip = 0, bitrate can't be controlled
        // for RC_QUALITY_MODE, RC_BITRATE_MODE and RC_TIMESTAMP_MODE
        // without enabling skip frame" and proceeds to IGNORE the
        // configured bitrate during complex motion — peaks of 6-8 Mbps
        // have been observed on streams targeting 3.5 Mbps. Cam platforms
        // (Chaturbate, Stripchat) auto-kick streams that exceed their
        // bitrate ceiling, so a 3500k-target stream without frame-skip
        // produces a -10053 disconnect within 1-2 seconds of going live.
        // With frame-skip enabled the encoder drops the occasional frame
        // under load rather than busting the bitrate ceiling — a trade
        // that's strongly preferable on live RTMP where staying connected
        // matters more than perfect smoothness.
        return ['-rc_mode', 'bitrate', '-allow_skip_frames', '1'];
      case 'h264_amf':
      case 'h264_mf':
        // AMD AMF and Windows Media Foundation: no portable preset vocab —
        // just use encoder defaults. Attempting to set an x264 preset on
        // either throws the same EINVAL we were debugging.
        return [];
      default:
        return [];
    }
  }

  // ─── Video Input Source ───────────────────────────────
  // Build the FFmpeg input args for the configured video source.
  //
  //   settings.videoSource === 'webcam'  → dshow capture of the named
  //     device in settings.webcamDevice. The webcam outputs whatever
  //     its native resolution is (typically 1280x720 or 1920x1080);
  //     _videoEncodeArgs's scale filter resamples to the user's chosen
  //     stream resolution, so aspect/dimensions stay consistent.
  //
  //   settings.videoSource === 'screen' or anything else (including
  //     undefined from pre-v3.3.4 saved settings) → gdigrab desktop
  //     capture. This is the backward-compat path.
  // Sanitize a dshow device name before handing it to FFmpeg. Two
  // transforms:
  //
  //   1. Strip browser prefixes. navigator.mediaDevices.enumerateDevices()
  //      returns labels like "Default - Microphone Array (...)" or
  //      "Communications - Speakers (...)" where the prefix signals
  //      which Windows device role is the system default. FFmpeg's
  //      dshow doesn't know about these roles — it expects the raw
  //      Windows friendly name as shown by `ffmpeg -list_devices`.
  //      If the store saved a browser-formatted label (e.g. from an
  //      older UI code path), the prefix breaks FFmpeg's device
  //      lookup with 'Could not find audio only device with name...'.
  //
  //   2. Escape colons. FFmpeg's dshow input format uses ':' as the
  //      video/audio separator (e.g. 'video=<n>:audio=<n>'), so any
  //      colon inside a device name — including the USB
  //      vendor:product ID tacked onto camera names like
  //      'HP TrueVision HD Camera (04f2:b75e)' — gets misparsed as
  //      the separator and triggers 'Malformed dshow input string'.
  //      Backslash-escape per FFmpeg dshow docs.
  //
  // Applied uniformly to both video and audio dshow names so every
  // edge case handled for one input type is handled for the other.
  _sanitizeDshowName(name) {
    if (!name) return '';
    return String(name)
      .replace(/^(Default|Communications)\s*-\s*/i, '')
      .replace(/:/g, '\\:');
  }

  // Build the FFmpeg audio input args. 'audio=<n>' for real devices,
  // silent lavfi fallback when no device is configured. Uses the
  // same sanitizer as video.
  _audioInputArgs(settings) {
    const raw = settings.audioDevice;
    const useAudio = raw && String(raw).trim() !== '';
    if (useAudio) {
      const deviceName = this._sanitizeDshowName(raw);
      return ['-f', 'dshow', '-i', `audio=${deviceName}`];
    }
    return ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
  }

  /**
   * Detect whether the primary file/URL input has at least one audio stream.
   * Uses `ffmpeg -i` stderr (always available) — not ffprobe, which is often
   * missing next to a PATH-only ffmpeg and previously caused us to assume
   * audio existed and emit `-map 0:a:0` on video-only files ("matches no streams").
   */
  _probePrimaryHasAudioStream(settings) {
    const src = settings.videoSource || 'screen';
    if (src !== 'media' && src !== 'video_url') return Promise.resolve(false);

    let target;
    if (src === 'media') {
      target = settings.mediaPath;
      if (!target || !String(target).trim() || !fs.existsSync(target)) {
        return Promise.resolve(false);
      }
    } else {
      target = settings.videoUrl;
      if (!target || !String(target).trim()) return Promise.resolve(false);
    }

    const ffmpegPath = findFFmpegPath();
    if (!ffmpegPath) return Promise.resolve(false);

    return new Promise((resolve) => {
      const proc = spawn(
        ffmpegPath,
        ['-hide_banner', '-nostats', '-i', target],
        { windowsHide: true },
      );
      let stderr = '';
      let settled = false;
      let timer;
      const done = (has) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
        resolve(has);
      };
      const parse = (chunk) => {
        stderr += chunk.toString();
        // Stop early once we know — saves work on huge remote probes.
        if (/Stream\s+#\d+:\d+[^:]*:\s*Audio:/im.test(stderr)) {
          done(true);
        }
      };
      proc.stderr.on('data', parse);
      proc.stdout.on('data', parse);
      proc.on('close', () => {
        if (settled) return;
        const has = /Stream\s+#\d+:\d+[^:]*:\s*Audio:/im.test(stderr);
        done(has);
      });
      proc.on('error', () => done(false));
      timer = setTimeout(() => done(false), 25000);
    });
  }

  /**
   * Decide FFmpeg stream maps and whether to append a second audio input.
   * - media / video_url with embedded audio: single input, map 0:v + 0:a.
   * - media / video_url without audio: gdigrab-style layout (0=video, 1=mic/silent).
   * - all other sources: unchanged (0=video, 1=mic/silent).
   */
  async _resolveStreamMapsAndExtraAudioInputs(settings) {
    const src = settings.videoSource || 'screen';
    if (src !== 'media' && src !== 'video_url') {
      return {
        extraAudioInputs: this._audioInputArgs(settings),
        mapArgs: ['-map', '0:v:0', '-map', '1:a:0'],
      };
    }

    const hasEmbedded = await this._probePrimaryHasAudioStream(settings);
    if (hasEmbedded) {
      return {
        extraAudioInputs: [],
        mapArgs: ['-map', '0:v:0', '-map', '0:a:0'],
      };
    }
    return {
      extraAudioInputs: this._audioInputArgs(settings),
      mapArgs: ['-map', '0:v:0', '-map', '1:a:0'],
    };
  }

  // Resolve a webcam friendly name to the argv value we hand to FFmpeg's
  // -i flag. Earlier versions tried to backslash-escape colons, but
  // FFmpegs libavdevice/dshow.c uses av_strtok(":") which does not
  // honor escapes, so "\:" passes through as literal chars and the
  // parser still splits on the colon.
  //
  // The FFmpeg-recommended workaround is to use the device Windows
  // stable alternative name ("@device_pnp_..."), which is colon-free
  // and parses cleanly. We probe dshow (detectWebcams) to find the
  // alt name matching the friendly name, and swap it in for
  // colon-bearing names. No-colon names pass through the sanitizer
  // unchanged.
  //
  // Cached per engine instance. The dshow device list only changes on
  // plug/unplug so one lookup per session is enough.
  async _resolveDshowVideoName(friendlyName) {
    if (!friendlyName) return '';

    // No colon in the friendly name: sanitizer is enough, no probe.
    if (!String(friendlyName).includes(':')) {
      this._diag('has colon: no (sanitize path)');
      return this._sanitizeDshowName(friendlyName);
    }
    this._diag('has colon: yes (alt-name lookup needed)');

    if (!this._altNameCache) this._altNameCache = new Map();
    if (this._altNameCache.has(friendlyName)) {
      const cached = this._altNameCache.get(friendlyName);
      this._diag(`cache: HIT, returning ${JSON.stringify(cached)}`);
      return cached;
    }
    this._diag('cache: miss, running detectWebcams');

    try {
      const t0 = Date.now();
      const devices = await this.detectWebcams();
      const elapsed = Date.now() - t0;
      this._diag(`detectWebcams completed in ${elapsed}ms, returned ${devices.length} device(s)`);
      devices.forEach((d, i) => {
        this._diag(`  [${i}] name=${JSON.stringify(d.name)} altName=${d.alternativeName ? JSON.stringify(d.alternativeName) : 'null'}`);
      });
      // If the parser returned empty, dump the first 2KB of raw stderr
      // so we can see exactly what FFmpeg's output format looks like on
      // this machine and fix the parser if it's drifted again.
      if (devices.length === 0 && this._lastDetectStderr) {
        this._diag('raw stderr (first 2KB):');
        this._lastDetectStderr.slice(0, 2048).split('\n').forEach((l) => this._diag(`  ${l}`));
      }

      const strippedForMatch = String(friendlyName)
        .replace(/^(Default|Communications)\s*-\s*/i, '');
      this._diag(`matching against (after stripping prefix): ${JSON.stringify(strippedForMatch)}`);

      // Browser's navigator.mediaDevices.enumerateDevices() returns
      // labels like "HP TrueVision HD Camera (04f2:b75e)" — the
      // "(xxxx:xxxx)" is the USB vendor:product ID Chromium appends
      // for disambiguation when multiple cameras share a friendly
      // name. FFmpeg's DirectShow enumeration doesn't include this
      // suffix; it returns the bare friendly name
      // "HP TrueVision HD Camera". Exact string equality between
      // browser label and FFmpeg name fails for these devices.
      //
      // Try multiple strategies in order of specificity. Stripping
      // only the literal "(xxxx:xxxx)" USB ID pattern keeps us safe
      // from false positives — we don't fuzzy-match arbitrary
      // suffixes that might differentiate real distinct devices.
      const stripUsb = (s) => s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '');
      const queryBare = stripUsb(strippedForMatch);

      let match = devices.find((d) => d.name === strippedForMatch);
      let strategy = 'exact';
      if (!match && queryBare !== strippedForMatch) {
        match = devices.find((d) => d.name === queryBare);
        if (match) strategy = 'exact-after-strip-usb-from-query';
      }
      if (!match) {
        match = devices.find((d) => stripUsb(d.name) === strippedForMatch);
        if (match) strategy = 'exact-after-strip-usb-from-device';
      }
      if (!match) {
        match = devices.find((d) => stripUsb(d.name) === queryBare);
        if (match) strategy = 'exact-after-strip-usb-from-both';
      }

      if (match && match.alternativeName) {
        this._diag(`match: FOUND via "${strategy}", using alt name ${JSON.stringify(match.alternativeName)}`);
        console.log(`[StreamEngine] Resolved "${friendlyName}" -> alternative name (${strategy})`);
        this._altNameCache.set(friendlyName, match.alternativeName);
        return match.alternativeName;
      }
      if (match && !match.alternativeName) {
        this._diag('match: FOUND but device has no alternativeName (parser issue?)');
      } else {
        this._diag('match: NOT FOUND in device list (tried exact and USB-id-stripped variants)');
      }
      console.warn(`[StreamEngine] No alt name found for "${friendlyName}"; falling back to sanitized friendly name (stream may fail)`);
    } catch (err) {
      this._diag(`detectWebcams threw: ${err.message}`);
      console.warn('[StreamEngine] Alt-name lookup failed:', err.message);
    }

    // Fallback: sanitize and cache so we don't re-probe every call.
    const sanitized = this._sanitizeDshowName(friendlyName);
    this._diag(`fallback: sanitized name = ${JSON.stringify(sanitized)} (may still fail in FFmpeg)`);
    this._altNameCache.set(friendlyName, sanitized);
    return sanitized;
  }

  // Pre-populate the alt-name cache by running detectWebcams once. Call
  // this from main.js on app ready, BEFORE the renderer has a chance to
  // open getUserMedia handles on any webcam. Rationale: Windows cameras
  // can go into an exclusive-access state once a process holds them via
  // DirectShow filter graph / Media Foundation, and subsequent
  // -list_devices probes may miss the device or return it without its
  // Alternative name line. Running the probe at true app startup beats
  // this race; the cache then serves _resolveDshowVideoName for the
  // rest of the session.
  async preflightDeviceDetection() {
    try {
      const devices = await this.detectWebcams();
      if (!this._altNameCache) this._altNameCache = new Map();
      let cached = 0;
      for (const d of devices) {
        if (!d.alternativeName) continue;
        const base = d.name;
        const keys = [base, `Default - ${base}`, `Communications - ${base}`];

        // Reconstruct browser-style "(xxxx:xxxx)" USB suffix. The alt
        // name for USB webcams always contains "vid_XXXX&pid_XXXX"
        // (e.g. @device_pnp_\\?\usb#vid_04f2&pid_b75e&mi_00#...), so
        // we can rebuild exactly the string Chromium enumerateDevices
        // emits and cache an alt-name entry for it. Saves the
        // multi-strategy matcher from having to fire at stream time.
        const vidPid = d.alternativeName.match(/vid_([0-9a-f]{4}).*?pid_([0-9a-f]{4})/i);
        if (vidPid) {
          const withUsb = `${base} (${vidPid[1]}:${vidPid[2]})`;
          keys.push(withUsb, `Default - ${withUsb}`, `Communications - ${withUsb}`);
        }

        for (const k of keys) this._altNameCache.set(k, d.alternativeName);
        cached++;
      }
      console.log(`[StreamEngine] preflightDeviceDetection: cached ${cached} webcam alt name(s) from ${devices.length} device(s)`);
      return { devices, cachedCount: cached };
    } catch (err) {
      console.warn('[StreamEngine] preflightDeviceDetection failed:', err.message);
      return { devices: [], cachedCount: 0 };
    }
  }

  async _videoInputArgs(settings, fps) {
    const source = settings.videoSource || 'screen';
    this._diag(`videoSource: ${source}`);

    switch (source) {
      case 'webcam':
        return this._buildWebcamInput(settings, fps);
      case 'media':
        return this._buildMediaFileInput(settings, fps);
      case 'video_url':
        return this._buildVideoUrlInput(settings, fps);
      case 'image':
        return this._buildImageFileInput(settings, fps);
      case 'image_url':
        return this._buildImageUrlInput(settings, fps);
      case 'slideshow':
        return this._buildSlideshowInput(settings, fps);
      case 'screen':
      default:
        this._diag('→ SCREEN (gdigrab)');
        console.log(`[StreamEngine] Video routing: videoSource=${source} -> SCREEN (gdigrab)`);
        return [
          '-f', 'gdigrab',
          '-framerate', String(fps),
          '-i', 'desktop',
        ];
    }
  }

  async _buildWebcamInput(settings, fps) {
    const webcamName = settings.webcamDevice;
    const webcamConfigured = webcamName && String(webcamName).trim() !== '';
    this._diag(`webcamDevice requested: ${webcamConfigured ? JSON.stringify(webcamName) : '(empty)'}`);
    console.log(`[StreamEngine] Video routing: videoSource=webcam, webcamDevice=${webcamConfigured ? JSON.stringify(webcamName) : 'EMPTY'} -> ${webcamConfigured ? 'WEBCAM (dshow)' : 'SCREEN fallback'}`);

    if (!webcamConfigured) {
      // Pre-flight in startStream already throws WEBCAM_DEVICE_MISSING
      // before we get here, but defense-in-depth: fall back to screen
      // rather than letting FFmpeg try to open a nameless dshow device.
      this._diag('→ SCREEN (gdigrab fallback — webcam not configured)');
      return ['-f', 'gdigrab', '-framerate', String(fps), '-i', 'desktop'];
    }

    const deviceName = await this._resolveDshowVideoName(webcamName);
    this._diag(`final -i video=<arg>: ${JSON.stringify(deviceName)}`);
    return [
      '-f', 'dshow',
      // Some webcams publish MJPEG at the highest FPS and YUY2 at a
      // lower one. rtbufsize avoids 'real-time buffer too full' warnings
      // for cameras that emit frames in bursts during autofocus hunt.
      '-rtbufsize', '256M',
      '-framerate', String(fps),
      '-i', `video=${deviceName}`,
    ];
  }

  // Media source = a local video/audio file played back by FFmpeg.
  // `-re` reads at native frame rate (otherwise FFmpeg would stream the
  // whole file as fast as possible, burning through a 2-hour movie in
  // ~30s). `-stream_loop -1` reloops indefinitely so a 3-minute clip
  // doesn't end the stream after 3 minutes.
  // ─── Simulcast / Output Resolution ───────────────────────
  //
  // Feature: stream to multiple platforms simultaneously via FFmpeg's
  // Resolve the list of streaming destinations. Semantics (v3.3.26+):
  //
  //   • settings.streamUrl + settings.streamKey  →  primary destination
  //     (position 0; omitted only if either field is blank)
  //   • settings.destinations[] with enabled+url+key entries  →
  //     additional simulcast targets appended after the primary
  //
  // Rationale for this layout: the existing Stream URL / Stream Key
  // fields in RightPanel map directly to "the primary destination",
  // which matches what every user already has configured. Additional
  // destinations are purely additive — adding a second destination
  // doesn't require moving the primary into a list.
  //
  // Returns normalized [{ name, url, key, fullUrl }] for consumption
  // by _buildOutputArgs. Throws STREAM_CONFIG_MISSING if the final
  // list is empty.
  _resolveDestinations(settings) {
    const normalize = (d) => {
      // Trim whitespace defensively. Settings UI should already do this
      // but bad data from a copy-paste can slip through and FFmpeg's
      // RTMP muxer rejects 'rtmp://server/path ' (trailing space) with
      // "Error opening output files: Invalid argument" that's hard to
      // diagnose from the error alone.
      const base = String(d.url || '').trim().replace(/\/+$/, '');
      const key = String(d.key || '').trim();
      return {
        name: d.name || d.platform || 'Destination',
        url: base,
        key,
        fullUrl: key ? `${base}/${key}` : base,
      };
    };

    // Human-facing validation. These run AFTER normalize(), on the
    // already-trimmed values. Each check has a specific message naming
    // the exact field the user needs to fix — far more actionable than
    // FFmpeg's "Invalid argument" which is what we got before this
    // validation existed. Catches the most common copy-paste mistakes:
    //
    //   • Empty URL or key
    //   • URL missing protocol (user pasted 'live.mmcdn.com/live-origin')
    //   • Wrong protocol (https://, http://, srt:// — none work for
    //     cam platforms that require RTMP)
    //   • Stream key pasted into URL field (common when copying the
    //     combined URL from some platforms)
    //   • URL pasted into stream key field (less common but does happen)
    //
    // The thrown error bubbles up to the renderer alert dialog.
    const validate = (d, idx) => {
      const label = idx === 0 ? 'Stream URL / Stream Key' : `destination "${d.name}"`;

      if (!d.url) {
        const err = new Error(`Stream URL is empty for ${label}. Open Settings > Streaming and either click a preset (Chaturbate, Stripchat, etc.) or paste your RTMP URL.`);
        err.code = 'STREAM_CONFIG_INVALID_URL';
        throw err;
      }
      if (!d.key) {
        const err = new Error(`Stream Key is empty for ${label}. Open Settings > Streaming and paste your stream key from your platform's broadcaster page.`);
        err.code = 'STREAM_CONFIG_INVALID_KEY';
        throw err;
      }

      // Protocol check. rtmp:// or rtmps:// only. Case-insensitive.
      if (!/^rtmps?:\/\//i.test(d.url)) {
        // Special case: if the URL looks like a bare stream key (short,
        // alphanumeric, no dots), the user probably pasted the key into
        // the URL field.
        const looksLikeKey = /^[A-Za-z0-9_\-]{10,64}$/.test(d.url);
        const msg = looksLikeKey
          ? `The Stream URL field looks like a stream key, not a URL. Open Settings > Streaming and make sure the Stream URL starts with rtmp:// (for example, rtmp://global.live.mmcdn.com/live-origin for Chaturbate). The stream key goes in the Stream Key field.`
          : `Stream URL must start with rtmp:// or rtmps://. Current value: "${d.url}". Open Settings > Streaming and either click a preset or fix the URL.`;
        const err = new Error(msg);
        err.code = 'STREAM_CONFIG_INVALID_URL_PROTOCOL';
        throw err;
      }

      // Key should NOT start with a protocol. If it does, user probably
      // pasted the URL into the key field.
      if (/^rtmps?:\/\//i.test(d.key)) {
        const err = new Error(`The Stream Key field looks like an RTMP URL, not a key. Open Settings > Streaming and make sure the Stream Key field contains ONLY the key (a short alphanumeric string from your broadcaster page), not the full URL.`);
        err.code = 'STREAM_CONFIG_KEY_IS_URL';
        throw err;
      }

      // Whitespace in the middle of a key is almost certainly a paste
      // error. Keys are always a single token.
      if (/\s/.test(d.key)) {
        const err = new Error(`The Stream Key contains whitespace, which is always a copy-paste error — stream keys are single tokens with no spaces. Open Settings > Streaming and re-copy the key directly from your platform.`);
        err.code = 'STREAM_CONFIG_KEY_HAS_WHITESPACE';
        throw err;
      }
    };

    const resolved = [];

    // Primary destination from the top-level streamUrl/streamKey
    // fields. Both must be set — blank key means the user hasn't
    // configured their stream yet and we fall through to destinations[]
    // or throw below.
    if (settings.streamUrl && settings.streamKey) {
      resolved.push({
        name: settings.streamName || 'Primary',
        url: settings.streamUrl,
        key: settings.streamKey,
      });
    }

    // Additional destinations. Filter to enabled entries with both
    // url and key set so empty/disabled rows in the UI don't attempt
    // to connect.
    if (Array.isArray(settings.destinations)) {
      for (const d of settings.destinations) {
        if (d && d.enabled !== false && d.url && d.key) {
          resolved.push(d);
        }
      }
    }

    if (resolved.length === 0) {
      const err = new Error('No stream destination configured. Enter a Stream URL and Stream Key in the Output section, or add a destination in Additional Destinations.');
      err.code = 'STREAM_CONFIG_MISSING';
      throw err;
    }

    const normalized = resolved.map(normalize);
    normalized.forEach(validate);
    return normalized;
  }

  // Build the FFmpeg output args for 1 or N destinations.
  //
  // Single destination: -f flv <url>  (simpler, same as pre-simulcast)
  // Multi-destination:  -flags +global_header -f tee "[opts]url1|[opts]url2|..."
  //
  // tee-muxer specifics:
  //   • f=flv     — each output is FLV/RTMP (required by all cam sites)
  //   • onfail=ignore — if one destination fails (bad key, network cut,
  //                      platform kicks us), the others keep going. Without
  //                      this, any single failure would kill the whole stream.
  //   • +global_header — required so codec extradata sits at the top of
  //                      the stream rather than inline-per-packet; each
  //                      output muxer needs to read it.
  //   • URL escaping — tee uses '|' as output separator and ':' inside
  //                    option blocks. URLs containing these need
  //                    backslash-escaping. Cam-site ingest URLs in
  //                    practice don't use '|' but we escape defensively.
  _buildOutputArgs(destinations) {
    if (destinations.length === 1) {
      return [
        '-f', 'flv',
        '-flvflags', 'no_duration_filesize',
        destinations[0].fullUrl,
      ];
    }
    const escapeForTee = (s) => String(s)
      .replace(/\\/g, '\\\\')
      .replace(/\|/g, '\\|')
      .replace(/\[/g, '\\[')
      .replace(/\]/g, '\\]');
    const teeSpec = destinations
      .map((d) => `[f=flv:onfail=ignore:flvflags=no_duration_filesize]${escapeForTee(d.fullUrl)}`)
      .join('|');
    return [
      '-flags', '+global_header',
      '-f', 'tee',
      teeSpec,
    ];
  }

  _buildMediaFileInput(settings, fps) {
    const p = settings.mediaPath;
    if (!p || !String(p).trim()) {
      const err = new Error('Video File source is selected but no file path is configured. Open the Sources panel and edit the Video File source to set a path.');
      err.code = 'MEDIA_PATH_MISSING';
      throw err;
    }
    if (!fs.existsSync(p)) {
      const err = new Error(`Video file not found: ${p}. Open the Sources panel and update the path, or re-add the source pointing to the current file location.`);
      err.code = 'MEDIA_PATH_NOT_FOUND';
      throw err;
    }
    this._diag(`media file path: ${JSON.stringify(p)}`);
    this._diag(`→ MEDIA FILE (native-rate loop)`);
    console.log(`[StreamEngine] Video routing: videoSource=media, path=${p}`);
    return ['-re', '-stream_loop', '-1', '-i', p];
  }

  // Video URL = a remote video played back by FFmpeg. MP4, WebM, or HLS
  // (.m3u8). FFmpeg's protocol handlers cover http(s), rtsp, rtmp, hls.
  // No stream_loop on URLs — for HLS the server controls the loop, and
  // for finite MP4 over http stream_loop is unreliable (FFmpeg would have
  // to re-open the connection each loop which some CDNs treat as abuse).
  _buildVideoUrlInput(settings, fps) {
    const url = settings.videoUrl;
    if (!url || !String(url).trim()) {
      const err = new Error('Video URL source is selected but no URL is configured. Open the Sources panel and edit the Video URL source to set a URL.');
      err.code = 'VIDEO_URL_MISSING';
      throw err;
    }
    if (!/^https?:\/\//i.test(url) && !/^rtmps?:\/\//i.test(url)) {
      const err = new Error(`Video URL must start with http://, https://, or rtmp(s)://. Got: ${url.slice(0, 60)}`);
      err.code = 'VIDEO_URL_INVALID';
      throw err;
    }
    this._diag(`video URL: ${JSON.stringify(url)}`);
    this._diag(`→ VIDEO URL (native-rate remote)`);
    console.log(`[StreamEngine] Video routing: videoSource=video_url, url=${url}`);
    return ['-re', '-i', url];
  }

  // Image source = a local static image displayed as video. `-loop 1`
  // keeps the single-frame decoder feeding the encoder forever. We set
  // `-framerate` on the input so FFmpeg generates N copies per second
  // of that one image, producing a valid CBR video stream. Without
  // these flags the image would decode once and FFmpeg would exit.
  _buildImageFileInput(settings, fps) {
    const p = settings.imagePath;
    if (!p || !String(p).trim()) {
      const err = new Error('Image source is selected but no file path is configured. Open the Sources panel and edit the Image source to set a path.');
      err.code = 'IMAGE_PATH_MISSING';
      throw err;
    }
    if (!fs.existsSync(p)) {
      const err = new Error(`Image file not found: ${p}. Open the Sources panel and update the path.`);
      err.code = 'IMAGE_PATH_NOT_FOUND';
      throw err;
    }
    this._diag(`image file path: ${JSON.stringify(p)}`);
    this._diag(`→ IMAGE FILE (loop)`);
    console.log(`[StreamEngine] Video routing: videoSource=image, path=${p}`);
    return ['-loop', '1', '-framerate', String(fps), '-i', p];
  }

  // Image URL = remote static image. Same `-loop 1` semantics as local
  // images. FFmpeg's image demuxer auto-detects format from magic bytes
  // even over http, so we don't need to pre-declare -f image2.
  _buildImageUrlInput(settings, fps) {
    const url = settings.imageUrl;
    if (!url || !String(url).trim()) {
      const err = new Error('Image URL source is selected but no URL is configured.');
      err.code = 'IMAGE_URL_MISSING';
      throw err;
    }
    if (!/^https?:\/\//i.test(url)) {
      const err = new Error(`Image URL must start with http:// or https://. Got: ${url.slice(0, 60)}`);
      err.code = 'IMAGE_URL_INVALID';
      throw err;
    }
    this._diag(`image URL: ${JSON.stringify(url)}`);
    this._diag(`→ IMAGE URL (loop remote)`);
    console.log(`[StreamEngine] Video routing: videoSource=image_url, url=${url}`);
    return ['-loop', '1', '-framerate', String(fps), '-i', url];
  }

  // Slideshow = a folder of images rotated every N seconds. Implemented
  // via FFmpeg's concat demuxer. We write a temporary playlist file
  // listing each image with `duration` lines; `-stream_loop -1` cycles
  // the playlist indefinitely so the slideshow doesn't end.
  //
  // The concat demuxer has a well-known quirk: the LAST entry's duration
  // is ignored unless that entry is duplicated as a trailing `file` line
  // (without a duration). We handle that below.
  _buildSlideshowInput(settings, fps) {
    const folder = settings.slideshowFolder;
    const interval = Math.max(1, parseInt(settings.slideshowInterval || 5, 10));
    if (!folder || !String(folder).trim()) {
      const err = new Error('Slideshow source is selected but no folder path is configured.');
      err.code = 'SLIDESHOW_FOLDER_MISSING';
      throw err;
    }
    if (!fs.existsSync(folder)) {
      const err = new Error(`Slideshow folder not found: ${folder}`);
      err.code = 'SLIDESHOW_FOLDER_NOT_FOUND';
      throw err;
    }
    const imageExts = /\.(png|jpg|jpeg|webp|gif|bmp)$/i;
    const images = fs.readdirSync(folder)
      .filter((name) => imageExts.test(name))
      .sort()
      .map((name) => path.join(folder, name));
    if (images.length === 0) {
      const err = new Error(`Slideshow folder has no images: ${folder}. Supported: PNG, JPG, WebP, GIF, BMP.`);
      err.code = 'SLIDESHOW_FOLDER_EMPTY';
      throw err;
    }

    // Write playlist to userData/tmp/slideshow-<timestamp>.txt. Using a
    // timestamped name instead of a fixed one avoids collisions if the
    // user restarts streaming quickly — a stale FFmpeg child might
    // still hold the old file. The concat demuxer needs absolute paths
    // in `file` directives when -safe 0 is set (it is, for Windows path
    // compatibility).
    const userData = app && typeof app.getPath === 'function' ? app.getPath('userData') : '.';
    const tmpDir = path.join(userData, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const playlistPath = path.join(tmpDir, `slideshow-${Date.now()}.txt`);
    const lines = [];
    for (const img of images) {
      // Escape single quotes for concat demuxer. FFmpeg concat uses
      // single-quoted paths; an apostrophe in a filename would break
      // parsing. Per concat demuxer docs: escape ' as '\''.
      const escaped = img.replace(/'/g, `'\\''`);
      lines.push(`file '${escaped}'`);
      lines.push(`duration ${interval}`);
    }
    // Trailing duplicate of the last file. Without this the last image
    // flashes by in ~40ms because concat ignores the final `duration`.
    const last = images[images.length - 1].replace(/'/g, `'\\''`);
    lines.push(`file '${last}'`);
    fs.writeFileSync(playlistPath, lines.join('\n'), 'utf8');

    // Stash for cleanup on stream end. _cleanupTempFiles called from
    // the streamProcess 'close' handler below.
    if (!this._tempFiles) this._tempFiles = [];
    this._tempFiles.push(playlistPath);

    this._diag(`slideshow folder: ${JSON.stringify(folder)}`);
    this._diag(`slideshow image count: ${images.length} @ ${interval}s each`);
    this._diag(`slideshow playlist: ${JSON.stringify(playlistPath)}`);
    this._diag(`→ SLIDESHOW (concat + stream_loop)`);
    console.log(`[StreamEngine] Video routing: videoSource=slideshow, folder=${folder}, images=${images.length}`);
    return [
      '-stream_loop', '-1',
      '-f', 'concat',
      '-safe', '0',
      '-i', playlistPath,
      // Framerate filter comes from -vf scale on the encode side; here
      // we just need a sane input framerate for the concat demuxer.
      '-framerate', '1',
    ];
  }

  // Remove any temp files stashed during stream/record setup. Called
  // from the process 'close' handler so files don't accumulate in
  // userData/tmp across sessions.
  _cleanupTempFiles() {
    if (!this._tempFiles || this._tempFiles.length === 0) return;
    for (const f of this._tempFiles) {
      try { fs.unlinkSync(f); } catch {}
    }
    this._tempFiles = [];
  }

  // Push a diagnostic line to the per-stream routing diag. No-op if
  // _routingDiag hasn't been initialized (called outside of a stream
  // attempt).
  _diag(line) {
    if (this._routingDiag) this._routingDiag.push(line);
  }

  // Enumerate DirectShow video input devices (webcams, capture cards,
  // virtual cameras). Runs FFmpeg with `-list_devices true -f dshow`
  // against a dummy input — FFmpeg dumps the device list to stderr and
  // exits non-zero; we parse out video device names.
  //
  // Output shape: [{ name, alternativeName }, ...]
  async detectWebcams() {
    return new Promise((resolve) => {
      const proc = spawn(this.ffmpegPath, [
        '-hide_banner',
        '-list_devices', 'true',
        '-f', 'dshow',
        '-i', 'dummy',
      ], { windowsHide: true });

      let stderr = '';
      proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

      // FFmpeg always exits non-zero on the dummy input — ignore that,
      // we only care about the device list it printed along the way.
      const finish = () => {
        const parsed = this._parseDshowDeviceList(stderr);
        // If parsing came up empty, stash the raw stderr so the routing
        // diagnostics can dump it. Parser failures are usually format
        // drift in FFmpeg output — seeing the raw bytes makes the fix
        // obvious.
        if (parsed.length === 0) {
          this._lastDetectStderr = stderr;
        }
        resolve(parsed);
      };
      proc.on('close', finish);
      proc.on('error', () => resolve([]));

      // Safety timeout — some DirectShow drivers can hang briefly when
      // probed. Five seconds is well over the typical ~200ms response.
      setTimeout(() => {
        try { proc.kill(); } catch {}
      }, 5000);
    });
  }

  // Parse FFmpeg's dshow device-enumeration stderr. Returns only VIDEO
  // devices as [{ name, alternativeName }, ...].
  //
  // Output format evolution:
  //
  // OLDER FFmpeg (pre-2020ish) emitted section headers and relied on
  // position to classify devices:
  //
  //   [dshow @ 0x0] DirectShow video devices
  //   [dshow @ 0x0]  "HP TrueVision HD Camera (04f2:b75e)"
  //   [dshow @ 0x0]     Alternative name "@device_pnp_..."
  //   [dshow @ 0x0] DirectShow audio devices
  //   [dshow @ 0x0]  "Microphone Array (...)"
  //
  // MODERN FFmpeg (2020+ including Ridge's N-123960 build) dropped the
  // section headers in favor of a per-line suffix:
  //
  //   [dshow @ 0x0]  "HP TrueVision HD Camera (04f2:b75e)" (video)
  //   [dshow @ 0x0]     Alternative name "@device_pnp_..."
  //   [dshow @ 0x0]  "Microphone Array (...)" (audio)
  //
  // The old parser gated every line on inVideoSection, which was set by
  // the now-removed "DirectShow video devices" header. With that header
  // gone on modern FFmpeg, inVideoSection stayed false, every device
  // line was skipped, and the parser returned []. That's what Ridge's
  // v3.3.16 stream log showed: "detectWebcams returned 0 device(s)".
  //
  // New approach: classify each device line by its (video)/(audio)
  // suffix first. If absent (older FFmpeg), fall back to the section
  // header state. Works for both formats.
  _parseDshowDeviceList(stderr) {
    const lines = stderr.split('\n');
    const videos = [];
    let sectionIsVideo = null; // null until a header is seen (older format)
    let lastDeviceIndex = -1;
    let lastWasVideo = false;

    for (const line of lines) {
      // Older-format section headers. Harmless in modern format since
      // they just never match.
      if (/DirectShow video devices/i.test(line)) {
        sectionIsVideo = true;
        continue;
      }
      if (/DirectShow audio devices/i.test(line)) {
        sectionIsVideo = false;
        continue;
      }

      const quoted = line.match(/"([^"]+)"/);
      if (!quoted) continue;

      const isAltName = /Alternative name/i.test(line);

      if (isAltName) {
        // Alt name lines always follow their primary device. Only attach
        // if the most recent primary was a video device we pushed.
        if (lastWasVideo && lastDeviceIndex >= 0) {
          videos[lastDeviceIndex].alternativeName = quoted[1];
        }
        continue;
      }

      // Primary device line. Classify by suffix first, then section.
      const suffixVideo = /\(video\)\s*$/i.test(line);
      const suffixAudio = /\(audio\)\s*$/i.test(line);

      let isVideo;
      if (suffixVideo) isVideo = true;
      else if (suffixAudio) isVideo = false;
      else if (sectionIsVideo === true) isVideo = true;
      else if (sectionIsVideo === false) isVideo = false;
      else continue; // no suffix, no section header — can't classify, skip

      if (isVideo) {
        videos.push({ name: quoted[1], alternativeName: null });
        lastDeviceIndex = videos.length - 1;
        lastWasVideo = true;
      } else {
        lastWasVideo = false;
      }
    }
    return videos;
  }

  // ─── RTMP Streaming ───────────────────────────────────
  async startStream(settings) {
    if (this.streamProcess) throw new Error('Stream already running');

    // Reset per-stream routing diagnostics. Populated by _videoInputArgs,
    // _resolveDshowVideoName, and detectWebcams as they run, then
    // included in the stream log written on exit. This gives us hard
    // data on which code path fired and why for any reported issue.
    this._routingDiag = [];

    // Pre-flight: verify FFmpeg is actually available. Without this, we'd
    // fall back to spawning the bare string 'ffmpeg' and hope Windows
    // resolves it via PATH. When PATH doesn't have it either, FFmpeg
    // either fails to spawn (confusing ENOENT) or — worse — some broken
    // partial install spawns and produces misleading errors like
    // "Error opening output files: Invalid argument".
    const resolvedPath = findFFmpegPath();
    if (!resolvedPath) {
      const err = new Error('FFmpeg is not installed. Open Settings → Streaming and click "Install FFmpeg", or install it to your system PATH.');
      err.code = 'FFMPEG_NOT_INSTALLED';
      throw err;
    }
    this.ffmpegPath = resolvedPath; // refresh in case it was just installed this session

    // v3.3.13: explicit guard against the silent screen-capture fallback.
    // If the user intended to stream from a webcam (videoSource === 'webcam')
    // but the stored device name is empty, we'd otherwise fall through to
    // the gdigrab screen path in _videoInputArgs, producing a successful
    // stream of the wrong content (user sees "screensharing when I
    // designated the webcam"). Throw a loud error instead so the UI can
    // show a toast explaining what's wrong.
    if (settings.videoSource === 'webcam') {
      const dev = settings.webcamDevice;
      if (!dev || String(dev).trim() === '') {
        const err = new Error(
          'Webcam source is selected but no device name is configured. ' +
          'Open the Sources panel on the left, edit the Webcam source ' +
          '(or delete and re-add it), and pick a specific camera from ' +
          'the dropdown. If the dropdown is empty, click Refresh.'
        );
        err.code = 'WEBCAM_DEVICE_MISSING';
        throw err;
      }
    }

    const {
      videoBitrate, audioBitrate, fps,
    } = settings;
    // Non-const so _sanitizeResolution can coerce a stale non-16:9
    // stored value (e.g. 1728x1080 from the pre-v3.4.41 autoconfig bug)
    // to the nearest cam-platform standard before we hand it to FFmpeg.
    let resolution = this._sanitizeResolution(settings.resolution);

    // Resolve H.264 encoder: honor the user's choice from obsSettings
    // when it's actually usable on this machine, otherwise auto-pick a
    // working fallback. _detectH264Encoder now runtime-probes each
    // candidate to avoid returning encoders that are compiled-in but
    // can't open (e.g. h264_nvenc on a machine without nvcuda.dll).
    const encoder = this._detectH264Encoder(settings.videoEncoder);

    // If the resolved encoder differs from the user's saved choice, emit
    // a notice so main.js can persist the correction to the store and the
    // renderer can toast the user about what changed.
    if (settings.videoEncoder && encoder !== settings.videoEncoder) {
      this.emit('encoder-auto-changed', {
        requested: settings.videoEncoder,
        resolved: encoder,
        reason: `"${settings.videoEncoder}" is not usable on this machine. Falling back to "${encoder}".`,
      });
    }

    // Resolve destinations (single or simulcast) — supersedes the
    // legacy streamUrl/streamKey pair. Throws STREAM_CONFIG_MISSING
    // if nothing is configured.
    const destinations = this._resolveDestinations(settings);
    const outputArgs = this._buildOutputArgs(destinations);

    // Collect stderr for error reporting — last 3KB is enough
    let stderrBuf = '';

    // Pre-resolve video input args. Async because webcam names with
    // colons need an alt-name lookup via detectWebcams.
    const videoInputArgs = await this._videoInputArgs(settings, fps);

    // Explicit -map is required whenever there are two inputs (video +
    // mic/silent); otherwise FFmpeg's default stream selection picks
    // audio from the wrong input — e.g. anullsrc/mic instead of the
    // video file's embedded track for media / video_url sources.
    const { extraAudioInputs, mapArgs } = await this._resolveStreamMapsAndExtraAudioInputs(settings);

    // Build FFmpeg args for RTMP streaming
    const args = [
      ...videoInputArgs,
      ...extraAudioInputs,
      ...mapArgs,

      // Video encoding with auto-detected encoder + per-encoder args
      ...this._videoEncodeArgs(encoder, videoBitrate, fps, resolution),

      // Audio encoding
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-ar', '44100',

      // Output — single -f flv, or -f tee with pipe-separated outputs
      // when simulcasting to multiple destinations.
      ...outputArgs,
    ];

    // Log what we're streaming to, redacting keys per destination
    if (destinations.length === 1) {
      console.log('[StreamEngine] Starting stream to:', `${destinations[0].url}/<REDACTED>`);
    } else {
      console.log(`[StreamEngine] Starting SIMULCAST to ${destinations.length} destinations:`);
      destinations.forEach((d, i) => {
        console.log(`  [${i}] ${d.name}: ${d.url}/<REDACTED>`);
      });
    }
    console.log('[StreamEngine] FFmpeg path:', this.ffmpegPath);
    console.log('[StreamEngine] Args:', args.join(' '));

    this.streamProcess = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.status.streaming = true;
    this.status.streamUptime = 0;
    this.status.errorReason = null;

    // Open a broadcast-ledger session so usage accounting captures this
    // stream. The returned id is held on the stream-engine instance and
    // passed to recordStop() on any exit path (user stop, error, crash).
    // Ledger is additions-only — nothing here enforces a quota.
    try {
      const ledger = require('./broadcast-ledger');
      this._broadcastSessionId = ledger.recordStart(settings?.platform || 'unknown');
    } catch (e) {
      // Ledger errors must never block a stream from starting.
      this._broadcastSessionId = null;
    }

    this._uptimeInterval = setInterval(() => {
      this.status.streamUptime++;
      this._parseFFmpegStats();
      this.emit('status', { ...this.status });
    }, 1000);

    this.streamProcess.stderr.on('data', (data) => {
      const text = data.toString();
      stderrBuf = (stderrBuf + text).slice(-8000); // keep last 8KB (was 3KB — not enough for real diagnostics)
      this._handleFFmpegOutput(text);
    });

    this.streamProcess.on('close', (code) => {
      this.status.streaming = false;
      if (this._uptimeInterval) clearInterval(this._uptimeInterval);

      // Close the broadcast-ledger session if it wasn't already closed
      // by stopStream(). recordStop is idempotent — if stopStream
      // already finalized this session id, the ledger returns the
      // already-closed record untouched. Analytics-only; see note in
      // stopStream().
      if (this._broadcastSessionId) {
        try {
          const ledger = require('./broadcast-ledger');
          const exitReason = (code !== 0 && code !== null) ? 'error' : 'user_stop';
          ledger.recordStop(this._broadcastSessionId, exitReason);
        } catch (e) {
          // Ledger errors must never mask the underlying FFmpeg error.
        }
        this._broadcastSessionId = null;
      }

      // Extract meaningful error from stderr when FFmpeg exits unexpectedly
      let errorReason = null;
      let logPath = null;
      if (code !== 0 && code !== null && stderrBuf) {
        // Pull the most informative error line from FFmpeg stderr.
        // The helper skips generic boilerplate like "Conversion failed!"
        // and digs for the specific error that caused the run to fail.
        const errorLine = this._extractErrorLine(stderrBuf);
        errorReason = errorLine || `FFmpeg exited with code ${code}`;

        // Detect the specific "EINVAL masquerading as output error" pattern
        // and surface a more actionable hint to the renderer.
        const hint = this._diagnosticHint(stderrBuf);
        if (hint) errorReason = `${errorReason}\n\n${hint}`;

        // Write full log to disk so the user can share it when reporting
        logPath = this._writeStreamLog({
          mode: 'stream',
          args,
          // Pass ALL destinations so _writeStreamLog redacts every
          // stream key that could appear in stderr (simulcasting
          // surfaces multiple per-destination errors).
          destinations,
          exitCode: code,
          stderr: stderrBuf,
          errorLine,
        });
        if (logPath) errorReason = `${errorReason}\n\nFull log: ${logPath}`;

        console.error('[StreamEngine] Stream stopped unexpectedly:', errorReason);
        console.error('[StreamEngine] Full stderr tail:\n', stderrBuf.slice(-2000));
      }

      this.status.errorReason = errorReason;
      this.status.errorLogPath = logPath;
      this.emit('status', { ...this.status });
      this.streamProcess = null;
      this._cleanupTempFiles();
    });

    this.streamProcess.on('error', (err) => {
      console.error('[StreamEngine] Spawn error:', err);
      this.status.streaming = false;
      this.status.errorReason = err.message;

      // Close the broadcast-ledger session on spawn failure. Duration
      // will be near-zero in this case, which is the correct accounting:
      // the stream never really ran.
      if (this._broadcastSessionId) {
        try {
          const ledger = require('./broadcast-ledger');
          ledger.recordStop(this._broadcastSessionId, 'crash');
        } catch (e) {
          // Ledger errors are not the user's problem.
        }
        this._broadcastSessionId = null;
      }

      this.emit('status', { ...this.status });
      this.streamProcess = null;
      this._cleanupTempFiles();
    });

    this.emit('status', { ...this.status });
    return true;
  }

  // Coerce an arbitrary stored resolution to the nearest 16:9 cam-platform
  // standard (1920x1080, 1280x720, 854x480, 640x360). Cam RTMP ingests
  // (Chaturbate, Stripchat, MyFreeCams, xTease) reject non-standard
  // dimensions in practice — a stream at 1728x1080 connects, accepts
  // a few seconds of packets, then gets dropped with -10053. The
  // v3.4.39–40 stream-pipe logs showed exactly this chain.
  //
  // Where bad stored values came from: autoconfig.recommendResolution()
  // before v3.4.41 multiplied display DIP by scaleFactor, then snapped
  // the result to "common even dimensions" without enforcing a 16:9
  // aspect. On a 1920x1200 laptop (16:10, common on HP/Dell/Lenovo
  // business-class machines), that produced 1728x1080 — mathematically
  // correct for preserving 16:10 inside a 1080p height ceiling, but
  // not a resolution any cam platform ingests cleanly.
  //
  // Strategy: if the stored resolution is already on the whitelist,
  // return it unchanged. Otherwise, pick the closest-HEIGHT whitelisted
  // entry and log a one-time diag explaining the substitution. Height
  // is the right dimension to match on because the webcam is always
  // 16:9 regardless of display aspect — only the stream output was
  // ever miscomputed.
  //
  // Returns a plain { width, height } object. Never throws. Falls back
  // to 1920x1080 on any unexpected input shape.
  _sanitizeResolution(res) {
    const fallback = { width: 1920, height: 1080 };
    if (!res || typeof res !== 'object') return fallback;
    const w = Number(res.width);
    const h = Number(res.height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
      return fallback;
    }

    // Exact-match fast path — already on whitelist, pass through.
    for (const r of STREAM_RESOLUTIONS_16_9) {
      if (r.width === w && r.height === h) return { width: w, height: h };
    }

    // Not on whitelist — pick closest by height. Prefer ≤ the user's
    // stored height so we don't upscale a user who set 480p to 1080p.
    let best = STREAM_RESOLUTIONS_16_9[STREAM_RESOLUTIONS_16_9.length - 1];
    for (const r of STREAM_RESOLUTIONS_16_9) {
      if (r.height <= h) { best = r; break; }
    }

    this._diag(`resolution sanitized: ${w}x${h} is not a cam-platform-standard 16:9 size, using ${best.width}x${best.height} instead`);
    console.warn(`[StreamEngine] Non-standard resolution ${w}x${h} coerced to ${best.width}x${best.height}`);
    return { width: best.width, height: best.height };
  }

  // Correlate FFmpeg stderr errors with renderer-side telemetry to
  // distinguish "source starved the encoder" from "platform kicked for
  // bitrate cap" when both surface as the same -10053 socket abort.
  //
  // Reads the ErrorLogger ring buffer for the last 15 seconds and
  // extracts two signals:
  //
  //   1. beauty-filter "Render loop slow" warnings — these carry a
  //      structured context with fps, avgFrameMs, rafGap, verdict.
  //      fps < 25 in the last 5s window means the WebGL compositor
  //      was producing frames slower than 30fps capture target, so
  //      MediaRecorder had very little to encode.
  //
  //   2. media-recorder "MediaRecorder output" breadcrumbs — these
  //      carry effBitrate in kbps. When effBitrate < 50% of the
  //      configured target, MediaRecorder was effectively idle (the
  //      source pipeline starved it). The stream-pipe logs leading
  //      to the v3.4.39 -10053 showed 161 kbps against a 3000 kbps
  //      target — a 20× shortfall, unmistakable starvation.
  //
  // Returns:
  //   { starving: true,  reason: "<human string>" }
  //     when EITHER signal crosses threshold
  //   { starving: false, healthyBitrate: true }
  //     when effBitrate reached ≥80% of target and fps was ≥25 —
  //     stream was running normally before the abort
  //   { starving: false, healthyBitrate: false }
  //     when there's no telemetry either way (stream barely ran, or
  //     logger was disabled)
  _detectFrameStarvation() {
    let fpsEntry = null;
    let mrEntry  = null;
    try {
      const fpsMatches = errorLogger.findRecent('beauty-filter', /Render loop/, 15000);
      if (fpsMatches.length) fpsEntry = fpsMatches[fpsMatches.length - 1];
      const mrMatches  = errorLogger.findRecent('media-recorder', /MediaRecorder output/, 15000);
      if (mrMatches.length)  mrEntry  = mrMatches[mrMatches.length - 1];
    } catch (err) {
      // Logger query failed — fall through to "no telemetry" result.
      console.warn('[StreamEngine] Telemetry query failed:', err.message);
    }

    const fps       = fpsEntry?.context?.fps;
    const verdict   = fpsEntry?.context?.verdict;
    const effKbps   = mrEntry?.context?.effBitrateKbps;
    // The target bitrate is the value the renderer asked MediaRecorder
    // to produce (in kbps). Surfaced in the 'starting' log entry but
    // not the 'output' one; infer it from the most recent starting
    // log, falling back to 3000 (the app's default at the time of
    // writing — any mismatch just loosens the starvation threshold).
    let targetKbps = 3000;
    try {
      const startMatches = errorLogger.findRecent('media-recorder', /MediaRecorder starting/, 30000);
      const last = startMatches[startMatches.length - 1];
      const vbps = last?.context?.videoBitsPerSecond;
      if (Number.isFinite(vbps) && vbps > 0) targetKbps = Math.round(vbps / 1000);
    } catch {}

    const fpsStarving = Number.isFinite(fps) && fps < 25;
    const bitrateStarving = Number.isFinite(effKbps) && effKbps < targetKbps * 0.5;

    if (fpsStarving || bitrateStarving) {
      const bits = [];
      if (fpsStarving) {
        bits.push(`the filter was rendering at ${fps.toFixed(1)} fps${verdict ? ` (${verdict})` : ''} instead of 30`);
      }
      if (bitrateStarving) {
        bits.push(`MediaRecorder produced ${effKbps} kbps vs ${targetKbps} kbps target (${Math.round(100 * effKbps / targetKbps)}% of intended bitrate)`);
      }
      return {
        starving: true,
        reason: `The source couldn't keep up: ${bits.join('; ')}.`,
      };
    }

    const fpsHealthy     = Number.isFinite(fps)     && fps >= 25;
    const bitrateHealthy = Number.isFinite(effKbps) && effKbps >= targetKbps * 0.8;
    // Healthy = both signals present and both healthy, OR bitrate healthy
    // and no fps signal (filter might be disabled — no news is good news).
    const healthyBitrate = bitrateHealthy && (fpsHealthy || fps === undefined);

    return { starving: false, healthyBitrate };
  }

  // Extract the most informative error line from FFmpeg stderr.
  //
  // The naive approach — "last line matching /error|failed/i" — picks up
  // boilerplate summary lines like "Conversion failed!" or "Error while
  // filtering" that FFmpeg prints on its way out. The ROOT cause is
  // almost always a more specific line earlier in stderr:
  //
  //   [libx264 @ 0x...] Specified frame rate of 60.000 fps is not
  //     representable in the video codec
  //   Conversion failed!    <-- what the old extractor picked
  //
  // This helper does two passes:
  //
  //   Pass 1: find a specific, informative error line. Must match the
  //           error regex AND NOT be one of the known generic fallbacks.
  //   Pass 2: if nothing specific was found, fall back to any matching
  //           line so we still return something.
  //
  // The result gets trimmed of FFmpeg's bracketed component prefix
  // ([libx264 @ 0x1234]) since that's noise for the user.
  _extractErrorLine(stderr) {
    if (!stderr) return null;
    const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return null;

    // Lines that FFmpeg prints as summary boilerplate on its way out.
    // They match the error regex but don't tell us why the run failed.
    const GENERIC = [
      /^conversion failed!?\s*$/i,
      /^error while filtering/i,
      /^error writing trailer/i,
      /^error closing file/i,
      /^exiting\.+\s*$/i,
      /^received signal/i,
    ];
    const isGeneric = (line) => GENERIC.some((re) => re.test(line));

    const matchesErrorRe = (l) =>
      /error|failed|invalid|refused|not found|cannot|unable|no such/i.test(l);

    // Pass 1: most recent SPECIFIC error line (not in the generic set)
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (matchesErrorRe(l) && !isGeneric(l)) return this._cleanErrorLine(l);
    }
    // Pass 2: fall back to most recent matching line (may be generic)
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (matchesErrorRe(l)) return this._cleanErrorLine(l);
    }
    return null;
  }

  _cleanErrorLine(line) {
    // Strip leading timestamp like "2026-04-19T21:07:45 error:"
    let out = line.replace(/^\d{4}-\d{2}-\d{2}.*?error:/i, '').trim();
    // Strip FFmpeg component prefix like "[libx264 @ 0x55b8f3c2d1a0] "
    out = out.replace(/^\[[^\]]+\]\s*/, '').trim();
    return out;
  }

  // Inspects FFmpeg stderr for known root-cause signatures and returns a
  // human-readable hint. "Invalid argument" on output is usually caused by
  // the INPUT failing — this helper looks for that signature specifically.
  _diagnosticHint(stderr) {
    if (!stderr) return null;
    const s = stderr.toLowerCase();

    // Hardware encoder runtime driver missing. The most common is
    // "Cannot load nvcuda.dll" when NVENC is selected on a machine
    // without NVIDIA drivers — FFmpeg compiled NVENC in, but the user's
    // system doesn't have the NVIDIA runtime DLLs. v3.3.2+ auto-falls
    // back to a working encoder, but preserve this hint for older
    // installs or unusual configs.
    if (/cannot load (nvcuda|nvEncodeAPI|amfrt|libvpl|libmfx)/i.test(stderr) ||
        /failed loading (nvcuda|amf|qsv)/i.test(stderr)) {
      return 'Hint: the selected hardware encoder cannot initialize because its GPU runtime is missing. NVENC needs NVIDIA drivers, AMF needs AMD drivers, QSV needs Intel graphics. Open Settings → OBS and change the encoder to "OpenH264 (Software)" which runs anywhere, or click "⚡ Auto-detect" to let Apex pick a working encoder.';
    }

    // Encoder preset rejection — each H.264 encoder has its own preset
    // vocabulary (x264 uses 'veryfast', NVENC uses 'p1'-'p7', etc.). When
    // _videoEncodeArgs sends the wrong one, FFmpeg fails setup with
    // 'Unable to parse "preset"' + 'Error applying encoder options'.
    if (/unable to parse ["']?preset["']?/i.test(stderr) ||
        /error applying encoder options/i.test(stderr)) {
      return 'Hint: the selected encoder rejected the configured preset. Each H.264 encoder uses its own preset names (x264 → veryfast/fast/medium, NVENC → p1-p7, AMF/MF → no presets). Try a different encoder in Settings > OBS.';
    }

    // Generic encoder open failure when we didn't catch a more specific
    // signature above. Points at the encoder as the likely culprit.
    if (/error while opening encoder/i.test(stderr) ||
        /could not open encoder/i.test(stderr)) {
      return 'Hint: the video encoder failed to initialize. This usually means the hardware encoder picked cannot run on this machine. Change the encoder in Settings > OBS to "OpenH264 (Software)" which works on any system.';
    }

    if (/gdigrab.*?(could not|cannot|failed|error)/i.test(stderr) ||
        /couldn\'?t capture image/i.test(stderr)) {
      return 'Hint: gdigrab (screen capture) failed to initialize. Check that you have an active desktop session (not locked/RDP), and that display scaling is set to 100%.';
    }
    // Webcam-specific dshow failures. Separated from the audio-device
    // branch below because the user intent + recovery differ:
    // video=... errors mean their configured webcam is unavailable,
    // audio=... errors mean their mic is.
    if (/Could not find audio only device with name/i.test(stderr)) {
      return 'Hint: the configured audio device name is not recognized by FFmpeg. This usually means the name has a browser prefix like "Default - " (from the browser device list) that the FFmpeg dshow driver does not know about. v3.3.11+ strips these prefixes automatically — if you are on an older version, re-pick the microphone in Settings > OBS > Audio Device.';
    }
    if (/Malformed dshow input string/i.test(stderr)) {
      return 'Hint: the webcam device name contains a character that confuses FFmpeg\'s dshow parser (usually a colon in the USB vendor:product ID, e.g. "HP TrueVision HD Camera (04f2:b75e)"). Update to v3.3.10+ which escapes these automatically, or pick a different camera name if available.';
    }
    if (/Could not run graph.*?video=|could not find video device|I\/O error|vcap.*?error/i.test(stderr) &&
        /dshow/i.test(stderr)) {
      return 'Hint: the selected webcam could not be opened. Most common cause: another app (your web browser, Zoom, OBS, etc.) has the camera locked. Close other camera users and try again, or pick a different camera in Settings > OBS > Video Source.';
    }
    if (/video=.*?no such/i.test(stderr) ||
        /video device.*?not found/i.test(stderr)) {
      return 'Hint: the webcam named in Settings was not found on this system. Click the "↻" refresh button next to the Webcam dropdown to re-detect devices, then pick one from the list.';
    }
    if (/dshow.*?(could not|cannot|not found|no such)/i.test(stderr)) {
      return 'Hint: the configured audio input device (dshow) was not found. Pick a different microphone in Settings > OBS, or set it to "None" to stream with silent audio.';
    }
    if (/unknown encoder|encoder not found/i.test(stderr)) {
      return 'Hint: the selected video encoder is not available in this FFmpeg build. Try switching to "OpenH264 (Software)" in Settings > OBS.';
    }
    if (/connection refused|connection timed out|network is unreachable/i.test(stderr)) {
      return 'Hint: the RTMP server refused the connection. Verify the Stream URL and Stream Key are correct, and that your firewall allows outbound TCP 1935.';
    }
    // FFmpeg "Error number -138" on an RTMP output is a generic libavformat
    // network I/O failure — usually raised when the RTMP handshake fails
    // for reasons that don't match the more specific connection-refused /
    // timeout / unreachable wording. In practice it's almost always one of:
    //   • expired or incorrect stream key (Chaturbate rotates keys)
    //   • RTMP ingest unreachable (VPN, firewall, ISP, transient outage)
    //   • the cam platform rate-limited or banned the stream key
    // We put this check BEFORE the generic "invalid argument / output" branch
    // because the user-visible error line that FFmpeg emits for -138 is
    // "Error opening output files: Error number -138 occurred" — which also
    // contains the word "output" and would otherwise fall into the vague
    // catch-all hint below.
    if (/error number -138/i.test(stderr) ||
        /-138 occurred/i.test(stderr)) {
      return 'Hint: the streaming platform rejected the connection (error -138). Most common causes: the Stream Key in Settings > Streaming is expired or wrong (Chaturbate rotates keys — copy a fresh one from your broadcaster page), the RTMP ingest is unreachable (check your internet / VPN / firewall), or the platform rate-limited this key. Re-copy the key and retry.';
    }
    // Windows socket error family on an RTMP stream that was ALREADY
    // ESTABLISHED and then lost. These show up as "Error closing file:
    // Error number -XXXXX occurred" because FFmpeg reports them when
    // trying to flush/close the RTMP output.
    //
    //   -10053  WSAECONNABORTED   Software caused connection abort
    //                             Usually: platform disconnected you,
    //                             or a local firewall/AV killed the
    //                             socket, or the Windows network stack
    //                             aborted a long-running TCP connection.
    //                             Also fires on normal Stop Stream when
    //                             the RTMP trailer send races the server
    //                             close — harmless in that case.
    //
    //   -10054  WSAECONNRESET     Connection reset by peer. Platform
    //                             sent TCP RST mid-stream (server went
    //                             down, key revoked, banned, etc).
    //
    //   -10060  WSAETIMEDOUT      Connection timed out. Network went
    //                             away (Wi-Fi/VPN toggle, sleep, etc).
    //
    //   -10061  WSAECONNREFUSED   Refused outright. Typically DNS
    //                             cached a stale IP or server moved.
    //
    // Check BEFORE the more generic branches below so the specific
    // explanation wins.
    if (/error number -10053/i.test(stderr) || /-10053 occurred/i.test(stderr)) {
      // -10053 is WSAECONNABORTED: the local Winsock stack gave up on
      // the TCP connection to the RTMP ingest. FFmpeg surfaces it when
      // trying to flush the final packets. Three distinct upstream
      // causes share this error code, and giving the wrong hint wastes
      // the user's time bisecting their setup. We branch on renderer
      // telemetry (beauty-filter fps + MediaRecorder effective bitrate)
      // captured in the ring buffer over the seconds leading up to
      // failure:
      //
      //   A. FRAME STARVATION — the renderer couldn't sustain capture
      //      fps, so MediaRecorder delivered near-empty chunks, so
      //      Chaturbate's ingest sees a stalled stream and RSTs. The
      //      signature is beauty-filter fps < 25 in the last 5s window
      //      OR media-recorder effBitrate < 50% of target. This is the
      //      case that motivated the v3.4.40 rewrite — the previous
      //      hint blamed bitrate-cap and sent users chasing the wrong
      //      root cause.
      //
      //   B. BITRATE CAP — stream opened cleanly, ran fine, then got
      //      kicked for exceeding the platform's ingest ceiling
      //      (~4000 kbps at 1080p for Chaturbate). Only relevant when
      //      effective bitrate actually reached target.
      //
      //   C. NORMAL STOP — user clicked Stop Stream; FFmpeg tried to
      //      send the RTMP trailer after the server already closed.
      //      Harmless. No telemetry signal either way, but the stream
      //      ran for long enough that both starvation and bitrate
      //      signals would have surfaced if they were real causes.
      const starvation = this._detectFrameStarvation();
      if (starvation.starving) {
        return `Hint: your stream was disconnected because the video source couldn't keep up with the encoder (Windows error -10053, platform dropped a stalled stream). ${starvation.reason} Fix: open Settings > Filters and lower "Background Blur" quality, turn off background effects, or reduce capture resolution to 720p. If you're on an integrated GPU, background blur at 1080p is the most common culprit.`;
      }
      if (starvation.healthyBitrate) {
        return 'Hint: the stream connected and was running at target bitrate, then the platform dropped the connection (Windows error -10053). Most common cause at this point: bitrate exceeds the platform cap — Chaturbate kicks streams over ~4000 kbps at 1080p. Open Settings > Streaming and set Video Bitrate to 3500 (1080p) or 3000 (720p). Less common: the stream key was revoked mid-session, Windows Defender / antivirus interfered, or — if this fired when you pressed Stop Stream — it is harmless.';
      }
      // No telemetry either way — conservative both-possibilities hint.
      return 'Hint: the stream was disconnected by the platform (Windows error -10053). Two possible causes: (1) the video source stalled (background blur or other filter starved the encoder of frames — try disabling filters and retry), or (2) bitrate exceeded the platform cap (try lowering Video Bitrate to 3500 in Settings > Streaming). If this fired right after you pressed Stop Stream it is harmless.';
    }
    if (/error number -10054/i.test(stderr) || /-10054 occurred/i.test(stderr)) {
      return 'Hint: the broadcast platform forcibly closed your connection (Windows error -10054, connection reset by peer). This usually means the platform revoked your stream key, your account was temporarily banned, or the ingest server restarted. Copy a fresh stream key from your broadcaster page and retry.';
    }
    if (/error number -10060/i.test(stderr) || /-10060 occurred/i.test(stderr)) {
      return 'Hint: the connection to the streaming platform timed out (Windows error -10060). Network changed mid-stream? Check your Wi-Fi / VPN / firewall, then retry. If you were on a mobile hotspot or your PC went to sleep, that would explain this error.';
    }
    if (/error number -10061/i.test(stderr) || /-10061 occurred/i.test(stderr)) {
      return 'Hint: the streaming platform refused the connection (Windows error -10061). The RTMP ingest may have moved or be temporarily down. Re-copy the stream URL from the Chaturbate broadcaster page and retry.';
    }
    if (/invalid argument/i.test(stderr) && /output/i.test(stderr)) {
      return 'Hint: "Invalid argument" on output almost always means the Stream URL or Stream Key has a formatting problem (trailing whitespace, wrong protocol, fields swapped, or corrupted paste). Open Settings > Streaming, verify the URL starts with rtmp:// and the Key has no spaces, then retry. If they look right, click the platform preset button (Chaturbate, Stripchat, etc.) to reset the URL cleanly.';
    }
    // Non-monotonic DTS / PTS from a pipe input. v3.4.31 added
    // -af aresample=async=1 which compensates for MediaRecorder's
    // burst-mode audio delivery, so this hint should rarely fire on
    // up-to-date installs. It remains as a fallback for edge cases
    // (custom encoder configs that bypass the resampler, unusual
    // input sources).
    if (/non[-\s]?monotonic (dts|pts)/i.test(stderr) ||
        /timestamps are unset in a packet/i.test(stderr) ||
        /dts < pts/i.test(stderr)) {
      return 'Hint: the stream has out-of-order timestamps, which cam platforms reject. v3.4.31+ normally handles this automatically via an audio resampler. If you keep hitting this, try switching the video encoder in Settings > OBS to "OpenH264 (Software)" which is more tolerant of timestamp irregularities, or restart the stream (MediaRecorder sometimes produces cleaner timestamps on the second attempt).';
    }
    // FFmpeg prints "Conversion failed!" as a last-ditch summary line
    // when any transcoding step fails AND _extractErrorLine couldn't
    // find a more informative line earlier in stderr. Typically means
    // stderr was truncated or the real error went to stdout, not stderr.
    if (/conversion failed/i.test(stderr) &&
        !/error number|invalid argument/i.test(stderr)) {
      return 'Hint: FFmpeg reported a transcoding failure without a specific cause. The full log at the path below contains the complete stderr — the actionable error is usually 10-30 lines above the "Conversion failed!" line. Most common cause on the webcam path is an encoder incompatibility; try switching to "OpenH264 (Software)" in Settings > OBS.';
    }
    return null;
  }

  // Writes the full FFmpeg invocation + stderr to a timestamped log file so
  // the user can share it when reporting a streaming bug. Stream key is
  // redacted before writing. Returns the absolute file path (or null on
  // failure — logging must never block the user).
  _writeStreamLog(ctx) {
    try {
      const userData = app && typeof app.getPath === 'function'
        ? app.getPath('userData')
        : null;
      if (!userData) return null;

      const logDir = path.join(userData, 'logs');
      fs.mkdirSync(logDir, { recursive: true });

      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const file = path.join(logDir, `${ctx.mode}-${ts}.log`);

      // Redaction: collect every stream key that might appear in
      // stderr / args and build one combined regex. Simulcast streams
      // may surface per-destination error lines containing any of the
      // keys, so we have to scrub the full set rather than just one.
      //
      // Input shapes accepted:
      //   ctx.destinations = [{ name, url, key, fullUrl }]  (current)
      //   ctx.streamKey = '...' + ctx.rtmpUrl = '...'       (legacy)
      const keys = [];
      if (Array.isArray(ctx.destinations)) {
        for (const d of ctx.destinations) {
          if (d && d.key && d.key.length > 3) keys.push(d.key);
        }
      }
      if (ctx.streamKey && ctx.streamKey.length > 3) keys.push(ctx.streamKey);
      const keyPattern = keys.length
        ? new RegExp(
            keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
            'g'
          )
        : null;
      const redact = (s) => keyPattern && s
        ? String(s).replace(keyPattern, '<REDACTED_KEY>')
        : s;

      // Build the destinations section. If ctx has destinations[],
      // list each one; otherwise synthesize from rtmpUrl so legacy
      // callers still produce readable logs.
      let destinationsBlock;
      if (Array.isArray(ctx.destinations) && ctx.destinations.length) {
        const lines = ctx.destinations.map((d, i) => {
          const keyMask = d.key ? '<REDACTED_KEY>' : '(no key)';
          return `  [${i}] ${d.name || 'Destination'}: ${d.url || '(no url)'}/${keyMask}`;
        });
        destinationsBlock = [
          `─── Destinations (${ctx.destinations.length}${ctx.destinations.length > 1 ? ' — SIMULCAST' : ''}) ───`,
          ...lines,
        ].join('\n');
      } else if (ctx.rtmpUrl) {
        destinationsBlock = `─── Destination ───\n  ${redact(ctx.rtmpUrl)}`;
      } else {
        destinationsBlock = '─── Destination ───\n  (not captured)';
      }

      const body = [
        `# Apex Revenue — ${ctx.mode} log`,
        `# Generated: ${new Date().toISOString()}`,
        `# App version: ${(app && app.getVersion && app.getVersion()) || 'unknown'}`,
        `# Exit code: ${ctx.exitCode}`,
        `# Detected error: ${ctx.errorLine || '(none)'}`,
        '',
        '─── Video routing diagnostics ───',
        (this._routingDiag && this._routingDiag.length
          ? this._routingDiag.join('\n')
          : '(no routing diagnostics captured)'),
        '',
        destinationsBlock,
        '',
        '─── FFmpeg invocation ───',
        `Binary: ${this.ffmpegPath}`,
        `Full args: ${redact(ctx.args.join(' '))}`,
        '',
        '─── FFmpeg stderr (last 8KB) ───',
        redact(ctx.stderr || ''),
      ].filter(Boolean).join('\n');

      fs.writeFileSync(file, body, 'utf8');
      return file;
    } catch (e) {
      console.error('[StreamEngine] Failed to write stream log:', e.message);
      return null;
    }
  }

  // ─── Pipe-Input Streaming (renderer owns the camera) ─────
  //
  // Web-research architecture (Mux blog, Facebook Canvas-Streaming
  // Example): instead of FFmpeg opening the DirectShow webcam pin
  // exclusively, the RENDERER owns the camera via getUserMedia and
  // feeds FFmpeg WebM chunks from MediaRecorder over stdin. This
  // frees the renderer to show a live preview canvas (same stream
  // that feeds the recorder) while streaming — zoom/pan/tilt
  // transforms all work through canvas manipulation.
  //
  // FFmpeg args breakdown:
  //   -f matroska -i pipe:0       video input from stdin (WebM/Matroska)
  //   -f dshow -i audio=<mic>     audio input (separate mic device)
  //   -map 0:v:0 -map 1:a:0       explicit mux: video from input 0,
  //                               audio from input 1
  //   -c:v <encoder>              re-encode video. Even if MediaRecorder
  //                               emitted H.264, we re-encode to honor
  //                               user-selected resolution/bitrate and
  //                               guarantee consistent keyframe interval
  //                               for RTMP servers that need it.
  //   -c:a aac                    re-encode audio (FLV requires AAC)
  //   -f flv <rtmp>               RTMP output
  //
  // The 'matroska' demuxer handles both pure WebM (VP8/VP9/Opus) and
  // WebM-with-H264 variants Chromium emits. Using -f matroska rather
  // than -f webm lets FFmpeg parse whatever MediaRecorder chose.
  //
  // No -re: we're reading from a live source that's already arriving
  // at real-time pace. -re would add 1x delay and sawtooth the
  // timestamps against RTMP's clock.
  async startStreamFromPipe(settings) {
    if (this.streamProcess) throw new Error('Stream already running');

    // Reset diag for this attempt
    this._routingDiag = [];
    this._diag('route: pipe (MediaRecorder -> stdin -> FFmpeg)');

    // v3.4.47: best-effort cleanup of any overlay text tmp files
    // from a prior session that didn't run stopStreamFromPipe (e.g.
    // FFmpeg was killed by the watchdog, or the app was force-quit).
    // Without this the %TEMP% folder accumulates apex-text-*.txt
    // files across sessions.
    if (this._overlayTextFiles && this._overlayTextFiles.length) {
      const fs = require('fs');
      for (const p of this._overlayTextFiles) {
        try { fs.unlinkSync(p); } catch { /* harmless */ }
      }
      this._overlayTextFiles = [];
    }

    const resolvedPath = findFFmpegPath();
    if (!resolvedPath) {
      const err = new Error('FFmpeg is not installed. Open Settings -> Streaming and click "Install FFmpeg".');
      err.code = 'FFMPEG_NOT_INSTALLED';
      throw err;
    }
    this.ffmpegPath = resolvedPath;

    const {
      videoBitrate, audioBitrate, fps,
    } = settings;
    // Sanitize resolution BEFORE building any FFmpeg args or computing
    // canStreamCopy. This is what unblocks stream-copy for users whose
    // stored obsSettings.resolution came from the pre-v3.4.41 autoconfig
    // bug (1920x1200 laptop displays -> 1728x1080 saved value). After
    // sanitization, a source track at 1920x1080 matches the coerced
    // target of 1920x1080 and canStreamCopy fires instead of invoking
    // the libopenh264 re-encode that was starving MediaRecorder.
    let resolution = this._sanitizeResolution(settings.resolution);

    const encoder = this._detectH264Encoder(settings.videoEncoder);
    if (settings.videoEncoder && encoder !== settings.videoEncoder) {
      this.emit('encoder-auto-changed', {
        requested: settings.videoEncoder,
        resolved: encoder,
        reason: `"${settings.videoEncoder}" is not usable on this machine. Falling back to "${encoder}".`,
      });
    }

    // Decide whether we can skip video re-encoding entirely.
    //
    // Chrome's MediaRecorder already emits H.264 (Baseline) when the
    // mimeType was 'video/x-matroska;codecs=avc1' — which is our first
    // candidate in App.jsx#pickWebmMimeType — so in the common case
    // FFmpeg only needs to remux into FLV. We re-encode ONLY when at
    // least one of the following forces our hand:
    //
    //   • MediaRecorder output is NOT H.264 (browser fell back to
    //     VP8/VP9 on a build without HW H.264 — rare on modern Windows
    //     but possible in Electron forks or on machines without
    //     Intel/AMD/NVIDIA H.264 encoders).
    //   • User's target resolution differs from the webcam's native
    //     capture resolution. A scale filter requires decode → scale →
    //     encode; copy would leave the frames at the wrong size.
    //   • User explicitly picked a non-copy encoder in Settings (the
    //     obsSettings.videoEncoder field is a deliberate override —
    //     honor it even when copy would have worked).
    //
    // When copy is eligible, we skip the software encoder path entirely.
    // That's significant because libopenh264 (our software fallback)
    // has been the source of every v3.4.35–39 failure: the '[OpenH264]
    // profile(578) unsupported, change to UNSPECIFIC' warning, the
    // frame-skip quirk, and the general high CPU cost that contributes
    // to MediaRecorder/beauty-filter starvation on weaker machines.
    const _srcW = settings._pipeSrcWidth;
    const _srcH = settings._pipeSrcHeight;
    const _tgtW = resolution && resolution.width;
    const _tgtH = resolution && resolution.height;
    const _resolutionsMatch =
      typeof _srcW === 'number' && typeof _srcH === 'number' &&
      typeof _tgtW === 'number' && typeof _tgtH === 'number' &&
      _srcW === _tgtW && _srcH === _tgtH;
    // Software encoder labels (OpenH264, x264) must NOT disable H.264 passthrough.
    // When the browser already emits avc1/H.264 at the target resolution, `-c:v copy`
    // remuxes into FLV — no FFmpeg video encode step. Treating any non-empty
    // videoEncoder as "forced" made the Chaturbate preset (libopenh264) and the
    // default store seed (libx264) force a full decode + re-encode, which starved
    // MediaRecorder (~200 kbps vs target) and triggered RTMP -10053 kicks.
    // Hardware encoders (NVENC, QSV, AMF, MF) still imply a deliberate re-encode path.
    const _enc = settings.videoEncoder && String(settings.videoEncoder).trim();
    const _encLower = _enc.toLowerCase();
    const _userForcedEncoder = !!_enc &&
      _encLower !== 'libopenh264' &&
      _encLower !== 'libx264';
    // v3.4.47: overlays force re-encode. filter_complex can't run
    // through `-c:v copy` because copy bypasses the filter graph
    // entirely — packets are forwarded verbatim from input to output.
    // When the user's scene has any compositable overlay source,
    // we must decode the pipe, run the overlay filter chain, and
    // re-encode the composite. canStreamCopy becomes false.
    const _hasOverlays = Array.isArray(settings._overlays) && settings._overlays.length > 0;
    const canStreamCopy =
      settings._pipeCodec === 'h264' &&
      _resolutionsMatch &&
      !_userForcedEncoder &&
      !_hasOverlays;

    // Precompute the overlay filter_complex + extra input args. Null
    // when no overlays are present — keeps the hot path unchanged
    // for scenes that are webcam-only.
    const overlayPlan = _hasOverlays
      ? this._buildOverlayFilterComplex(settings._overlays, resolution)
      : null;
    // Stash text-file paths on the instance so stopStreamFromPipe
    // (or the next startStreamFromPipe) can unlink them. These are
    // small (usually a few bytes each) but we don't want them
    // accumulating in %TEMP% across sessions.
    if (overlayPlan && overlayPlan.textFiles.length) {
      this._overlayTextFiles = (this._overlayTextFiles || []).concat(overlayPlan.textFiles);
    }
    if (_hasOverlays) {
      this._diag(`overlays: ${settings._overlays.length} compositing via filter_complex`);
      settings._overlays.forEach((o, i) => {
        this._diag(`  [${i}] ${o.type}: ${o.name} at ${o.x},${o.y} ${o.w}x${o.h} op=${o.opacity}`);
      });
    }

    // Resolve destinations and build output args. Same helper used
    // by the direct-path startStream, so simulcast works identically
    // for webcam (pipe) and non-webcam (direct) sources.
    const destinations = this._resolveDestinations(settings);
    const outputArgs = this._buildOutputArgs(destinations);

    this._diag(`destinations: ${destinations.length} ${destinations.length > 1 ? '(SIMULCAST)' : '(single)'}`);
    destinations.forEach((d, i) => {
      this._diag(`  [${i}] ${d.name}: ${d.url}/<REDACTED>`);
    });
    this._diag(`encoder: ${canStreamCopy ? 'copy (MediaRecorder H.264 passthrough)' : encoder}`);
    this._diag(`bitrate: ${canStreamCopy ? `passthrough (MediaRecorder target ${videoBitrate}k)` : `${videoBitrate}k video`} / ${audioBitrate}k audio`);
    // resolution is typically { width, height } — stringifying the raw
    // object yields "[object Object]" which is useless in the log.
    // Format defensively: handle both the object form and the (rare)
    // string form "1920x1080".
    const resText = (resolution && typeof resolution === 'object')
      ? `${resolution.width || '?'}x${resolution.height || '?'}`
      : String(resolution || '?');
    this._diag(`resolution: ${resText} @ ${fps} fps`);

    // Audio source resolution for pipe mode. Three paths in order of
    // preference:
    //
    //   1. PIPE AUDIO (best): the renderer's getUserMedia captured a
    //      mic alongside the webcam, BeautyFilter carried the audio
    //      track through, and MediaRecorder embedded it in the
    //      Matroska output. FFmpeg sees audio + video in input 0 and
    //      we just map 0:a:0 — no separate input needed. Signaled by
    //      the renderer via settings._pipeHasAudio = true.
    //
    //   2. DSHOW (explicit override): user has configured a specific
    //      microphone device in Settings (settings.audioDevice is set).
    //      Used as input 1. Kept as an option because some users want
    //      a different mic than the webcam's built-in one (XLR mic via
    //      audio interface, USB gooseneck mic, etc).
    //
    //   3. LAVFI SILENT (last resort): renderer couldn't get mic
    //      permission AND no dshow device is configured. Produces
    //      silent audio and the stream will likely get kicked by cam
    //      platforms within 1-2 seconds. Pre-flight warning in
    //      handleStartStream is the gate that should have caught this;
    //      we still support the path so "stream silent anyway" works
    //      if the user opted to continue.
    const pipeHasAudio = settings && settings._pipeHasAudio === true;
    const hasDshowAudio = settings && settings.audioDevice && String(settings.audioDevice).trim() !== '';

    let audioInputArgs = [];
    let audioMap;
    let audioSourceLabel;
    if (pipeHasAudio) {
      // No extra input — audio rides in with the Matroska pipe
      audioInputArgs = [];
      audioMap = '0:a:0';
      audioSourceLabel = 'webcam mic via pipe (input 0)';
    } else if (hasDshowAudio) {
      audioInputArgs = this._audioInputArgs(settings);
      audioMap = '1:a:0';
      audioSourceLabel = 'dshow mic (input 1)';
    } else {
      audioInputArgs = ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'];
      audioMap = '1:a:0';
      audioSourceLabel = 'silent lavfi (WARNING: cam platforms may kick)';
    }
    this._diag(`audio source: ${audioSourceLabel}`);

    // Build full args array
    const args = [
      // Video input: matroska/webm from stdin
      //
      // Two input-hardening flags specific to the MediaRecorder->pipe
      // path. Not needed in the direct-input path (webcam via dshow)
      // because dshow produces well-formed, monotonic timestamps.
      // MediaRecorder does not — the browser transcodes from the
      // camera's native format to WebM on the fly, and the resulting
      // container timestamps can have these quirks:
      //
      //   • Negative or NaN DTS on the first few packets (before the
      //     encoder has established a baseline). -fflags +igndts
      //     ignores the broken DTS entirely, +genpts regenerates PTS
      //     from duration + timebase — together they let FFmpeg accept
      //     the stream without aborting on 'Invalid timestamps'.
      //   • Queue overflow when MediaRecorder bursts 4 chunks in 1s
      //     (the 250ms timeslice) against FFmpeg's default 8-frame
      //     input queue — -thread_queue_size 1024 handles that.
      //
      // NOT using -use_wallclock_as_timestamps 1 anymore (removed in
      // v3.4.31). That flag replaces ALL container timestamps with the
      // wallclock time at packet arrival. For video-only pipes that's
      // fine. For audio+video pipes (the v3.4.29+ default where the
      // webcam carries its own mic), it actively BREAKS audio sync:
      // MediaRecorder delivers a burst of audio packets in a single
      // chunk, they all get near-identical wallclock timestamps, and
      // their DTS can end up non-monotonic. The v3.4.30 stream-pipe
      // log showed hundreds of 'Non-monotonic DTS' warnings on the AAC
      // output followed by an eventual -10053 kick from Chaturbate's
      // RTMP validator. Dropping the wallclock flag lets +genpts+igndts
      // do timestamp cleanup without stomping on the legitimate audio
      // timing that the matroska container already carries.
      //
      // -fflags +genpts+igndts    Regenerate PTS, ignore DTS entirely.
      //                           Handles bad initial DTS from
      //                           MediaRecorder without the side
      //                           effects wallclock had on audio.
      // -thread_queue_size 1024   Raise input queue from 8 to 1024
      //                           frames so chunk bursts don't drop
      //                           frames. Must appear BEFORE -i.
      '-fflags', '+genpts+igndts',
      '-thread_queue_size', '1024',
      '-f', 'matroska',
      '-i', 'pipe:0',

      // v3.4.47: extra inputs for image/video overlays. These are
      // added AFTER the pipe input so the pipe stays at input index 0
      // (the -fflags/-thread_queue_size flags above are per-next-input
      // and need to bind to the matroska pipe specifically; they would
      // misapply to a still image otherwise). Each image adds a
      // `-loop 1 -framerate 30 -i PATH`; each looping video adds
      // `-stream_loop -1 -i PATH`. Empty array when no overlays.
      ...(overlayPlan ? overlayPlan.extraInputArgs : []),

      // Audio input (dshow device, lavfi silent, or empty if audio
      // rides in through the Matroska pipe)
      ...audioInputArgs,

      // v3.4.47: -filter_complex for the overlay graph when present.
      // Without overlays we skip this entirely and fall through to the
      // simpler -vf scale path that _videoEncodeArgs emits inside the
      // encode args block below.
      ...(overlayPlan ? ['-filter_complex', overlayPlan.filterComplex] : []),

      // Explicit mapping: video from filter_complex output when
      // overlays are present (the [out] label produced by
      // _buildOverlayFilterComplex), otherwise from pipe input 0.
      // Audio always maps from whichever source audioInputArgs selected.
      '-map', (overlayPlan ? overlayPlan.outputLabel : '0:v:0'),
      '-map', audioMap,

      // Video encode — copy when MediaRecorder's output already matches
      // the user's target (see canStreamCopy above), otherwise re-encode
      // via the per-encoder args used by the direct path.
      //
      // The copy path still sets -pix_fmt yuv420p on the logical level
      // (MediaRecorder already emits it) but we don't specify it here —
      // -c:v copy forwards packets verbatim without pixel-format
      // negotiation.
      // v3.4.47: when overlayPlan is present, filter_complex has
      // already scaled the composite to target resolution and emitted
      // it as [out]. We must NOT pass -vf scale here — FFmpeg rejects
      // combined -filter_complex + -vf with 'Filtergraph simple/complex
      // conflict'. _stripVfArgs drops the `-vf scale=WxH` pair and
      // keeps the bitrate / gop / preset args intact.
      ...(
        canStreamCopy
          ? ['-c:v', 'copy']
          : (
            overlayPlan
              ? this._stripVfArgs(this._videoEncodeArgs(encoder, videoBitrate, fps, resolution))
              : this._videoEncodeArgs(encoder, videoBitrate, fps, resolution)
          )
      ),

      // Audio encode
      //
      // aresample=async=1 is critical when audio comes from the
      // MediaRecorder pipe (Tier 1 above). The browser delivers audio
      // in per-chunk bursts where individual sample timestamps within
      // a burst can arrive out of order — standard behavior, not a bug.
      // Without compensation, FFmpeg emits 'Non-monotonic DTS' warnings
      // on every burst, clamps timestamps backward, and produces an
      // RTMP stream that cam platforms reject with -10053 after a few
      // seconds. aresample=async=1 stretches/squeezes samples to keep
      // output DTS monotonic — the industry-standard fix for live
      // audio from irregular-timestamp sources.
      //
      // Harmless on the dshow and lavfi audio paths (their timestamps
      // are already clean), so we apply it unconditionally for
      // consistency rather than branching.
      '-af', 'aresample=async=1',
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-ar', '44100',

      // Output — single -f flv or -f tee for simulcast
      ...outputArgs,
    ];

    this._diag(`spawning ffmpeg with ${args.length} args`);
    // Redact every destination's key when logging the command line
    const redactedArgs = args.map((a) => {
      let result = a;
      for (const d of destinations) {
        if (d.key && result.includes(d.key)) {
          result = result.split(d.key).join('<REDACTED>');
        }
      }
      return result;
    });
    console.log('[StreamEngine] Spawning FFmpeg (pipe mode) with args:', redactedArgs.join(' '));

    let stderrBuf = '';

    this.streamProcess = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.streamProcess.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString();
      if (stderrBuf.length > 12000) stderrBuf = stderrBuf.slice(-8000);
      // Use the same parser the non-pipe stream path uses (line ~1031).
      // A prior refactor renamed the callsite to _parseProgressLine but
      // the method was never created — every stderr chunk in pipe mode
      // would crash with TypeError, which is what Ridge's log showed.
      this._handleFFmpegOutput(chunk.toString());
    });

    // stdin errors (e.g. EPIPE when FFmpeg exits while we're still
    // writing chunks) shouldn't crash the whole process. Log and
    // swallow — the close handler will do the real cleanup.
    this.streamProcess.stdin.on('error', (err) => {
      if (err.code === 'EPIPE') {
        // FFmpeg closed stdin. Normal at end of stream.
        return;
      }
      console.warn('[StreamEngine] stdin error:', err.message);
    });

    this._uptimeStart = Date.now();
    this._uptimeInterval = setInterval(() => {
      this.status.streamUptime = Math.floor((Date.now() - this._uptimeStart) / 1000);
      this.emit('status', { ...this.status });
    }, 1000);

    this.status.streaming = true;
    this.status.errorReason = null;
    this.status.errorLogPath = null;

    // Open broadcast-ledger session for pipe mode. Same semantics as the
    // direct-path startStream — analytics-only accounting, zero enforcement.
    try {
      const ledger = require('./broadcast-ledger');
      this._broadcastSessionId = ledger.recordStart(settings?.platform || 'unknown');
    } catch (e) {
      this._broadcastSessionId = null;
    }

    this.emit('status', { ...this.status });

    this.streamProcess.on('close', (code) => {
      if (this._uptimeInterval) clearInterval(this._uptimeInterval);
      this.status.streaming = false;
      this.status.streamUptime = 0;

      // Close the ledger session on pipe-mode exit.
      if (this._broadcastSessionId) {
        try {
          const ledger = require('./broadcast-ledger');
          const exitReason = (code !== 0 && code !== null) ? 'error' : 'user_stop';
          ledger.recordStop(this._broadcastSessionId, exitReason);
        } catch (e) { /* ledger errors don't block cleanup */ }
        this._broadcastSessionId = null;
      }

      let errorReason = null;
      let logPath = null;
      if (code !== 0 && code !== null && stderrBuf) {
        // Same extractor used by the direct path. See _extractErrorLine
        // for why a two-pass approach matters (boilerplate like
        // "Conversion failed!" must not mask the specific root cause).
        const errorLine = this._extractErrorLine(stderrBuf);
        errorReason = errorLine || `FFmpeg exited with code ${code}`;

        const hint = this._diagnosticHint(stderrBuf);
        if (hint) errorReason = `${errorReason}\n\n${hint}`;

        logPath = this._writeStreamLog({
          mode: 'stream-pipe',
          args,
          destinations,
          exitCode: code,
          stderr: stderrBuf,
          errorLine,
        });
        if (logPath) errorReason = `${errorReason}\n\nFull log: ${logPath}`;

        console.error('[StreamEngine] Pipe stream stopped unexpectedly:', errorReason);
        console.error('[StreamEngine] Full stderr tail:\n', stderrBuf.slice(-2000));
      }

      this.status.errorReason = errorReason;
      this.status.errorLogPath = logPath;
      this.emit('status', { ...this.status });
      this.streamProcess = null;
      this._cleanupTempFiles();
    });

    this.streamProcess.on('error', (err) => {
      console.error('[StreamEngine] Pipe spawn error:', err);
      this.status.streaming = false;
      this.status.errorReason = err.message;

      if (this._broadcastSessionId) {
        try {
          const ledger = require('./broadcast-ledger');
          ledger.recordStop(this._broadcastSessionId, 'crash');
        } catch (e) { /* ledger errors don't block cleanup */ }
        this._broadcastSessionId = null;
      }

      this.emit('status', { ...this.status });
      this.streamProcess = null;
      this._cleanupTempFiles();
    });

    return true;
  }

  // Forward a video chunk from the renderer's MediaRecorder to FFmpeg's
  // stdin. Called by the main-process IPC handler at ~4 Hz (every 250ms
  // of MediaRecorder output). Returns false if the pipe is closed so
  // the caller can stop sending.
  writeChunk(buffer) {
    if (!this.streamProcess || !this.streamProcess.stdin) return false;
    if (this.streamProcess.stdin.destroyed) return false;
    try {
      return this.streamProcess.stdin.write(buffer);
    } catch (err) {
      // EPIPE / "write after end" land here. Logged by stdin error
      // handler above; nothing more to do.
      return false;
    }
  }

  // Gracefully end the pipe stream. Closing stdin sends EOF to FFmpeg
  // which flushes its buffers and writes the RTMP trailer before
  // exiting — cleaner than SIGTERM. Followed by a 3s safety timeout
  // in case FFmpeg hangs on the RTMP server's FIN-ACK.
  stopStreamFromPipe() {
    if (this.streamProcess) {
      try {
        if (this.streamProcess.stdin && !this.streamProcess.stdin.destroyed) {
          this.streamProcess.stdin.end();
        }
      } catch (err) {
        console.warn('[StreamEngine] stdin.end() failed:', err.message);
      }
      setTimeout(() => {
        if (this.streamProcess) {
          this.streamProcess.kill('SIGTERM');
          this.streamProcess = null;
        }
      }, 3000);
    }
    this.status.streaming = false;
    if (this._uptimeInterval) clearInterval(this._uptimeInterval);

    // v3.4.47: unlink the tmp text files created for drawtext overlays.
    // These are small (usually under 1 KB each) but we don't want them
    // accumulating in %TEMP% across sessions, and leaving them around
    // makes next-run disk lookups noisier for no benefit. Best-effort —
    // failures to unlink are silently logged, not thrown, since by this
    // point the FFmpeg process has already released its handles to them.
    if (this._overlayTextFiles && this._overlayTextFiles.length) {
      const fs = require('fs');
      for (const p of this._overlayTextFiles) {
        try { fs.unlinkSync(p); } catch (e) {
          // Already gone, or permission issue — not worth surfacing.
          if (e && e.code !== 'ENOENT') {
            console.warn('[StreamEngine] overlay text unlink failed:', p, e.code);
          }
        }
      }
      this._overlayTextFiles = [];
    }

    // Close the ledger session on pipe-mode user stop. Same analytics-
    // only semantics as stopStream — no enforcement.
    if (this._broadcastSessionId) {
      try {
        const ledger = require('./broadcast-ledger');
        ledger.recordStop(this._broadcastSessionId, 'user_stop');
      } catch (e) { /* ledger errors don't block cleanup */ }
      this._broadcastSessionId = null;
    }

    this.emit('status', { ...this.status });
  }

  stopStream() {
    if (this.streamProcess) {
      this.streamProcess.stdin.write('q');
      setTimeout(() => {
        if (this.streamProcess) {
          this.streamProcess.kill('SIGTERM');
          this.streamProcess = null;
        }
      }, 3000);
    }
    this.status.streaming = false;
    if (this._uptimeInterval) clearInterval(this._uptimeInterval);

    // Close the broadcast-ledger session. Analytics-only — this records
    // how long the model broadcast so we can surface usage stats in the
    // UI. There is no quota enforcement: models on Platinum (Tier 2)
    // and Agency (Tier 3) have unlimited broadcasting as part of their
    // subscription. See BROADCAST_POLICY in shared/apex-config.js.
    if (this._broadcastSessionId) {
      try {
        const ledger = require('./broadcast-ledger');
        ledger.recordStop(this._broadcastSessionId, 'user_stop');
      } catch (e) {
        // Ledger errors must never interfere with the stop flow.
      }
      this._broadcastSessionId = null;
    }

    this.emit('status', { ...this.status });
  }

  // ─── Local Recording ──────────────────────────────────
  async startRecording(settings) {
    if (this.recordProcess) throw new Error('Recording already running');

    // Pre-flight: same reasoning as startStream — surface a clean error
    // instead of a confusing FFmpeg exit when the binary is missing.
    const resolvedPath = findFFmpegPath();
    if (!resolvedPath) {
      const err = new Error('FFmpeg is not installed. Open Settings → Streaming and click "Install FFmpeg", or install it to your system PATH.');
      err.code = 'FFMPEG_NOT_INSTALLED';
      throw err;
    }
    this.ffmpegPath = resolvedPath;

    const { outputPath, videoBitrate, audioBitrate, resolution, fps } = settings;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(outputPath, `ApexRevenue_${timestamp}.mp4`);

    // Ensure output dir exists
    fs.mkdirSync(outputPath, { recursive: true });

    const encoder = this._detectH264Encoder(settings.videoEncoder);
    if (settings.videoEncoder && encoder !== settings.videoEncoder) {
      this.emit('encoder-auto-changed', {
        requested: settings.videoEncoder,
        resolved: encoder,
        reason: `"${settings.videoEncoder}" is not usable on this machine. Falling back to "${encoder}".`,
      });
    }

    const videoInputArgs = await this._videoInputArgs(settings, fps);
    const { extraAudioInputs, mapArgs } = await this._resolveStreamMapsAndExtraAudioInputs(settings);
    const args = [
      ...videoInputArgs,
      ...extraAudioInputs,
      ...mapArgs,
      ...this._videoEncodeArgs(encoder, videoBitrate, fps, resolution),
      ...(encoder === 'libx264' ? ['-crf', '18'] : []),
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      filename,
    ];

    this.recordProcess = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.status.recording = true;
    this.status.recordDuration = 0;
    this._recordInterval = setInterval(() => {
      this.status.recordDuration++;
      this.emit('status', { ...this.status });
    }, 1000);

    this.recordProcess.on('close', () => {
      this.status.recording = false;
      if (this._recordInterval) clearInterval(this._recordInterval);
      this.emit('status', { ...this.status });
      this.recordProcess = null;
    });

    this.recordProcess.on('error', (err) => {
      console.error('Record FFmpeg error:', err);
      this.status.recording = false;
      this.emit('status', { ...this.status, error: err.message });
      this.recordProcess = null;
    });

    this.emit('status', { ...this.status, recordingFile: filename });
    return filename;
  }

  stopRecording() {
    if (this.recordProcess) {
      this.recordProcess.stdin.write('q');
      setTimeout(() => {
        if (this.recordProcess) {
          this.recordProcess.kill('SIGTERM');
          this.recordProcess = null;
        }
      }, 3000);
    }
    this.status.recording = false;
    if (this._recordInterval) clearInterval(this._recordInterval);
    this.emit('status', { ...this.status });
  }

  // ─── Virtual Camera ───────────────────────────────────
  async startVirtualCam() {
    // Virtual camera requires OBS VirtualCam plugin or similar
    // We pipe our canvas output to a virtual camera device
    this.status.virtualCam = true;
    this.emit('status', { ...this.status });
    return true;
  }

  stopVirtualCam() {
    if (this.virtualCamProcess) {
      this.virtualCamProcess.kill();
      this.virtualCamProcess = null;
    }
    this.status.virtualCam = false;
    this.emit('status', { ...this.status });
  }

  // ─── Status & Stats ───────────────────────────────────
  getStatus() {
    return { ...this.status };
  }

  _handleFFmpegOutput(text) {
    // Parse FFmpeg progress output
    const fpsMatch = text.match(/fps=\s*(\d+)/);
    const bitrateMatch = text.match(/bitrate=\s*([\d.]+)kbits/);
    const dropMatch = text.match(/drop=\s*(\d+)/);

    if (fpsMatch) this.status.fps = parseInt(fpsMatch[1]);
    if (bitrateMatch) this.status.bitrate = parseFloat(bitrateMatch[1]);
    if (dropMatch) this.status.droppedFrames = parseInt(dropMatch[1]);
  }

  _parseFFmpegStats() {
    // CPU usage estimation (simplified)
    try {
      const used = process.cpuUsage();
      this.status.cpuUsage = Math.round((used.user + used.system) / 1000000);
    } catch {}
  }

  cleanup() {
    this.stopStream();
    this.stopRecording();
    this.stopVirtualCam();
  }
}

module.exports = new StreamEngine();
