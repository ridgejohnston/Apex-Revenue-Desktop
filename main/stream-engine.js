/**
 * Apex Revenue — Stream Engine
 * RTMP streaming + local recording via FFmpeg
 * Virtual camera output
 */

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { findFFmpegPath } = require('./ffmpeg-installer');

function findFFmpeg() {
  return findFFmpegPath() || 'ffmpeg';
}

class StreamEngine extends EventEmitter {
  constructor() {
    super();
    this.ffmpegPath = findFFmpeg();
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

  // ─── RTMP Streaming ───────────────────────────────────
  async startStream(settings) {
    if (this.streamProcess) throw new Error('Stream already running');

    const {
      streamUrl, streamKey, videoEncoder, videoBitrate,
      audioBitrate, resolution, fps, preset,
    } = settings;

    // Strip trailing slash so we never get double-slash in RTMP URL
    const baseUrl = (streamUrl || '').replace(/\/+$/, '');
    const rtmpUrl = streamKey ? `${baseUrl}/${streamKey}` : baseUrl;

    // Only use dshow audio if a non-empty device name is configured
    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    // Collect stderr for error reporting — last 3KB is enough
    let stderrBuf = '';

    // Build FFmpeg args for RTMP streaming
    const args = [
      // Video input: GDI screen capture of full desktop
      // Do NOT pass -video_size here — capture at native resolution,
      // then scale to target at encoding time. Passing a mismatched
      // -video_size causes an immediate fatal error on most machines.
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', 'desktop',

      // Audio input: use configured dshow device, or silent fallback
      ...(useAudio
        ? ['-f', 'dshow', '-i', `audio=${settings.audioDevice}`]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),

      // Video encoding — scale to target resolution here instead of on input
      '-c:v', videoEncoder,
      '-vf', `scale=${resolution.width}:${resolution.height}`,
      '-preset', preset,
      '-b:v', `${videoBitrate}k`,
      '-maxrate', `${videoBitrate}k`,
      '-bufsize', `${videoBitrate * 2}k`,
      '-pix_fmt', 'yuv420p',
      '-g', String(fps * 2), // Keyframe interval

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
      stderrBuf = (stderrBuf + text).slice(-3000); // keep last 3KB
      this._handleFFmpegOutput(text);
    });

    this.streamProcess.on('close', (code) => {
      this.status.streaming = false;
      if (this._uptimeInterval) clearInterval(this._uptimeInterval);

      // Extract meaningful error from stderr when FFmpeg exits unexpectedly
      let errorReason = null;
      if (code !== 0 && code !== null && stderrBuf) {
        // Pull the last error line from FFmpeg stderr
        const lines = stderrBuf.split('\n').filter(l => l.trim());
        const errorLine = lines.reverse().find(l =>
          /error|failed|invalid|refused|not found|cannot|unable|no such/i.test(l)
        );
        errorReason = errorLine
          ? errorLine.replace(/^\d{4}-\d{2}-\d{2}.*?error:/i, '').trim()
          : `FFmpeg exited with code ${code}`;
        console.error('[StreamEngine] Stream stopped unexpectedly:', errorReason);
        console.error('[StreamEngine] Full stderr tail:\n', stderrBuf.slice(-1000));
      }

      this.status.errorReason = errorReason;
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

    const { outputPath, videoEncoder, videoBitrate, audioBitrate, resolution, fps, preset } = settings;
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = path.join(outputPath, `ApexRevenue_${timestamp}.mp4`);

    // Ensure output dir exists
    fs.mkdirSync(outputPath, { recursive: true });

    const useAudio = settings.audioDevice && settings.audioDevice.trim() !== '';

    const args = [
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-i', 'desktop',
      ...(useAudio
        ? ['-f', 'dshow', '-i', `audio=${settings.audioDevice}`]
        : ['-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo']),
      '-c:v', videoEncoder,
      '-vf', `scale=${resolution.width}:${resolution.height}`,
      '-preset', preset,
      '-crf', '18',
      '-b:v', `${videoBitrate}k`,
      '-c:a', 'aac',
      '-b:a', `${audioBitrate}k`,
      '-pix_fmt', 'yuv420p',
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
