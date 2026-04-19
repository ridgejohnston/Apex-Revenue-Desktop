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
      const base = String(d.url || '').replace(/\/+$/, '');
      const key = String(d.key || '');
      return {
        name: d.name || d.platform || 'Destination',
        url: base,
        key,
        fullUrl: key ? `${base}/${key}` : base,
      };
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

    return resolved.map(normalize);
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
      videoBitrate, audioBitrate, resolution, fps,
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

    // Build FFmpeg args for RTMP streaming
    const args = [
      ...videoInputArgs,

      // Audio input: dshow with configured device, or silent lavfi
      // fallback when no device is configured. Device name is
      // sanitized (browser prefix stripped).
      ...this._audioInputArgs(settings),

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

    const resolvedPath = findFFmpegPath();
    if (!resolvedPath) {
      const err = new Error('FFmpeg is not installed. Open Settings -> Streaming and click "Install FFmpeg".');
      err.code = 'FFMPEG_NOT_INSTALLED';
      throw err;
    }
    this.ffmpegPath = resolvedPath;

    const {
      videoBitrate, audioBitrate, resolution, fps,
    } = settings;

    const encoder = this._detectH264Encoder(settings.videoEncoder);
    if (settings.videoEncoder && encoder !== settings.videoEncoder) {
      this.emit('encoder-auto-changed', {
        requested: settings.videoEncoder,
        resolved: encoder,
        reason: `"${settings.videoEncoder}" is not usable on this machine. Falling back to "${encoder}".`,
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
    this._diag(`encoder: ${encoder}`);
    this._diag(`bitrate: ${videoBitrate}k video / ${audioBitrate}k audio`);
    this._diag(`resolution: ${resolution} @ ${fps} fps`);

    // Audio input args — same sanitizer as the direct path. dshow for
    // a real device, lavfi silence as fallback.
    const audioInputArgs = this._audioInputArgs(settings);
    const audioFromSeparateInput = audioInputArgs[0] === '-f' && audioInputArgs[1] === 'dshow';
    this._diag(`audio source: ${audioFromSeparateInput ? 'dshow mic (input 1)' : 'silent lavfi'}`);

    // Build full args array
    const args = [
      // Video input: matroska/webm from stdin
      '-f', 'matroska',
      '-i', 'pipe:0',

      // Audio input (dshow device or anullsrc)
      ...audioInputArgs,

      // Explicit mapping: video from pipe (input 0), audio from input 1
      '-map', '0:v:0',
      '-map', '1:a:0',

      // Video encode — re-use per-encoder args from the direct path
      ...this._videoEncodeArgs(encoder, videoBitrate, fps, resolution),

      // Audio encode
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
        const lines = stderrBuf.split('\n').filter((l) => l.trim());
        const errorLine = lines.reverse().find((l) =>
          /error|failed|invalid|refused|not found|cannot|unable|no such/i.test(l)
        );
        errorReason = errorLine
          ? errorLine.replace(/^\d{4}-\d{2}-\d{2}.*?error:/i, '').trim()
          : `FFmpeg exited with code ${code}`;

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
    const args = [
      ...videoInputArgs,
      ...this._audioInputArgs(settings),
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
