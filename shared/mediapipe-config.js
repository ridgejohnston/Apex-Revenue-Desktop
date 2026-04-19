/**
 * Apex Revenue — MediaPipe installer configuration
 *
 * Single source of truth for S3 URLs, asset filenames, and protocol
 * constants used by the installer (main process) and the renderer.
 *
 * The installer fetches a small manifest.json from S3 first, then the
 * five asset files referenced in it. Bundling the manifest separately
 * lets us rev the asset set without shipping a new app binary — when
 * MediaPipe releases an updated WASM, we bump `version` in the manifest
 * and existing installs will redownload next time the user clicks
 * Install / Reinstall.
 *
 * Asset set (what MediaPipe Tasks Vision needs at runtime):
 *   wasm/vision_wasm_internal.js
 *   wasm/vision_wasm_internal.wasm
 *   wasm/vision_wasm_nosimd_internal.js
 *   wasm/vision_wasm_nosimd_internal.wasm
 *   models/selfie_segmenter.tflite
 *
 * S3 layout (under MEDIAPIPE_S3_BASE):
 *   mediapipe/v1/manifest.json
 *   mediapipe/v1/wasm/<files>
 *   mediapipe/v1/models/<files>
 *
 * On install, files are written to userData/mediapipe/assets/ preserving
 * the same relative-path layout, then served to the renderer over the
 * custom apex-mp:// protocol.
 */

// ─── S3 bucket / path ────────────────────────────────────
// TODO before first release: point this at the actual bucket after
// assets are uploaded. The S3 object needs public-read ACL (or be
// fronted by CloudFront). The bucket should enable CORS — a permissive
// policy is fine since the files are public:
//   AllowedMethods: GET, HEAD
//   AllowedOrigins: *
//   AllowedHeaders: *
const MEDIAPIPE_S3_BASE =
  'https://apexrevenue-downloads.s3.us-east-1.amazonaws.com/mediapipe/v1';

const MEDIAPIPE_MANIFEST_URL = `${MEDIAPIPE_S3_BASE}/manifest.json`;

// Relative paths that appear in the manifest's files[].path field.
// The installer downloads each of these into userData/mediapipe/assets/
// at the same relative path, and the custom protocol serves them back.
const MEDIAPIPE_REQUIRED_FILES = Object.freeze([
  'wasm/vision_wasm_internal.js',
  'wasm/vision_wasm_internal.wasm',
  'wasm/vision_wasm_nosimd_internal.js',
  'wasm/vision_wasm_nosimd_internal.wasm',
  'models/selfie_segmenter.tflite',
]);

// Custom protocol used to serve downloaded assets to the renderer.
// MediaPipe's FilesetResolver.forVisionTasks() gets pointed at
// `apex-mp://wasm/` instead of the jsdelivr CDN URL.
const MEDIAPIPE_PROTOCOL = 'apex-mp';
const MEDIAPIPE_WASM_BASE = `${MEDIAPIPE_PROTOCOL}://wasm/`;
const MEDIAPIPE_MODEL_URL = `${MEDIAPIPE_PROTOCOL}://models/selfie_segmenter.tflite`;

module.exports = {
  MEDIAPIPE_S3_BASE,
  MEDIAPIPE_MANIFEST_URL,
  MEDIAPIPE_REQUIRED_FILES,
  MEDIAPIPE_PROTOCOL,
  MEDIAPIPE_WASM_BASE,
  MEDIAPIPE_MODEL_URL,
};
