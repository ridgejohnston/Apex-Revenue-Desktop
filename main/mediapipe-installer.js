/**
 * Apex Revenue — MediaPipe Installer (main-process module)
 *
 * Manages the lifecycle of the MediaPipe WASM + model asset bundle:
 *
 *   1. `getStatus()` — quickly report install state (installed? version?
 *      total bytes? timestamp?) for the renderer to paint the UI.
 *   2. `install({ onProgress })` — fetch the manifest from S3, then each
 *      asset file in parallel, verify each against the manifest's
 *      sha256, write atomically into `userData/mediapipe/assets/`,
 *      commit status.json. Streams progress events so the renderer can
 *      show a progress bar.
 *   3. `uninstall()` — delete the assets directory and clear status.
 *   4. `registerProtocol()` — register the `apex-mp://` scheme and
 *      serve downloaded files from the assets directory. Must be
 *      called after app.whenReady() because protocol.handle requires it.
 *
 * Design choices:
 *   • Files download in parallel. Total payload is ~5 MB; serializing
 *     would waste user time on typical broadband. Progress events are
 *     aggregated (bytesDownloaded / totalBytes across all files).
 *   • sha256 verification happens on each file individually — a partial
 *     install is still invalid, so the UI only marks installed after
 *     status.json is committed. If verification fails on any file the
 *     whole install rolls back.
 *   • Writes go to a tmp directory first, then atomically renamed to
 *     `assets/` on success. Mid-install process kill leaves the old
 *     install intact (or absent), never half-applied.
 *   • Status file schema is forward-compatible: future fields can be
 *     added without breaking existing installs.
 */

const { app, net, protocol } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  MEDIAPIPE_MANIFEST_URL,
  MEDIAPIPE_REQUIRED_FILES,
  MEDIAPIPE_PROTOCOL,
} = require('../shared/mediapipe-config');

// ─── Paths ───────────────────────────────────────────────
function getPaths() {
  const root = path.join(app.getPath('userData'), 'mediapipe');
  return {
    root,
    assetsDir:    path.join(root, 'assets'),
    tmpDir:       path.join(root, 'assets.tmp'),
    statusFile:   path.join(root, 'status.json'),
  };
}

// ─── Status ──────────────────────────────────────────────
//
// Status file shape:
//   {
//     installed:   true,
//     version:     "1",           // from manifest.version
//     totalBytes:  5242880,
//     installedAt: "2026-04-18T…",
//     files:       [ "wasm/…", "models/…" ]
//   }
async function getStatus() {
  const { statusFile, assetsDir } = getPaths();
  try {
    const raw = await fs.promises.readFile(statusFile, 'utf8');
    const parsed = JSON.parse(raw);
    // Verify all advertised files are actually on disk. If any went
    // missing (user cleared the folder, antivirus quarantine, …) we
    // report as uninstalled so the UI prompts the user to reinstall.
    for (const rel of parsed.files || MEDIAPIPE_REQUIRED_FILES) {
      if (!fs.existsSync(path.join(assetsDir, rel))) {
        return { installed: false, reason: 'missing-files' };
      }
    }
    return { installed: true, ...parsed };
  } catch {
    return { installed: false };
  }
}

// ─── Download + verify a single file ─────────────────────
function download(url, destPath, expectedSha256, onChunk) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'GET', url });
    const chunks = [];
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    req.on('response', (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        return;
      }
      res.on('data', (chunk) => {
        chunks.push(chunk);
        hash.update(chunk);
        bytes += chunk.length;
        onChunk?.(chunk.length);
      });
      res.on('end', () => {
        const actual = hash.digest('hex');
        if (expectedSha256 && actual.toLowerCase() !== expectedSha256.toLowerCase()) {
          reject(new Error(`sha256 mismatch for ${url}: expected ${expectedSha256}, got ${actual}`));
          return;
        }
        fs.promises
          .mkdir(path.dirname(destPath), { recursive: true })
          .then(() => fs.promises.writeFile(destPath, Buffer.concat(chunks)))
          .then(() => resolve({ bytes, sha256: actual }))
          .catch(reject);
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Install ─────────────────────────────────────────────
//
// onProgress({ phase, bytesDownloaded, totalBytes, message? })
//   phase: 'manifest' | 'assets' | 'verify' | 'finalize' | 'done' | 'error'
//
// Returns status object on success, throws on failure.
async function install({ onProgress } = {}) {
  const p = getPaths();
  await fs.promises.mkdir(p.root, { recursive: true });
  // Always start from a clean tmp so a retry after partial failure
  // doesn't mix old bytes with new
  await fs.promises.rm(p.tmpDir, { recursive: true, force: true });
  await fs.promises.mkdir(p.tmpDir, { recursive: true });

  onProgress?.({ phase: 'manifest', bytesDownloaded: 0, totalBytes: 0 });

  // 1. Fetch manifest
  let manifest;
  try {
    const res = await net.fetch(MEDIAPIPE_MANIFEST_URL);
    if (!res.ok) throw new Error(`manifest HTTP ${res.status}`);
    manifest = await res.json();
  } catch (err) {
    onProgress?.({ phase: 'error', message: `manifest fetch failed: ${err.message}` });
    throw err;
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    const e = new Error('manifest has no files');
    onProgress?.({ phase: 'error', message: e.message });
    throw e;
  }

  // Sanity: every required file must appear in the manifest
  for (const required of MEDIAPIPE_REQUIRED_FILES) {
    if (!manifest.files.find((f) => f.path === required)) {
      const e = new Error(`manifest missing required file: ${required}`);
      onProgress?.({ phase: 'error', message: e.message });
      throw e;
    }
  }

  const totalBytes = manifest.files.reduce((s, f) => s + (f.bytes || 0), 0);
  let downloaded = 0;
  const emitProgress = () =>
    onProgress?.({ phase: 'assets', bytesDownloaded: downloaded, totalBytes });
  emitProgress();

  // 2. Download all files in parallel
  try {
    await Promise.all(manifest.files.map(async (entry) => {
      const srcUrl = entry.url || `${MEDIAPIPE_MANIFEST_URL.replace(/\/manifest\.json$/, '')}/${entry.path}`;
      const destPath = path.join(p.tmpDir, entry.path);
      await download(srcUrl, destPath, entry.sha256, (n) => {
        downloaded += n;
        emitProgress();
      });
    }));
  } catch (err) {
    await fs.promises.rm(p.tmpDir, { recursive: true, force: true }).catch(() => {});
    onProgress?.({ phase: 'error', message: err.message });
    throw err;
  }

  onProgress?.({ phase: 'finalize', bytesDownloaded: downloaded, totalBytes });

  // 3. Swap tmp → assets atomically (best-effort)
  try {
    // Remove any previous install, then rename tmp
    await fs.promises.rm(p.assetsDir, { recursive: true, force: true });
    await fs.promises.rename(p.tmpDir, p.assetsDir);
  } catch (err) {
    // Fallback: copy if rename across volumes fails
    try { await copyDir(p.tmpDir, p.assetsDir); }
    catch (e2) {
      await fs.promises.rm(p.tmpDir, { recursive: true, force: true }).catch(() => {});
      onProgress?.({ phase: 'error', message: `swap failed: ${err.message}` });
      throw err;
    }
    await fs.promises.rm(p.tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  // 4. Commit status
  const status = {
    installed: true,
    version: manifest.version || '1',
    totalBytes,
    installedAt: new Date().toISOString(),
    files: manifest.files.map((f) => f.path),
  };
  await fs.promises.writeFile(p.statusFile, JSON.stringify(status, null, 2), 'utf8');

  onProgress?.({ phase: 'done', bytesDownloaded: downloaded, totalBytes });
  return status;
}

async function copyDir(src, dst) {
  await fs.promises.mkdir(dst, { recursive: true });
  const entries = await fs.promises.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.promises.copyFile(s, d);
  }
}

// ─── Uninstall ───────────────────────────────────────────
async function uninstall() {
  const p = getPaths();
  await fs.promises.rm(p.assetsDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(p.tmpDir,    { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(p.statusFile, { force: true }).catch(() => {});
  return { installed: false };
}

// ─── Protocol registration ───────────────────────────────
// Must be called after app.whenReady(). Serves files from the assets
// directory over the apex-mp:// scheme with correct MIME types so
// WebAssembly.instantiateStreaming accepts them.
function registerProtocol() {
  const { assetsDir } = getPaths();
  protocol.handle(MEDIAPIPE_PROTOCOL, async (req) => {
    try {
      const url = new URL(req.url);
      // apex-mp://wasm/file.wasm → hostname='wasm', pathname='/file.wasm'
      const rel = decodeURIComponent(
        path.posix.join(url.hostname || '', url.pathname.replace(/^\/+/, ''))
      );
      // Guard against traversal — rel must stay inside assetsDir
      const abs = path.resolve(assetsDir, rel);
      if (!abs.startsWith(path.resolve(assetsDir))) {
        return new Response('Forbidden', { status: 403 });
      }
      if (!fs.existsSync(abs)) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(abs).toLowerCase();
      const contentType = {
        '.wasm':   'application/wasm',
        '.js':     'application/javascript',
        '.json':   'application/json',
        '.tflite': 'application/octet-stream',
      }[ext] || 'application/octet-stream';
      const data = await fs.promises.readFile(abs);
      return new Response(data, {
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Cross-Origin-Resource-Policy': 'cross-origin',
        },
      });
    } catch (err) {
      return new Response(`Error: ${err.message}`, { status: 500 });
    }
  });
}

module.exports = {
  getStatus,
  install,
  uninstall,
  registerProtocol,
  getPaths,
};
