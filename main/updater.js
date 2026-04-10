// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Auto-Updater
// Serves updates from S3: apex-revenue-updates-994438967527
//
// Flow:
//   1. App ready → wait 12s → checkForUpdates()
//   2. Update available → download silently in background
//   3. Download progress → IPC → renderer progress bar
//   4. Download complete → IPC → renderer shows "Restart to install" banner
//   5. User clicks restart → quitAndInstall()
//   6. Periodic re-check every 4 hours
//   7. "Remind later" snoozes banner by 2 hours without cancelling download
// ═══════════════════════════════════════════════════════════════════════════════

const { autoUpdater } = require('electron-updater');
const { ipcMain, app }  = require('electron');
const path = require('path');
const log  = require('electron-log');

// ── Logger ────────────────────────────────────────────────────────────────────
log.transports.file.level = 'info';
autoUpdater.logger = log;
autoUpdater.logger.transports.file.level = 'info';

// ── Configuration ─────────────────────────────────────────────────────────────
const UPDATE_CHECK_DELAY   = 12_000;       // 12s after launch
const UPDATE_CHECK_INTERVAL = 4 * 60 * 60_000;  // every 4 hours

// Disable code-sign verification (app is unsigned)
autoUpdater.autoDownload              = true;
autoUpdater.autoInstallOnAppQuit      = true;
autoUpdater.allowDowngrade            = false;
autoUpdater.forceDevUpdateConfig      = false;

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindowRef    = null;
let checkInterval    = null;
let updateAvailable  = false;
let downloadComplete = false;
let currentVersion   = app.getVersion();
let latestVersion    = null;

// ── Initialise ────────────────────────────────────────────────────────────────
function initUpdater(mainWindow) {
  mainWindowRef = mainWindow;

  // ── Events ─────────────────────────────────────────────────────────────────
  autoUpdater.on('checking-for-update', () => {
    log.info('[Updater] Checking for update…');
    send('update:checking');
  });

  autoUpdater.on('update-available', info => {
    latestVersion    = info.version;
    updateAvailable  = true;
    downloadComplete = false;
    log.info(`[Updater] Update available: v${info.version} (current: v${currentVersion})`);
    send('update:available', {
      version:     info.version,
      releaseDate: info.releaseDate,
      current:     currentVersion,
    });
  });

  autoUpdater.on('update-not-available', info => {
    log.info(`[Updater] App is up to date: v${info.version}`);
    send('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', progress => {
    const pct = Math.round(progress.percent);
    log.info(`[Updater] Download: ${pct}% (${formatBytes(progress.transferred)}/${formatBytes(progress.total)}) @ ${formatBytes(progress.bytesPerSecond)}/s`);
    send('update:progress', {
      percent:      pct,
      transferred:  progress.transferred,
      total:        progress.total,
      bytesPerSec:  progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', info => {
    downloadComplete = true;
    log.info(`[Updater] Update downloaded: v${info.version}`);
    send('update:ready', {
      version:     info.version,
      releaseDate: info.releaseDate,
      current:     currentVersion,
    });
  });

  autoUpdater.on('error', err => {
    // Silent — network errors are expected (offline, S3 unavailable)
    log.warn('[Updater] Error:', err.message);
    send('update:error', { message: err.message });
  });

  // ── IPC handlers ───────────────────────────────────────────────────────────

  // Renderer: "Restart and install now"
  ipcMain.on('update:install', () => {
    log.info('[Updater] User triggered install restart');
    autoUpdater.quitAndInstall(false, true);  // isSilent=false, isForceRunAfter=true
  });

  // Renderer: "Check now" (manual, e.g. from tray menu)
  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // Renderer: query current state
  ipcMain.handle('update:status', () => ({
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadComplete,
  }));

  // ── Initial check after short delay ────────────────────────────────────────
  setTimeout(() => safeCheck(), UPDATE_CHECK_DELAY);

  // ── Periodic check ──────────────────────────────────────────────────────────
  checkInterval = setInterval(() => safeCheck(), UPDATE_CHECK_INTERVAL);
}

// ── Helpers ───────────────────────────────────────────────────────────────────
async function safeCheck() {
  try {
    await autoUpdater.checkForUpdates();
  } catch {
    /* silent — offline or S3 unreachable */
  }
}

function send(channel, payload = {}) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}

function formatBytes(bytes) {
  if (bytes < 1024)           return `${bytes} B`;
  if (bytes < 1024 * 1024)    return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function stopUpdater() {
  if (checkInterval) clearInterval(checkInterval);
}

module.exports = { initUpdater, stopUpdater };
