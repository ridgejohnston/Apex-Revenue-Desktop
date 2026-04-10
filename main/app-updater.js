// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — App Asset Updater (app.asar hot-swap from S3)
//
// How it works:
//   1. On launch: fetch version.json from S3
//   2. Compare sha256 with local app.asar
//   3. If different: download new app.asar → save as app.asar.update
//   4. On before-quit: write _apex_update.bat → batch renames file after exit
//   5. Next launch starts with fresh app.asar automatically
//
// S3 bucket: apex-revenue-app-994438967527 (public read)
//   app.asar      — live app code
//   version.json  — {"version":"1.0.0","sha256":"...","size":12345,"updatedAt":"..."}
// ═══════════════════════════════════════════════════════════════════════════════

const { app }       = require('electron');
const path          = require('path');
const fs            = require('fs');
const https         = require('https');
const crypto        = require('crypto');
const { spawn }     = require('child_process');

// ── Config ────────────────────────────────────────────────────────────────────
const APP_BUCKET_URL = 'https://apex-revenue-app-994438967527.s3.amazonaws.com';
const CHECK_DELAY    = 8_000;            // 8s after launch
const CHECK_INTERVAL = 2 * 60 * 60_000; // every 2 hours

// ── Paths ─────────────────────────────────────────────────────────────────────
const resourcesDir = process.resourcesPath;                       // …/resources/
const asarPath     = path.join(resourcesDir, 'app.asar');         // current
const asarUpdate   = path.join(resourcesDir, 'app.asar.update'); // pending
const asarBackup   = path.join(resourcesDir, 'app.asar.bak');    // backup
const updateBat    = path.join(resourcesDir, '_apex_update.bat');

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindowRef  = null;
let checkTimer     = null;
let pollInterval   = null;
let updatePending  = false;
let currentSha256  = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function initAppUpdater(mainWindow) {
  mainWindowRef = mainWindow;

  // Apply any pending update left from last run first
  applyPendingUpdate();

  // Compute current sha256 of running app.asar
  currentSha256 = hashFile(asarPath);
  console.log(`[AppUpdater] Running v${currentSha256?.slice(0,12)}…`);

  // Schedule checks
  checkTimer   = setTimeout(checkForUpdate, CHECK_DELAY);
  pollInterval = setInterval(checkForUpdate, CHECK_INTERVAL);

  // On quit: if update is waiting, schedule the bat-file swap
  app.on('before-quit', scheduleUpdateOnQuit);
}

// ── Apply a pending update from the PREVIOUS run ─────────────────────────────
// The batch file from last session may have already applied it, but in case
// the user force-killed the app, check for app.asar.update on startup.
function applyPendingUpdate() {
  if (!fs.existsSync(asarUpdate)) return;
  try {
    if (fs.existsSync(asarBackup)) fs.unlinkSync(asarBackup);
    fs.copyFileSync(asarPath, asarBackup);
    fs.renameSync(asarUpdate, asarPath);
    console.log('[AppUpdater] Applied pending update from previous session.');
  } catch (err) {
    console.warn('[AppUpdater] Could not apply pending update:', err.message);
  }
}

// ── Check S3 for a newer version ──────────────────────────────────────────────
async function checkForUpdate() {
  try {
    const info = await fetchJson(`${APP_BUCKET_URL}/version.json`);
    if (!info?.sha256) return;

    if (info.sha256 === currentSha256) {
      console.log(`[AppUpdater] Up to date (${info.version})`);
      return;
    }

    console.log(`[AppUpdater] New version detected: ${info.version} (${info.sha256.slice(0,12)}…)`);
    notifyRenderer('app-update:downloading', { version: info.version, size: info.size });

    await downloadUpdate(info);

  } catch (err) {
    console.warn('[AppUpdater] Check failed:', err.message);
  }
}

// ── Download new app.asar to app.asar.update ──────────────────────────────────
async function downloadUpdate(info) {
  const tmpPath = asarUpdate + '.tmp';

  try {
    await downloadFile(`${APP_BUCKET_URL}/app.asar`, tmpPath, (pct, bytes) => {
      notifyRenderer('app-update:progress', { percent: pct, bytes, total: info.size });
    });

    // Verify sha256
    const downloaded = hashFile(tmpPath);
    if (downloaded !== info.sha256) {
      fs.unlinkSync(tmpPath);
      throw new Error(`SHA256 mismatch: expected ${info.sha256.slice(0,12)}, got ${downloaded.slice(0,12)}`);
    }

    // Move to final update location
    if (fs.existsSync(asarUpdate)) fs.unlinkSync(asarUpdate);
    fs.renameSync(tmpPath, asarUpdate);

    updatePending = true;
    console.log(`[AppUpdater] Update ready: v${info.version}`);
    notifyRenderer('app-update:ready', { version: info.version });

  } catch (err) {
    if (fs.existsSync(tmpPath)) try { fs.unlinkSync(tmpPath); } catch {}
    console.error('[AppUpdater] Download failed:', err.message);
    notifyRenderer('app-update:error', { message: err.message });
  }
}

// ── Schedule batch-file swap on quit ──────────────────────────────────────────
function scheduleUpdateOnQuit() {
  if (!updatePending || !fs.existsSync(asarUpdate)) return;

  try {
    const execPath = process.execPath;   // path to Apex Revenue.exe

    // Write a Windows batch file that:
    //   1. Waits for this process to exit
    //   2. Renames app.asar.update → app.asar
    //   3. Relaunches the app
    //   4. Deletes itself
    const bat = [
      '@echo off',
      'timeout /t 3 /nobreak >nul',
      `if exist "${asarUpdate}" (`,
      `  if exist "${asarBackup}" del /f /q "${asarBackup}"`,
      `  copy /y "${asarPath}" "${asarBackup}" >nul 2>&1`,
      `  move /y "${asarUpdate}" "${asarPath}"`,
      `  echo [ApexUpdater] app.asar replaced successfully`,
      `) else (`,
      `  echo [ApexUpdater] No update file found`,
      `)`,
      `start "" "${execPath}"`,
      `del /f /q "%~f0"`,
    ].join('\r\n');

    fs.writeFileSync(updateBat, bat, 'utf8');

    spawn('cmd', ['/c', updateBat], {
      detached: true,
      stdio:    'ignore',
      windowsHide: true,
    }).unref();

    console.log('[AppUpdater] Scheduled swap via', updateBat);

  } catch (err) {
    console.error('[AppUpdater] Could not schedule update:', err.message);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function hashFile(filePath) {
  try {
    return crypto.createHash('sha256')
      .update(fs.readFileSync(filePath))
      .digest('hex');
  } catch { return null; }
}

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'Cache-Control': 'no-cache' } }, res => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch { reject(new Error('Invalid JSON from ' + url)); }
      });
    }).on('error', reject);
  });
}

function downloadFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    https.get(url, res => {
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} from ${url}`));
        return;
      }
      const total   = parseInt(res.headers['content-length'] || '0', 10);
      let received  = 0;
      res.on('data', chunk => {
        received += chunk.length;
        out.write(chunk);
        if (total > 0) onProgress(Math.round(received / total * 100), received);
      });
      res.on('end', () => { out.end(); resolve(); });
      res.on('error', err => { out.destroy(); reject(err); });
    }).on('error', reject);
  });
}

function notifyRenderer(channel, payload) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}

function stopAppUpdater() {
  if (checkTimer)    clearTimeout(checkTimer);
  if (pollInterval)  clearInterval(pollInterval);
}

module.exports = { initAppUpdater, stopAppUpdater };
