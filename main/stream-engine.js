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

// H.264 encoder preference order — first one found in the FFmpeg binary wins.
// h264_mf is Windows Media Foundation (always available on Win10+), so it is
// the guaranteed fallback when no other encoder is compiled in.
const H264_ENCODER_CANDIDATES = ['libx264', 'h264_nvenc', 'h264_amf', 'h264_mf'];

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
  // Probes `ffmpeg -encoders` once, caches the full list of available
  // H.264 encoders, and returns the user's preferred encoder when it's
  // actually available. Falls back to the best hardware-first option,
  // then finally to h264_mf (bundled with every Windows 10+ FFmpeg).
  //
  // `preferred` is the settings.videoEncoder string from the UI — passing
  // it through here is what makes the UI selector actually drive the
  // stream. Previously this method ignored settings and auto-picked.
  _detectH264Encoder(preferred) {
    // Probe + cache the available list once per engine instance.
    if (!this._availableH264Encoders) {
      try {
        const out = execFileSync(this.ffmpegPath, ['-encoders', '-v', 'quiet'], {
          timeout: 8000,
          windowsHide: true,
        }).toString();
        this._availableH264Encoders = H264_ENCODER_CANDIDATES.filter(
          (enc) => out.includes(` ${enc} `)
        );
        console.log('[StreamEngine] Available H.264 encoders:', this._availableH264Encoders);
      } catch (e) {
        console.warn('[StreamEngine] Could not query encoders:', e.message);
        this._availableH264Encoders = [];
      }
    }

    // Honor the user's preference when it's actually compiled into this
    // FFmpeg build. If they picked libx264 on a bundle that has it
    // disabled (our standard S3 bundle does), fall through to auto-pick
    // rather than spawning a doomed ffmpeg call.
    if (preferred && this._availableH264Encoders.includes(preferred)) {
      return preferred;
    }
    if (preferred) {
      console.warn(`[StreamEngine] Preferred encoder "${preferred}" unavailable in this FFmpeg build — auto-selecting from ${this._availableH264Encoders.join(', ') || 'none'}`);
    }

    // Auto-select: first available from the priority order, then mf as last resort
    if (this._availableH264Encoders.length > 0) {
      return this._availableH264Encoders[0];
    }
    console.warn('[StreamEngine] Falling back to h264_mf encoder');
    return 'h264_mf';
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
    // when it's available in this FFmpeg build, otherwise auto-pick.
    const encoder = this._detectH264Encoder(settings.videoEncoder);

    // Strip trailing slash so we never get double-slash in RTMP URL
    const baseUrl = (streamUrl || '').replace(/\/+$/, '');
    const rtmpUrl = streamKey ? `${baseUrl}/${streamKey}` : baseUrl;

    // Only use dshow audio if a non-empty device name is configured
    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    // Collect stderr for error reporting — last 3KB is enough
    let stderrBuf = '';

    // Build FFmpeg args for RTMP streaming
    const args = [
      // Video input: GDI screen capture of full desktop at native resolution
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', 'desktop',

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

    // Encoder preset rejection — each H.264 encoder has its own preset
    // vocabulary (x264 uses 'veryfast', NVENC uses 'p1'-'p7', etc.). When
    // _videoEncodeArgs sends the wrong one, FFmpeg fails setup with
    // 'Unable to parse "preset"' + 'Error applying encoder options'.
    if (/unable to parse ["']?preset["']?/i.test(stderr) ||
        /error applying encoder options/i.test(stderr)) {
      return 'Hint: the selected encoder rejected the configured preset. Each H.264 encoder uses its own preset names (x264 → veryfast/fast/medium, NVENC → p1-p7, AMF/MF → no presets). Try a different encoder in Settings > OBS.';
    }

    if (/gdigrab.*?(could not|cannot|failed|error)/i.test(stderr) ||
        /couldn\'?t capture image/i.test(stderr)) {
      return 'Hint: gdigrab (screen capture) failed to initialize. Check that you have an active desktop session (not locked/RDP), and that display scaling is set to 100%.';
    }
    if (/dshow.*?(could not|cannot|not found|no such)/i.test(stderr)) {
      return 'Hint: the configured audio input device (dshow) was not found. Pick a different microphone in Settings > OBS, or set it to "None" to stream with silent audio.';
    }
    if (/unknown encoder|encoder not found/i.test(stderr)) {
      return 'Hint: the selected video encoder is not available in this FFmpeg build. Try switching to the default "x264 (CPU)" encoder in Settings > OBS.';
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
    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    const args = [
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', 'desktop',
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
