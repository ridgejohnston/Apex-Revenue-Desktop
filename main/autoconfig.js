// ─── Apex Revenue — OBS Settings Autoconfig ─────────────────
//
// Probes the user's computer for sensible streaming defaults:
//   • available H.264 encoders (via `ffmpeg -encoders` compile-time,
//     THEN a runtime probe that actually tries to open each encoder —
//     see detectAvailableEncoders for why both phases matter)
//   • primary display resolution (capped at 1080p for stream sanity)
//   • reasonable bitrate tiers for the detected resolution/encoder
//
// Runs once on first app launch, or on-demand via the "Auto-detect"
// button in the OBS settings panel. User-edited settings always take
// precedence on subsequent launches — see the _autoconfiguredAt guard
// in main.js.

const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

// Preference order for picking the default encoder when multiple are
// usable. Hardware encoders first (zero CPU cost, preserves headroom
// for other app work), then Cisco's OpenH264 as the reliable software
// fallback (compiled into our bundled FFmpeg, runs anywhere), then x264
// (only present if the user has a non-bundled FFmpeg on their PATH), and
// Windows Media Foundation as an absolute last resort.
const ENCODER_PREFERENCE = [
  'h264_nvenc',
  'h264_qsv',
  'h264_amf',
  'libopenh264',
  'libx264',
  'h264_mf',
];

const ENCODER_LABELS = {
  h264_nvenc:  'NVIDIA NVENC',
  h264_qsv:    'Intel QuickSync',
  h264_amf:    'AMD AMF',
  libopenh264: 'OpenH264 (Software)',
  libx264:     'x264 (Software)',
  h264_mf:     'Windows Media Foundation',
};

// Preset args each encoder needs during the runtime probe. Must match
// _presetArgsFor in stream-engine.js — if we probe with the wrong preset
// we'd get a false negative (e.g. NVENC rejects 'veryfast' as we saw in
// v3.2.4). Keeping a private copy here to avoid a circular require with
// the stream engine; the two lists are small and both behind code review.
function _probePresetArgs(encoder) {
  switch (encoder) {
    case 'libx264':    return ['-preset', 'veryfast'];
    case 'h264_nvenc': return ['-preset', 'p2'];
    case 'h264_qsv':   return ['-preset', 'veryfast'];
    case 'libopenh264':return ['-rc_mode', 'bitrate'];
    default:           return []; // amf, mf, unknown
  }
}

/**
 * Return the H.264 encoders that are both (a) compiled into the FFmpeg
 * binary AND (b) actually usable on this machine at runtime.
 *
 * The two-phase design exists because FFmpeg's -encoders output lists
 * encoders based on compile flags, not runtime dependencies. h264_nvenc
 * on a machine without NVIDIA drivers will show up in the list but fail
 * at stream time with "Cannot load nvcuda.dll". Same story for h264_amf
 * without AMD drivers and h264_qsv without Intel graphics.
 *
 * Runtime probing adds ~300-500ms per compiled encoder, but only runs
 * on first-launch autoconfig and on explicit "Auto-detect" clicks — the
 * results get cached by the caller.
 */
async function detectAvailableEncoders(ffmpegPath) {
  if (!ffmpegPath) return [];

  // Phase 1: compile-time listing
  let compiled = [];
  try {
    const { stdout } = await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    compiled = ENCODER_PREFERENCE.filter((enc) => {
      const re = new RegExp(`^\\s*V[\\w\\.]*\\s+${enc}\\s`, 'm');
      return re.test(stdout);
    });
  } catch {
    return [];
  }

  // Phase 2: runtime probe each compile-present encoder. Keep only the
  // ones that actually open on this specific hardware/driver config.
  const usable = [];
  for (const enc of compiled) {
    if (await probeEncoderRuntime(ffmpegPath, enc)) {
      usable.push(enc);
    }
  }
  return usable;
}

/**
 * Attempt a tiny test encode with the given encoder. Returns true if the
 * encoder opened cleanly (= usable on this machine), false otherwise.
 * We generate 0.05s of 128x72 null video and push through the encoder
 * to a null sink — just enough to force initialization. Any DLL/runtime
 * load failure (nvcuda.dll, amfrt, libvpl) surfaces as a non-zero exit.
 */
async function probeEncoderRuntime(ffmpegPath, encoder) {
  try {
    await execFileAsync(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'nullsrc=s=128x72:d=0.05',
      '-c:v', encoder,
      ..._probePresetArgs(encoder),
      '-t', '0.05',
      '-f', 'null', '-',
    ], {
      timeout: 5000, windowsHide: true, encoding: 'utf8',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Recommend a stream resolution based on the primary display.
 * Caps at 1080p — cam platforms encode at ≤1080p anyway, and downscaling
 * a 4K desktop capture at stream time wastes CPU/GPU cycles.
 */
function recommendResolution(screenModule) {
  try {
    const primary = screenModule.getPrimaryDisplay();
    const { width, height } = primary.size;
    const MAX_H = 1080;
    if (height <= MAX_H) {
      // Snap to common even dimensions (720, 900, 1080) for encoder friendliness
      return { width: Math.round(width / 2) * 2, height: Math.round(height / 2) * 2 };
    }
    const scale = MAX_H / height;
    return {
      width:  Math.round((width * scale) / 2) * 2,
      height: MAX_H,
    };
  } catch {
    return { width: 1920, height: 1080 };
  }
}

/**
 * Cam-platform-friendly bitrate targets. Chaturbate/Stripchat/etc. cap
 * their ingest around 4-5 Mbps for most tiers and throw away extra bits,
 * so we don't try to max out user upload pipes — we target the sweet spot.
 * Hardware encoders get slightly higher budgets because they handle the
 * extra bits for free (vs x264 burning CPU).
 */
function recommendBitrate(height, encoder) {
  const hardware = encoder !== 'libx264';
  if (height >= 1080) return hardware ? 4000 : 3500;
  if (height >= 720)  return hardware ? 2800 : 2500;
  if (height >= 480)  return 1400;
  return 1000;
}

/**
 * Produce a complete recommendation bundle. Shape:
 *   {
 *     recommendations: {...obsSettings subset to apply...},
 *     specs: {...diagnostic info about the detected machine...},
 *     encoderLabels: {...human-readable encoder names for the UI...}
 *   }
 *
 * Called by:
 *   • main.js on first launch (seed-and-save)
 *   • IPC handler 'obs-settings:detect' (re-run on user request)
 */
async function detectRecommendedObsSettings({ ffmpegPath, screenModule, videosPath }) {
  const availableEncoders = await detectAvailableEncoders(ffmpegPath);

  // Pick the first available encoder from our preference order.
  // If FFmpeg isn't installed yet (common on first launch — v3.2.3's
  // auto-install kicks in when the user hits Start Stream), we default
  // to libx264. If the bundled FFmpeg ends up without libx264 (our
  // standard bundle has --disable-libx264), the stream engine's runtime
  // detection will override this anyway.
  // Fallback encoder when nothing probed clean. libopenh264 is compiled
  // into our bundled FFmpeg (--enable-libopenh264) and runs anywhere,
  // so it's the reliable safety net. Earlier versions defaulted to
  // libx264 which is not in our bundle, which is how Ridge ended up with
  // an unusable NVENC setting when the probe couldn't run pre-install.
  const encoder = availableEncoders[0] || 'libopenh264';
  const resolution = recommendResolution(screenModule);
  const videoBitrate = recommendBitrate(resolution.height, encoder);

  const cpus = os.cpus();
  const specs = {
    cpuModel: (cpus[0]?.model || 'Unknown').trim().replace(/\s+/g, ' '),
    cpuCores: cpus.length,
    totalRamGb: Math.round(os.totalmem() / (1024 ** 3)),
    platform: `${os.platform()} ${os.release()}`,
    detectedEncoders: availableEncoders,
    ffmpegAvailable: availableEncoders.length > 0,
  };

  return {
    recommendations: {
      videoEncoder: encoder,
      videoBitrate,
      resolution,
      fps: 30, // 30 is the cam-platform sweet spot; bitrate stretches further
      preset: 'veryfast', // stream-engine's _presetArgsFor maps this per-encoder
      audioBitrate: 160,
      outputPath: videosPath,
    },
    specs,
    encoderLabels: ENCODER_LABELS,
  };
}

module.exports = {
  detectRecommendedObsSettings,
  detectAvailableEncoders,
  ENCODER_LABELS,
  ENCODER_PREFERENCE,
};
