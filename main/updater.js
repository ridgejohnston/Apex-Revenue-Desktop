// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Auto-Updater (no external logger dependency)
// Checks S3 every 12s after launch, then every 4 hours.
// Downloads silently, shows banner in renderer when ready.
// ═══════════════════════════════════════════════════════════════════════════════

const { autoUpdater } = require('electron-updater');
const { ipcMain, app } = require('electron');

// ── Configuration ─────────────────────────────────────────────────────────────
const CHECK_DELAY    = 12_000;           // 12s after launch
const CHECK_INTERVAL = 4 * 60 * 60_000; // every 4 hours

autoUpdater.autoDownload         = true;
autoUpdater.autoInstallOnAppQuit = true;
autoUpdater.allowDowngrade       = false;

// Disable electron-updater's own logger to avoid electron-log dependency
autoUpdater.logger = null;

// ── State ─────────────────────────────────────────────────────────────────────
let mainWindowRef    = null;
let checkInterval    = null;
let updateAvailable  = false;
let downloadComplete = false;
let currentVersion   = app.getVersion();
let latestVersion    = null;

// ── Init ──────────────────────────────────────────────────────────────────────
function initUpdater(mainWindow) {
  mainWindowRef = mainWindow;

  autoUpdater.on('checking-for-update', () => {
    console.log('[Updater] Checking for update…');
    send('update:checking');
  });

  autoUpdater.on('update-available', info => {
    latestVersion   = info.version;
    updateAvailable = true;
    console.log(`[Updater] Update available: v${info.version}`);
    send('update:available', {
      version:     info.version,
      releaseDate: info.releaseDate,
      current:     currentVersion,
    });
  });

  autoUpdater.on('update-not-available', info => {
    console.log(`[Updater] Up to date: v${info.version}`);
    send('update:not-available', { version: info.version });
  });

  autoUpdater.on('download-progress', progress => {
    const pct = Math.round(progress.percent);
    send('update:progress', {
      percent:     pct,
      transferred: progress.transferred,
      total:       progress.total,
      bytesPerSec: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', info => {
    downloadComplete = true;
    console.log(`[Updater] Downloaded: v${info.version}`);
    send('update:ready', {
      version:     info.version,
      releaseDate: info.releaseDate,
      current:     currentVersion,
    });
  });

  autoUpdater.on('error', err => {
    // Silent — expected when offline or S3 unreachable
    console.warn('[Updater]', err.message);
    send('update:error', { message: err.message });
  });

  // ── IPC ───────────────────────────────────────────────────────────────────
  ipcMain.on('update:install', () => {
    console.log('[Updater] Installing…');
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.handle('update:check', async () => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, version: result?.updateInfo?.version };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('update:status', () => ({
    currentVersion,
    latestVersion,
    updateAvailable,
    downloadComplete,
  }));

  // ── Schedule ──────────────────────────────────────────────────────────────
  setTimeout(() => safeCheck(), CHECK_DELAY);
  checkInterval = setInterval(() => safeCheck(), CHECK_INTERVAL);
}

async function safeCheck() {
  try { await autoUpdater.checkForUpdates(); } catch { /* offline */ }
}

function send(channel, payload = {}) {
  if (mainWindowRef && !mainWindowRef.isDestroyed()) {
    mainWindowRef.webContents.send(channel, payload);
  }
}

function stopUpdater() {
  if (checkInterval) clearInterval(checkInterval);
}

module.exports = { initUpdater, stopUpdater };
