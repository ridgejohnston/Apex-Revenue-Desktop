// ─── Apex Revenue — OBS Settings Autoconfig ─────────────────
//
// Probes the user's computer for sensible streaming defaults:
//   • available H.264 encoders (via `ffmpeg -encoders` — most reliable)
//   • primary display resolution (capped at 1080p for stream sanity)
//   • reasonable bitrate tiers for the detected resolution/encoder
//
// Runs once on first app launch, or on-demand via the "Auto-detect"
// button in the OBS settings panel. User-edited settings always take
// precedence on subsequent launches — see the _autoconfiguredAt guard
// in main.js.

const { execFile } = require('child_process');
const { promisify } = require('util');
const os = require('os');

const execFileAsync = promisify(execFile);

// Preference order for picking the default encoder when multiple are
// available. Hardware encoders first (far less CPU, more headroom for
// other app work), software x264 last.
const ENCODER_PREFERENCE = ['h264_nvenc', 'h264_qsv', 'h264_amf', 'libx264'];

const ENCODER_LABELS = {
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv:   'Intel QuickSync',
  h264_amf:   'AMD AMF',
  libx264:    'x264 (CPU)',
  h264_mf:    'Windows Media Foundation',
};

/**
 * Probe FFmpeg's compiled encoder list and return the H.264 encoders
 * actually available in this build. Returns [] if FFmpeg is missing or
 * the probe fails — callers should fall back to libx264 as a safe default.
 */
async function detectAvailableEncoders(ffmpegPath) {
  if (!ffmpegPath) return [];
  try {
    const { stdout } = await execFileAsync(
      ffmpegPath,
      ['-hide_banner', '-encoders'],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }
    );
    // FFmpeg output format: " V..... h264_nvenc           NVIDIA NVENC H.264 encoder ..."
    // First char block is encoder type flags; V = video. Match the encoder
    // name as a whole token to avoid spurious substring matches.
    return ENCODER_PREFERENCE.filter((enc) => {
      const re = new RegExp(`^\\s*V[\\w\\.]*\\s+${enc}\\s`, 'm');
      return re.test(stdout);
    });
  } catch {
    return [];
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
  const encoder = availableEncoders[0] || 'libx264';
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
