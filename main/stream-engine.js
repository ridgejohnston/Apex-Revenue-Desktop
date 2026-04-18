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
        return ['-rc_mode', 'bitrate'];
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
  _videoInputArgs(settings, fps) {
    const source = settings.videoSource || 'screen';
    if (source === 'webcam' && settings.webcamDevice && settings.webcamDevice.trim() !== '') {
      // Escape colons in the device name. FFmpeg's dshow input parser
      // treats ':' as the video/audio separator (format:
      // video=<name>:audio=<name>), so device names containing colons —
      // most commonly the USB vendor:product ID shown in parens like
      // 'HP TrueVision HD Camera (04f2:b75e)' — get misparsed and
      // trigger 'Malformed dshow input string'. Backslash-escape per
      // FFmpeg dshow docs.
      const deviceName = settings.webcamDevice.replace(/:/g, '\\:');
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
    // Default: GDI full-desktop screen capture
    return [
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', 'desktop',
    ];
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
        resolve(this._parseDshowDeviceList(stderr));
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

  _parseDshowDeviceList(stderr) {
    const lines = stderr.split('\n');
    const videos = [];
    let inVideoSection = false;
    let lastDeviceIndex = -1;

    for (const line of lines) {
      // Section headers tell us whether following names are video or audio
      if (/DirectShow video devices/i.test(line)) {
        inVideoSection = true;
        continue;
      }
      if (/DirectShow audio devices/i.test(line)) {
        inVideoSection = false;
        continue;
      }
      if (!inVideoSection) continue;

      // A primary device line looks like:
      //   [dshow @ 000...]  "HP TrueVision HD"
      // An alternative-name line looks like:
      //   [dshow @ 000...]     Alternative name "@device_pnp_\\?\usb#..."
      const primary = line.match(/"([^"]+)"\s*$/);
      const isAltName = /Alternative name/i.test(line);

      if (primary && !isAltName) {
        videos.push({ name: primary[1], alternativeName: null });
        lastDeviceIndex = videos.length - 1;
      } else if (primary && isAltName && lastDeviceIndex >= 0) {
        videos[lastDeviceIndex].alternativeName = primary[1];
      }
    }
    return videos;
  }

  // ─── RTMP Streaming ───────────────────────────────────
  async startStream(settings) {
    if (this.streamProcess) throw new Error('Stream already running');

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

    const {
      streamUrl, streamKey, videoBitrate,
      audioBitrate, resolution, fps,
    } = settings;

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

    // Strip trailing slash so we never get double-slash in RTMP URL
    const baseUrl = (streamUrl || '').replace(/\/+$/, '');
    const rtmpUrl = streamKey ? `${baseUrl}/${streamKey}` : baseUrl;

    // Only use dshow audio if a non-empty device name is configured
    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    // Collect stderr for error reporting — last 3KB is enough
    let stderrBuf = '';

    // Build FFmpeg args for RTMP streaming
    const args = [
      // Video input — branches on settings.videoSource: 'webcam' uses
      // dshow with the named device, 'screen' (or any other value,
      // including legacy undefined from pre-v3.3.4 settings) uses
      // gdigrab for full-desktop screen capture.
      ...this._videoInputArgs(settings, fps),

      // Audio input: use configured dshow device, or silent fallback
      ...(useAudio
        ? ['-f', 'dshow', '-i', `audio=${settings.audioDevice}`]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),

      // Video encoding with auto-detected encoder + per-encoder args
      ...this._videoEncodeArgs(encoder, videoBitrate, fps, resolution),

      // Audio encoding
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-ar', '44100',

      // Output
      '-f', 'flv',
      '-flvflags', 'no_duration_filesize',
      rtmpUrl,
    ];

    console.log('[StreamEngine] Starting stream to:', rtmpUrl);
    console.log('[StreamEngine] FFmpeg path:', this.ffmpegPath);
    console.log('[StreamEngine] Args:', args.join(' '));

    this.streamProcess = spawn(this.ffmpegPath, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.status.streaming = true;
    this.status.streamUptime = 0;
    this.status.errorReason = null;
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

      // Extract meaningful error from stderr when FFmpeg exits unexpectedly
      let errorReason = null;
      let logPath = null;
      if (code !== 0 && code !== null && stderrBuf) {
        // Pull the last error line from FFmpeg stderr
        const lines = stderrBuf.split('\n').filter(l => l.trim());
        const errorLine = lines.reverse().find(l =>
          /error|failed|invalid|refused|not found|cannot|unable|no such/i.test(l)
        );
        errorReason = errorLine
          ? errorLine.replace(/^\d{4}-\d{2}-\d{2}.*?error:/i, '').trim()
          : `FFmpeg exited with code ${code}`;

        // Detect the specific "EINVAL masquerading as output error" pattern
        // and surface a more actionable hint to the renderer.
        const hint = this._diagnosticHint(stderrBuf);
        if (hint) errorReason = `${errorReason}\n\n${hint}`;

        // Write full log to disk so the user can share it when reporting
        logPath = this._writeStreamLog({
          mode: 'stream',
          args,
          rtmpUrl,
          streamKey: settings.streamKey, // will be redacted by _writeStreamLog
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
    });

    this.streamProcess.on('error', (err) => {
      console.error('[StreamEngine] Spawn error:', err);
      this.status.streaming = false;
      this.status.errorReason = err.message;
      this.emit('status', { ...this.status });
      this.streamProcess = null;
    });

    this.emit('status', { ...this.status });
    return true;
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
    if (/invalid argument/i.test(stderr) && /output/i.test(stderr)) {
      return 'Hint: "Invalid argument" on output is often caused by an input or encoder setup failure. Check the full log for lines before this one to see which component failed to initialize.';
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

      // Redact the stream key everywhere it appears
      const keyPattern = ctx.streamKey && ctx.streamKey.length > 3
        ? new RegExp(ctx.streamKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')
        : null;
      const redact = (s) => keyPattern ? s.replace(keyPattern, '<REDACTED_KEY>') : s;

      const body = [
        `# Apex Revenue — ${ctx.mode} log`,
        `# Generated: ${new Date().toISOString()}`,
        `# App version: ${(app && app.getVersion && app.getVersion()) || 'unknown'}`,
        `# Exit code: ${ctx.exitCode}`,
        `# Detected error: ${ctx.errorLine || '(none)'}`,
        '',
        '─── FFmpeg invocation ───',
        `Binary: ${this.ffmpegPath}`,
        ctx.rtmpUrl ? `RTMP URL: ${redact(ctx.rtmpUrl)}` : '',
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
    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    const args = [
      ...this._videoInputArgs(settings, fps),
      ...(useAudio
        ? ['-f', 'dshow', '-i', `audio=${settings.audioDevice}`]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
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
