/**
 * Apex Revenue — FFmpeg Installer
 * Downloads FFmpeg bundle from AWS S3 on first launch if not present.
 * Saves to app.getPath('userData')/ffmpeg/
 */

const path = require('path');
const fs = require('fs');
const https = require('https');
const { app } = require('electron');

const S3_BUNDLE_URL =
  'https://apex-revenue-downloads.s3.us-east-1.amazonaws.com/ffmpeg/ffmpeg-bundle.zip';

const FFMPEG_COMMON_PATHS = [
  'C:\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
  'C:\\Program Files (x86)\\ffmpeg\\bin\\ffmpeg.exe',
];

function getUserDataFFmpegDir() {
  return path.join(app.getPath('userData'), 'ffmpeg');
}

function getUserDataFFmpegExe() {
  return path.join(getUserDataFFmpegDir(), 'ffmpeg.exe');
}

/**
 * Returns the FFmpeg executable path if found, or null.
 */
function findFFmpegPath() {
  // 1. bundled in extraResources (packaged app)
  try {
    const bundled = path.join(process.resourcesPath || '', 'ffmpeg', 'ffmpeg.exe');
    if (fs.existsSync(bundled)) return bundled;
  } catch {}

  // 2. userData (downloaded by this installer)
  const userDataExe = getUserDataFFmpegExe();
  if (fs.existsSync(userDataExe)) return userDataExe;

  // 3. common Windows install locations
  for (const p of FFMPEG_COMMON_PATHS) {
    if (fs.existsSync(p)) return p;
  }

  // 4. system PATH — use Windows `where.exe` to honor the user's PATH setup.
  // Some users install FFmpeg to non-standard directories or via package
  // managers (Chocolatey, Scoop, winget) that put it somewhere PATH-only.
  // Cached after first successful lookup so we don't pay the ~20ms on
  // every stream/record start.
  if (_cachedPathLookup !== undefined) return _cachedPathLookup;
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('where.exe', ['ffmpeg.exe'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    const firstHit = (out || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (firstHit && fs.existsSync(firstHit)) {
      _cachedPathLookup = firstHit;
      return firstHit;
    }
  } catch {
    // where.exe returns non-zero when not found — cache the negative
  }
  _cachedPathLookup = null;
  return null;
}

// Cached result of the PATH lookup (undefined = not yet probed).
let _cachedPathLookup;

/**
 * Returns true if FFmpeg is available on this machine.
 */
function isFFmpegInstalled() {
  return findFFmpegPath() !== null;
}

/**
 * Downloads the FFmpeg bundle zip from S3, extracts it to userData/ffmpeg/,
 * and returns the path to ffmpeg.exe.
 *
 * @param {(progress: { percent: number, receivedBytes: number, totalBytes: number }) => void} onProgress
 * @returns {Promise<string>} path to ffmpeg.exe
 */
async function downloadAndInstallFFmpeg(onProgress) {
  const destDir = getUserDataFFmpegDir();
  const zipPath = path.join(destDir, 'ffmpeg-bundle.zip');

  fs.mkdirSync(destDir, { recursive: true });

  // ── Download zip ──────────────────────────────────────────
  await new Promise((resolve, reject) => {
    const doRequest = (url) => {
      https.get(url, (res) => {
        // Follow redirect
        if (res.statusCode === 301 || res.statusCode === 302) {
          return doRequest(res.headers.location);
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} downloading FFmpeg`));
        }

        const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
        let receivedBytes = 0;

        const writeStream = fs.createWriteStream(zipPath);

        res.on('data', (chunk) => {
          receivedBytes += chunk.length;
          if (onProgress && totalBytes > 0) {
            onProgress({
              percent: Math.round((receivedBytes / totalBytes) * 100),
              receivedBytes,
              totalBytes,
            });
          }
        });

        res.pipe(writeStream);

        writeStream.on('finish', () => {
          writeStream.close();
          resolve();
        });
        writeStream.on('error', reject);
        res.on('error', reject);
      }).on('error', reject);
    };

    doRequest(S3_BUNDLE_URL);
  });

  // ── Extract zip ────────────────────────────────────────────
  // Use Node.js built-in zlib + tar or fall back to PowerShell on Windows
  await extractZip(zipPath, destDir);

  // Clean up zip
  try { fs.unlinkSync(zipPath); } catch {}

  const exePath = getUserDataFFmpegExe();
  if (!fs.existsSync(exePath)) {
    throw new Error('FFmpeg extraction completed but ffmpeg.exe not found at expected path.');
  }

  // Invalidate the PATH-lookup cache so a subsequent findFFmpegPath()
  // call picks up the newly installed binary instead of returning the
  // stale "not found" result from before the install.
  _cachedPathLookup = undefined;

  return exePath;
}

/**
 * Extracts a zip file using PowerShell (always available on Windows 10+).
 */
function extractZip(zipPath, destDir) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const ps = spawn('powershell.exe', [
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`,
    ], { windowsHide: true });

    let stderr = '';
    ps.stderr.on('data', (d) => { stderr += d.toString(); });

    ps.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`PowerShell extraction failed (code ${code}): ${stderr}`));
      }
    });

    ps.on('error', reject);
  });
}

module.exports = {
  findFFmpegPath,
  isFFmpegInstalled,
  downloadAndInstallFFmpeg,
  getUserDataFFmpegDir,
};
