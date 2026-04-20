/**
 * Apex Revenue Desktop v2 — Main Process
 * Combines Creator Intelligence Engine with full OBS-style streaming platform
 */

const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, Notification, desktopCapturer, session, screen, protocol, dialog, shell, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const awsServices = require('./aws-services');
const streamEngine = require('./stream-engine');
const sceneManager = require('./scene-manager');
const audioMixer = require('./audio-mixer');
const ffmpegInstaller = require('./ffmpeg-installer');
const mediapipeInstaller = require('./mediapipe-installer');
const { AiCoach } = require('./ai-coach');
const coachKnowledge = require('./coach-knowledge');
const coachProfile = require('./coach-profile');
const autoconfig = require('./autoconfig');
const errorLogger = require('./error-logger');
const { autoUpdater } = require('electron-updater');
const EarningsTracker = require('../shared/earnings-tracker');
const { VERSION } = require('../shared/apex-config');
const signalEngine = require('./signal-engine');
const cloudSync = require('./cloud-sync');
const profileCloudSync = require('./profile-cloud-sync');
const multiView = require('./multi-view');

// ─── Persistent Store ──────────────────────────────────
const store = new Store({
  name: 'apex-revenue-v2',
  encryptionKey: 'apex-revenue-v2-enc-key-2025',
  defaults: {
    windowBounds: { width: 1600, height: 900 },
    selectedUrl: null,
    awsVoiceEnabled: true,
    awsBackupEnabled: true,
    awsMetricsEnabled: true,
    awsFirehoseEnabled: true,
    awsIotEnabled: false,
    awsPromptMode: 'bedrock',
    obsSettings: {
      outputPath: app.getPath('videos'),
      streamKey: '',
      streamUrl: 'rtmp://global.live.mmcdn.com/live-origin',
      // Additional simulcast destinations (v3.3.27+). Primary destination
      // still comes from the streamUrl/streamKey fields above. Each entry:
      //   { id, name, url, key, enabled, platform }
      // _resolveDestinations in stream-engine.js concatenates the primary
      // + enabled entries from this list.
      destinations: [],
      videoEncoder: 'libx264',
      videoBitrate: 2500,
      audioBitrate: 160,
      resolution: { width: 1920, height: 1080 },
      fps: 30,
      preset: 'veryfast',
    },
    scenes: [],
    activeSceneId: null,
    audioDevices: {},
    virtualCamEnabled: false,
    // When true, the user has completed in-app platform ownership
    // verification (Settings → Streaming). Cam-derived tips, fan leaderboard,
    // whale history, and signal-engine profiling run only after this is set.
    platformOwnershipVerified: false,
    // Local-only — never uploaded; used only to derive AES key client-side.
    profileSyncPassphrase: '',
    multiViewSettings: {
      enabled: false,
      tipThresholdTokens: 25,
      holdSeconds: 8,
      defaultWebcamSourceId: null,
      alternateSourceIds: [],
      /** Primary stays on main RTMP; up to 8 extra RTMP outputs from Multi-View slots. */
      multiOutputEnabled: false,
      multiOutputs: Array.from({ length: 8 }, () => ({
        sourceId: null,
        triggerTokens: 25,
        durationSeconds: 8,
        streamUrl: '',
        streamKey: '',
      })),
    },
  },
});

// Initialize the broadcast-ledger analytics module with the app's
// electron-store instance. The ledger records every broadcast session
// (start, end, duration, exit reason) for usage analytics only — there
// is no quota enforcement. Platinum and Agency tiers have unlimited
// broadcasting per BROADCAST_POLICY in shared/apex-config.js.
const broadcastLedger = require('./broadcast-ledger');
broadcastLedger.init(store);

// ─── State ──────────────────────────────────────────────
let mainWindow = null;
let camView = null;
let tray = null;
let isUpdating = false; // prevent window-all-closed from quitting during update install
const tracker = new EarningsTracker();
let cwInterval = null;
let isQuitting = false;

// ─── Window Creation ────────────────────────────────────
function createMainWindow() {
  const bounds = store.get('windowBounds');
  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 1200,
    minHeight: 700,
    frame: false,
    backgroundColor: '#0a0a0f',
    icon: path.join(__dirname, '../assets/icons/icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-main.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Dev or production
  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:9000');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/dist/index.html'));
  }

  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store.set('windowBounds', { width, height });
  });

  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── BrowserView for Cam Sites ──────────────────────────
function createCamView() {
  camView = new BrowserView({
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-cam.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  return camView;
}

function attachCamView(bounds) {
  if (!mainWindow || !camView) return;
  mainWindow.addBrowserView(camView);
  camView.setBounds(bounds);
  camView.setAutoResize({ width: true, height: true });
}

function detachCamView() {
  if (mainWindow && camView) {
    mainWindow.removeBrowserView(camView);
  }
}

// ─── System Tray ────────────────────────────────────────
function createTray() {
  const iconPath = path.join(__dirname, '../assets/icons/icon.ico');
  tray = new Tray(iconPath);
  tray.setToolTip('Apex Revenue');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow?.show() },
    { type: 'separator' },
    { label: 'Quit', click: () => { isQuitting = true; app.quit(); } },
  ]));
  tray.on('double-click', () => mainWindow?.show());
}

// ─── IPC Handlers ───────────────────────────────────────

// Store
ipcMain.handle('store:get', (_, key) => store.get(key));
ipcMain.handle('store:set', (_, key, value) => {
  // When the user saves obsSettings and their videoEncoder differs from
  // what's already stored, treat that as an explicit encoder choice and
  // mark _encoderUserSelectedAt. refreshEncoderForFreshInstall() reads
  // this flag and stays out of the way after a user-made selection.
  if (key === 'obsSettings' && value && typeof value === 'object') {
    const prev = store.get('obsSettings') || {};
    if (value.videoEncoder && value.videoEncoder !== prev.videoEncoder) {
      value = { ...value, _encoderUserSelectedAt: new Date().toISOString() };
    }
  }
  const ret = store.set(key, value);
  // Revoking platform ownership clears tip/fan session state so analytics
  // cannot leak across the boundary.
  if (key === 'platformOwnershipVerified' && value === false) {
    const plat = tracker.platform;
    tracker.reset();
    if (plat) tracker.start(plat);
  }
  // Keep Scene Properties (OBS panel) in sync when obsSettings is written
  // from any path (e.g. Settings → Streaming preset), not only local panel saves.
  if (key === 'obsSettings' && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('obs-settings:auto-refreshed', { source: 'store:set' });
  }
  return ret;
});

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:exit', () => { isQuitting = true; app.quit(); });
ipcMain.on('window:restart', () => { isQuitting = true; app.relaunch(); app.exit(0); });
ipcMain.handle('app:version', () => app.getVersion());

// ─── Screen / Media Sources ─────────────────────────────
ipcMain.handle('sources:get-screens', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

ipcMain.handle('sources:get-windows', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 320, height: 180 },
  });
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }));
});

// Returns the chromeMediaSourceId for a given desktopCapturer source id.
// The renderer needs this to call getUserMedia with desktop capture constraints.
ipcMain.handle('sources:get-desktop-stream-id', async (_, sourceId) => {
  const all = await desktopCapturer.getSources({ types: ['screen', 'window'] });
  const match = all.find((s) => s.id === sourceId);
  return match ? match.id : null;
});

// List image files in a folder for image_slideshow sources. Same file
// extensions the stream engine's _buildSlideshowInput accepts; the two
// enumerations must agree so the preview shows exactly what would be
// included in a slideshow broadcast. Returns alphabetically sorted
// absolute paths.
ipcMain.handle('slideshow:list-images', async (_, folderPath) => {
  try {
    if (!folderPath || typeof folderPath !== 'string') return [];
    if (!fs.existsSync(folderPath)) return [];
    const stat = fs.statSync(folderPath);
    if (!stat.isDirectory()) return [];
    const imageExts = /\.(png|jpg|jpeg|webp|gif|bmp)$/i;
    return fs.readdirSync(folderPath)
      .filter((name) => imageExts.test(name))
      .sort()
      .map((name) => path.join(folderPath, name));
  } catch (err) {
    console.warn('[main] slideshow:list-images failed:', err.message);
    return [];
  }
});

// Native file picker. Used by AddSourceModal's Browse buttons for
// image and video file sources so users don't have to type paths.
// `filters` follows Electron's showOpenDialog spec: an array of
// { name, extensions }. Returns the first selected absolute path or
// null if the user cancels.
//
// Parent window is the main app window so the dialog is modal and
// can't get lost behind other windows — a common pain point with
// non-modal pickers in frameless apps.
ipcMain.handle('dialog:open-file', async (_, options = {}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select File',
      properties: ['openFile'],
      filters: options.filters || [{ name: 'All Files', extensions: ['*'] }],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.warn('[main] dialog:open-file failed:', err.message);
    return null;
  }
});

// Native folder picker. Used by the Image Slideshow source's Browse
// button. Returns the selected folder absolute path or null on cancel.
ipcMain.handle('dialog:open-folder', async (_, options = {}) => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: options.title || 'Select Folder',
      properties: ['openDirectory'],
    });
    if (result.canceled || !result.filePaths || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0];
  } catch (err) {
    console.warn('[main] dialog:open-folder failed:', err.message);
    return null;
  }
});

// ─── Error Logger IPC ────────────────────────────────────
// Six handlers that let the renderer participate in the central
// error log: pushing errors in, reading them back out, and offering
// Ridge one-click copy/open actions.

// Forward a renderer-side error into the central log. The renderer
// hooks its window.error / unhandledrejection / console.error events
// and calls this for each. Keeps all errors (main + renderer) in a
// single file.
ipcMain.handle('errors:log', (_, level, source, message, context) => {
  try {
    errorLogger.log(level, source, message, context);
    return true;
  } catch {
    return false;
  }
});

// Return the last N entries from the in-memory ring buffer. Fast
// path for "show recent errors" UI that doesn't want to read from
// disk. Default 200 gives roughly the last session's worth of activity.
ipcMain.handle('errors:recent', (_, n) => errorLogger.recent(n));

// Return the full current log file contents. Used when the user
// explicitly wants "everything, not just recent" — e.g., when
// reproducing a long-running stream issue.
ipcMain.handle('errors:read-all', () => errorLogger.readAll());

// Truncate the log and clear the in-memory buffer. Writes an
// 'info: Log cleared' entry so the next batch of errors still has
// context for when the clear happened.
ipcMain.handle('errors:clear', () => {
  errorLogger.clear();
  return true;
});

// Open the log directory in Explorer/Finder so the user can zip
// it up, inspect rotated files, etc. shell.openPath returns a
// string error message on failure (empty string on success).
ipcMain.handle('errors:open-folder', async () => {
  const dir = errorLogger.getLogDir();
  if (!dir) return { ok: false, error: 'Log directory not initialized' };
  const err = await shell.openPath(dir);
  if (err) return { ok: false, error: err };
  return { ok: true, path: dir };
});

// Read the full log (disk + in-memory) and push to the system
// clipboard. This is the primary workflow Ridge asked for — hit one
// button, paste to the assistant, done.
ipcMain.handle('errors:copy-to-clipboard', () => {
  try {
    const contents = errorLogger.readAll();
    clipboard.writeText(contents || '(log is empty)');
    return { ok: true, bytes: (contents || '').length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── Scene Management IPC ───────────────────────────────
ipcMain.handle('scenes:get-all', () => sceneManager.getAll());
ipcMain.handle('scenes:get-active', () => sceneManager.getActive());
ipcMain.handle('scenes:create', (_, name) => sceneManager.create(name));
ipcMain.handle('scenes:delete', (_, id) => sceneManager.remove(id));
ipcMain.handle('scenes:set-active', (_, id) => sceneManager.setActive(id));
ipcMain.handle('scenes:rename', (_, id, name) => sceneManager.rename(id, name));
ipcMain.handle('scenes:duplicate', (_, id) => sceneManager.duplicate(id));

// ─── Source Management IPC ──────────────────────────────
ipcMain.handle('sources:add', (_, sceneId, sourceConfig) => sceneManager.addSource(sceneId, sourceConfig));
ipcMain.handle('sources:remove', (_, sceneId, sourceId) => sceneManager.removeSource(sceneId, sourceId));
ipcMain.handle('sources:update', (_, sceneId, sourceId, props) => sceneManager.updateSource(sceneId, sourceId, props));
ipcMain.handle('sources:reorder', (_, sceneId, sourceIds) => sceneManager.reorderSources(sceneId, sourceIds));
ipcMain.handle('sources:toggle-visible', (_, sceneId, sourceId) => sceneManager.toggleSourceVisibility(sceneId, sourceId));
ipcMain.handle('sources:toggle-lock', (_, sceneId, sourceId) => sceneManager.toggleSourceLock(sceneId, sourceId));

// ─── Audio Mixer IPC ────────────────────────────────────
ipcMain.handle('audio:get-devices', () => audioMixer.getDevices());
ipcMain.handle('audio:set-volume', (_, deviceId, volume) => audioMixer.setVolume(deviceId, volume));
ipcMain.handle('audio:set-muted', (_, deviceId, muted) => audioMixer.setMuted(deviceId, muted));
ipcMain.handle('audio:get-levels', () => audioMixer.getLevels());

// ─── Stream Engine IPC ──────────────────────────────────

// Shared helper: if FFmpeg is missing, download and extract the S3 bundle
// to userData before the stream/record call proceeds. Progress is streamed
// to the renderer so the existing FFmpeg install banner can show a bar.
// Throws on install failure so the IPC handler rejects cleanly — the
// renderer catches that and surfaces the error to the user.
async function ensureFFmpegInstalled() {
  if (ffmpegInstaller.isFFmpegInstalled()) return;

  mainWindow?.webContents.send('ffmpeg:installing', { reason: 'auto' });
  try {
    const exePath = await ffmpegInstaller.downloadAndInstallFFmpeg((progress) => {
      mainWindow?.webContents.send('ffmpeg:install-progress', progress);
    });
    mainWindow?.webContents.send('ffmpeg:installed', { success: true, path: exePath });

    // If this is the first time FFmpeg landed on this machine AND the user
    // hasn't customized their encoder choice yet, nudge the saved encoder
    // to whatever's actually available in this build. Without this, users
    // whose first-run autoconfig ran pre-FFmpeg would be stuck with the
    // libx264 fallback even though NVENC/AMF/QSV are actually present now.
    await refreshEncoderForFreshInstall();
  } catch (err) {
    mainWindow?.webContents.send('ffmpeg:installed', { success: false, error: err.message });
    const wrapped = new Error(`FFmpeg auto-install failed: ${err.message}. You can retry from Settings → Streaming → Install FFmpeg.`);
    wrapped.code = 'FFMPEG_INSTALL_FAILED';
    throw wrapped;
  }
}

// ─── OBS Autoconfig ─────────────────────────────────────
//
// Runs once on first app launch to seed obsSettings with recommendations
// based on the user's machine (GPU, display, FFmpeg encoders). After the
// one-time seed, user edits save through store.set('obsSettings', ...)
// as normal and always win on subsequent launches. The "Auto-detect"
// button in the OBS panel is the only path that overwrites user choices,
// and it goes through 'obs-settings:apply-detected' with explicit
// user confirmation.
// v3.4.43: shared GPU probe for autoconfig call sites. app.getGPUInfo
// populates from a Chromium internal cache after the GPU process is up,
// so this call is fast but still async. Returns null on any failure —
// the autoconfig classifier interprets null as 'unknown' tier and picks
// 1080p defaults (the pre-v3.4.43 behavior). Never throws.
async function _gpuInfoForAutoconfig() {
  try {
    return await app.getGPUInfo('basic');
  } catch (err) {
    console.warn('[Apex] app.getGPUInfo failed, autoconfig defaults to unknown GPU tier:', err.message);
    return null;
  }
}

async function maybeFirstRunObsAutoconfig() {
  try {
    const current = store.get('obsSettings') || {};

    // Already autoconfigured once? Leave user's saved state alone.
    if (current._autoconfiguredAt) {
      // ...BUT run the one-time bitrate-cap migration for users who
      // were autoconfigured on an older version. v3.4.26 and earlier
      // set 4000-4500 kbps defaults at 1080p which exceed cam-platform
      // kick thresholds (Chaturbate's observed ceiling is ~4000; we
      // target 3500 to leave headroom). Without this migration,
      // existing installs keep their stored-too-high values even after
      // the recommendation table is updated — users hit -10053
      // disconnects and the only hint would be "re-copy your stream
      // key", which doesn't help when the real problem is bitrate.
      //
      // Keyed by a stamp so each user's bitrate is migrated at most
      // once — if they intentionally crank it higher later, we respect
      // that choice.
      if (!current._bitrateCappedAt && typeof current.videoBitrate === 'number') {
        const h = current.resolution?.height;
        const overCap =
          (h >= 1080 && current.videoBitrate > 4000) ||
          (h >= 720  && h < 1080 && current.videoBitrate > 3500);
        if (overCap) {
          const newBitrate = h >= 1080 ? 3500 : 3000;
          store.set('obsSettings', {
            ...current,
            videoBitrate: newBitrate,
            _bitrateCappedAt: new Date().toISOString(),
            _bitrateCappedFrom: current.videoBitrate,
          });
          console.log(
            `[Apex] v3.4.28 migration: lowered stored videoBitrate ${current.videoBitrate}k -> ${newBitrate}k (platform cap compliance)`
          );
        } else {
          // Still stamp so we don't re-check every launch for users
          // whose bitrate was already fine.
          store.set('obsSettings', { ...current, _bitrateCappedAt: new Date().toISOString() });
        }
      }

      // v3.4.42 one-time migration: normalize stored resolution to the
      // 16:9 cam-platform whitelist. The pre-v3.4.41 autoconfig seeded
      // stored obsSettings.resolution by downscaling the display to a
      // 1080p height ceiling while preserving aspect. On 16:10 laptop
      // displays (1920x1200, very common on HP/Dell/Lenovo business
      // machines) that produced {1728, 1080} — not a resolution any
      // cam RTMP ingest accepts. v3.4.41 added a stream-time sanitizer
      // that coerces at ffmpeg-arg-build time, which fixes the stream
      // but leaves the stored value stale: the Settings > Resolution
      // dropdown can't match 1728x1080 against its {1920x1080, 1280x720,
      // 854x480, 640x360} options and shows no selection. This
      // migration rewrites the stored value once so the dropdown
      // reflects reality. Runs ONCE per install, stamped by
      // _resolutionNormalizedAt.
      //
      // Idempotent: if the stored resolution is already on the
      // whitelist, we only write the stamp (no functional change).
      if (!current._resolutionNormalizedAt) {
        const res = current.resolution;
        const refreshed = store.get('obsSettings') || current;
        const onWhitelist = res && autoconfig.STREAM_RESOLUTIONS_16_9.some(
          (r) => r.width === res.width && r.height === res.height
        );
        if (res && !onWhitelist) {
          const coerced = autoconfig.pickStreamResolution(res.height || 1080);
          store.set('obsSettings', {
            ...refreshed,
            resolution: coerced,
            _resolutionNormalizedAt: new Date().toISOString(),
            _resolutionNormalizedFrom: { width: res.width, height: res.height },
          });
          console.log(
            `[Apex] v3.4.42 migration: normalized stored resolution ${res.width}x${res.height} -> ${coerced.width}x${coerced.height} (16:9 cam-platform whitelist)`
          );
        } else {
          store.set('obsSettings', {
            ...refreshed,
            _resolutionNormalizedAt: new Date().toISOString(),
          });
        }
      }
      return;
    }

// v3.4.43: probe the GPU before autoconfig so we can default
    // integrated-GPU machines to 720p instead of 1080p. Electron's
    // app.getGPUInfo('basic') is cheap (returns a cached descriptor
    // populated at GPU process startup) but still async; we await it
    // here because autoconfig is a one-time first-run cost and adding
    // ~50ms is imperceptible. On failure (rare — the GPU info service
    // is part of every Chromium build) the tier resolves to 'unknown'
    // and autoconfig picks the 1080p default, matching pre-v3.4.43
    // behavior exactly.
    const gpuInfo = await _gpuInfoForAutoconfig();

    const { recommendations, specs } = await autoconfig.detectRecommendedObsSettings({
      ffmpegPath: ffmpegInstaller.findFFmpegPath(),
      screenModule: screen,
      videosPath: app.getPath('videos'),
      gpuInfo,
    });

    // Preserve any user-meaningful fields that shouldn't be auto-derived:
    // stream URL (platform choice), stream key (secret), audio device
    // (personal mic preference), simulcast destinations (user-curated).
    // Everything else gets the recommendation.
    const merged = {
      ...recommendations,
      streamUrl:    current.streamUrl    || 'rtmp://global.live.mmcdn.com/live-origin',
      streamKey:    current.streamKey    || '',
      destinations: Array.isArray(current.destinations) ? current.destinations : [],
      audioDevice:  current.audioDevice  || '',
      outputPath:   current.outputPath   || recommendations.outputPath,
      _autoconfiguredAt: new Date().toISOString(),
      _bitrateCappedAt:  new Date().toISOString(),
      _resolutionNormalizedAt: new Date().toISOString(),
      _autoconfigSpecs: specs,
    };
    store.set('obsSettings', merged);
    console.log('[Apex] First-run OBS autoconfig applied:', {
      encoder: merged.videoEncoder,
      bitrate: merged.videoBitrate,
      resolution: merged.resolution,
      detectedEncoders: specs.detectedEncoders,
    });
  } catch (err) {
    console.warn('[Apex] First-run OBS autoconfig failed (non-fatal):', err.message);
    // Non-fatal — the packaged defaults in electron-store's schema still apply
  }
}

// If the user hasn't picked an encoder themselves yet, re-run the encoder
// portion of autoconfig after an FFmpeg install. Called from the
// ensureFFmpegInstalled flow so the first streaming attempt benefits from
// the freshly-available hardware encoders even though autoconfig ran
// pre-install. Only touches videoEncoder — no bitrate/resolution/etc.
async function refreshEncoderForFreshInstall() {
  try {
    const current = store.get('obsSettings') || {};
    // If user has explicitly chosen a non-default encoder, do not override
    if (current._encoderUserSelectedAt) return;

    const { recommendations } = await autoconfig.detectRecommendedObsSettings({
      ffmpegPath: ffmpegInstaller.findFFmpegPath(),
      screenModule: screen,
      videosPath: app.getPath('videos'),
      gpuInfo: await _gpuInfoForAutoconfig(),
    });
    if (recommendations.videoEncoder && recommendations.videoEncoder !== current.videoEncoder) {
      const merged = {
        ...current,
        videoEncoder: recommendations.videoEncoder,
        // Also refresh bitrate ceiling since hardware encoders get a higher budget
        videoBitrate: recommendations.videoBitrate,
      };
      store.set('obsSettings', merged);
      mainWindow?.webContents.send('obs-settings:auto-refreshed', {
        encoder: merged.videoEncoder,
        bitrate: merged.videoBitrate,
      });
      console.log('[Apex] Post-install encoder refresh:', merged.videoEncoder);
    }
  } catch (err) {
    console.warn('[Apex] Post-install encoder refresh failed:', err.message);
  }
}

// On-demand autoconfig detection — returns recommendations WITHOUT
// persisting anything. The renderer uses this to show the user what
// would change before they confirm.
ipcMain.handle('obs-settings:detect', async () => {
  return autoconfig.detectRecommendedObsSettings({
    ffmpegPath: ffmpegInstaller.findFFmpegPath(),
    screenModule: screen,
    videosPath: app.getPath('videos'),
    gpuInfo: await _gpuInfoForAutoconfig(),
  });
});

// Apply a selected subset of recommendations to obsSettings. `fields` is
// an array of keys the user wants to overwrite (e.g. ['videoEncoder',
// 'videoBitrate']). Anything not in `fields` is preserved from the
// current saved settings. Returns the merged result so the renderer can
// refresh its local state immediately.
ipcMain.handle('obs-settings:apply-detected', async (_, payload) => {
  const fields = (payload && payload.fields) || [];
  const current = store.get('obsSettings') || {};
  const { recommendations } = await autoconfig.detectRecommendedObsSettings({
    ffmpegPath: ffmpegInstaller.findFFmpegPath(),
    screenModule: screen,
    videosPath: app.getPath('videos'),
    gpuInfo: await _gpuInfoForAutoconfig(),
  });
  const patch = {};
  for (const key of fields) {
    if (recommendations[key] !== undefined) patch[key] = recommendations[key];
  }
  const merged = {
    ...current,
    ...patch,
    _lastAutoDetectAppliedAt: new Date().toISOString(),
    // Mark that the user explicitly set the encoder so the post-install
    // refresh above doesn't later overwrite their intentional choice.
    ...(fields.includes('videoEncoder') ? { _encoderUserSelectedAt: new Date().toISOString() } : {}),
  };
  store.set('obsSettings', merged);
  return merged;
});

// Enumerate DirectShow video input devices — webcams, HDMI capture
// cards, OBS/XSplit virtual cameras, etc. Fresh probe every call so
// plug/unplug changes are visible without restarting the app. Requires
// FFmpeg to be installed; returns [] if not (renderer can show an
// appropriate empty-state).
ipcMain.handle('webcam:list', async () => {
  try {
    await ensureFFmpegInstalled();
    return await streamEngine.detectWebcams();
  } catch (err) {
    console.warn('[webcam:list] Failed:', err.message);
    return [];
  }
});

ipcMain.handle('stream:start', async (_, config) => {
  await ensureFFmpegInstalled();
  const settings = { ...store.get('obsSettings'), ...config };

  // Note: webcam streaming no longer routes through this handler.
  // The renderer checks settings.videoSource and calls stream:start-pipe
  // instead when the source is webcam, because DirectShow pins are
  // exclusive and we need the renderer to keep the camera for preview.
  // This handler still serves screen/media/image/URL/slideshow sources
  // which don't have the exclusive-pin issue.
  return streamEngine.startStream(settings);
});

// Pipe-input streaming: renderer's MediaRecorder pipes WebM chunks to
// FFmpeg stdin via IPC. Used for webcam sources so the renderer keeps
// the DirectShow camera handle (and therefore the live preview). The
// arrangement lets the user zoom/pan/tilt via canvas transforms while
// streaming — the same stream feeds both the preview and the recorder.
ipcMain.handle('stream:start-pipe', async (_, config) => {
  await ensureFFmpegInstalled();
  const settings = { ...store.get('obsSettings'), ...config };
  return streamEngine.startStreamFromPipe(settings);
});

// High-frequency chunk handler — fired by MediaRecorder's
// dataavailable event, ~4 Hz with a 250ms timeslice. Fire-and-forget
// (ipcRenderer.send, not invoke) so the renderer doesn't block
// waiting for an ack on every frame. Returning a value would force
// an extra IPC roundtrip we don't need.
ipcMain.on('stream:webm-chunk', (_, buffer) => {
  if (!buffer || buffer.byteLength === 0) return;
  // Buffer arrives as an ArrayBuffer/Uint8Array from the renderer.
  // Node's stream.write wants a Buffer; wrap if needed.
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  streamEngine.writeChunk(buf);
});

ipcMain.handle('stream:stop-pipe', async () => {
  return streamEngine.stopStreamFromPipe();
});

ipcMain.handle('stream:stop', async () => {
  return streamEngine.stopStream();
});
ipcMain.handle('stream:get-status', () => streamEngine.getStatus());

ipcMain.handle('record:start', async (_, config) => {
  await ensureFFmpegInstalled();
  const settings = { ...store.get('obsSettings'), ...config };
  return streamEngine.startRecording(settings);
});
ipcMain.handle('record:stop', () => streamEngine.stopRecording());

ipcMain.handle('virtual-cam:start', () => streamEngine.startVirtualCam());
ipcMain.handle('virtual-cam:stop', () => streamEngine.stopVirtualCam());

// ─── Cam Site / BrowserView IPC ─────────────────────────
ipcMain.on('cam:navigate', (_, url) => {
  if (camView) camView.webContents.loadURL(url);
});

ipcMain.on('cam:back', () => { if (camView?.webContents.canGoBack()) camView.webContents.goBack(); });
ipcMain.on('cam:forward', () => { if (camView?.webContents.canGoForward()) camView.webContents.goForward(); });
ipcMain.on('cam:reload', () => { camView?.webContents.reload(); });

// Cam → Main → Renderer relay
ipcMain.on('cam:live-update', (_, data) => {
  const ownershipOk = !!store.get('platformOwnershipVerified');
  tracker.updateViewers(data.viewers || 0);
  if (ownershipOk && data.tips) {
    data.tips.forEach((t) => tracker.addTip(t.username, t.amount, t.timestamp));
  }
  const snapshot = tracker.getSnapshot(data.viewers || 0);
  if (ownershipOk) {
    snapshot.fans = data.fans || [];
  } else {
    snapshot.fans = [];
    snapshot.platformAnalyticsBlocked = true;
    snapshot.platformAnalyticsBlockReason = 'ownership';
  }
  mainWindow?.webContents.send('live-update', snapshot);

  // AI trigger detection (uses tips/whales — only when ownership verified)
  if (ownershipOk) checkAiTriggers(snapshot);
  if (ownershipOk && data.tips?.length) {
    try { multiView.onTipsReceived(data.tips); } catch (e) { console.warn('[multi-view]', e.message); }
  }
});

ipcMain.on('cam:platform-detected', (_, platform) => {
  tracker.start(platform);
  mainWindow?.webContents.send('cam:platform-detected', platform);
});

// ─── AWS Services IPC ───────────────────────────────────
ipcMain.handle('aws:bedrock-prompt', async (_, trigger, context) => {
  try {
    const prompt = await awsServices.generatePrompt(trigger, context);
    mainWindow?.webContents.send('aws:ai-prompt', { trigger, prompt });
    // Auto-speak
    if (store.get('awsVoiceEnabled')) {
      const audio = await awsServices.synthesizeSpeech(prompt);
      mainWindow?.webContents.send('aws:polly-audio', audio);
    }
    return prompt;
  } catch (e) { console.error('Bedrock error:', e); return null; }
});

ipcMain.handle('aws:polly-speak', async (_, text) => {
  try {
    const audio = await awsServices.synthesizeSpeech(text);
    mainWindow?.webContents.send('aws:polly-audio', audio);
    return true;
  } catch (e) { console.error('Polly error:', e); return false; }
});

ipcMain.handle('aws:s3-backup', async () => {
  try {
    const snapshot = tracker.getSnapshot();
    await awsServices.backupSession(snapshot, store.get('apexSession'));
    mainWindow?.webContents.send('aws:backup-done', { success: true });
    return true;
  } catch (e) { console.error('S3 backup error:', e); return false; }
});

// ─── AI Coach: multi-turn chat for live cam performers ─────
//
// Lazily constructed on first send so we don't touch Bedrock at all
// for users who never open the Coach. One instance per app process,
// shared across all renderer windows (there's only one right now).
// The coach holds conversation state in memory — if the user restarts
// the app, the conversation is gone.
let coach = null;
function getCoach() {
  if (!coach) {
    const bedrock = awsServices.getBedrockClient?.();
    if (!bedrock) throw new Error('Bedrock not initialized — sign in first');
    coach = new AiCoach(bedrock);
  }
  return coach;
}

ipcMain.handle('coach:send-message', async (evt, text, liveContext) => {
  try {
    const coach = getCoach();
    // Stream research progress back to the renderer that called us —
    // the Coach's chat send returns after the call completes, but for
    // 30-second research runs the UI needs intermediate updates so the
    // user knows it hasn't hung.
    const onProgress = (stage) => {
      try {
        evt.sender.send('coach:research-progress', { stage });
      } catch {}
    };
    const result = await coach.sendMessage(text, liveContext || {}, onProgress);
    return { ok: true, reply: result.reply, kind: result.kind };
  } catch (err) {
    console.error('[coach] send-message error:', err?.message || err);
    return { ok: false, error: err?.message || String(err) };
  }
});

ipcMain.handle('coach:reset', async () => {
  try { coach?.reset(); } catch {}
  return { ok: true };
});

ipcMain.handle('coach:history', async () => {
  try { return coach?.getHistory?.() || []; } catch { return []; }
});

// ─── Coach knowledge base (Training Log) ────────────
// Knowledge artifacts are created by /research commands and by the
// shipped baseline bundle. The renderer uses these to show the user
// what the Coach has "learned" and give them a way to prune stale
// research they don't want anymore.
ipcMain.handle('coach:knowledge-list',   async () => {
  try { return await coachKnowledge.list(); } catch { return []; }
});
ipcMain.handle('coach:knowledge-delete', async (_, filename) => {
  try { return { ok: await coachKnowledge.remove(filename) }; }
  catch (err) { return { ok: false, error: err?.message || String(err) }; }
});
ipcMain.handle('coach:knowledge-stats',  async () => {
  try { return await coachKnowledge.stats(); }
  catch { return { totalArtifacts: 0, shippedArtifacts: 0, userArtifacts: 0, totalWords: 0 }; }
});

// ─── Coach profile (performer identity) ─────────────
// Persistent performer-specific state used to personalize every coach
// response: niche, platform, goals, hard NOs, regulars, style prefs.
// Local-only (electron-store pattern) for privacy — see coach-profile.js
// for the decision rationale.
ipcMain.handle('coach:profile-get', async () => {
  try { return await coachProfile.get(); }
  catch (err) { return { error: err?.message || String(err) }; }
});
ipcMain.handle('coach:profile-update', async (_, patch) => {
  try {
    const profile = await coachProfile.update(patch || {});
    profileCloudSync.afterLocalMutation().catch(() => {});
    return { ok: true, profile };
  } catch (err) { return { ok: false, error: err?.message || String(err) }; }
});
ipcMain.handle('profile-sync:sync-now', async () => {
  try {
    const r = await profileCloudSync.syncOnStartup();
    return { ok: true, result: r, profile: await coachProfile.get() };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
});
ipcMain.handle('coach:profile-clear', async () => {
  try { await coachProfile.clear(); return { ok: true }; }
  catch (err) { return { ok: false, error: err?.message || String(err) }; }
});

// ─── Auto-Beauty vision analysis ──────────────────────────
//
// Called from the renderer roughly once every 15 seconds while
// Auto-Beauty is enabled. Receives a base64-encoded JPEG of the
// current webcam frame and returns slider suggestions from Claude
// Haiku. The renderer handles EMA smoothing, delta clamping, and
// manual-touch grace periods — this handler is pure request/response.
//
// Errors always return { reason } objects rather than throwing, so
// the renderer's fallback (leave sliders where they are, try again
// next tick) doesn't need a try/catch around every IPC call.
ipcMain.handle('beauty:analyze-frame', async (_evt, base64Jpeg) => {
  try {
    const { analyzeFrameForBeauty } = require('./auto-beauty-vision');
    const result = await analyzeFrameForBeauty(base64Jpeg);
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, reason: `handler-error: ${err?.message || String(err)}` };
  }
});

// ─── Auth + Subscription state ──────────────────────────
//
// `apexSession`        — persisted Hosted UI tokens + groups
// `apexSubscription`   — last successful /check-subscription result (cached
//                        for 3-day offline grace)
// `expiryWarningLedger`— { `${periodEnd}:${hours}`: firedAt } so we don't
//                        re-fire warnings on every tick
// `adminTierToggle`    — 'free' | 'platinum' | null (session-only UI override)
//
let pendingAuthRequest = null; // { verifier, state, resolve, reject, timeout }
let subscriptionInterval = null;
let adminTierToggle = null; // not persisted — resets each launch

const hostedUiAuth = require('../shared/hosted-ui-auth');
const billingManager = require('../shared/billing-manager');
const {
  SUBSCRIPTION_CHECK_INTERVAL_MS,
} = require('../shared/aws-config');

// ─── Auth IPC handlers ──────────────────────────────────

/**
 * Kick off the Hosted UI flow. Opens Cognito's authorize URL in the
 * system browser and waits for the custom-protocol callback to deliver
 * an authorization code back to the running app instance.
 *
 * Resolves with { success, email, groups } once tokens are exchanged.
 */
ipcMain.handle('auth:hosted-ui-signin', async () => {
  // Cancel any in-flight request (user clicked twice, etc.)
  if (pendingAuthRequest) {
    clearTimeout(pendingAuthRequest.timeout);
    pendingAuthRequest.reject(new Error('cancelled'));
    pendingAuthRequest = null;
  }

  const { verifier, challenge } = hostedUiAuth.generatePkcePair();
  const state = require('crypto').randomBytes(16).toString('hex');
  const url = hostedUiAuth.buildAuthorizeUrl(challenge, state);

  // Open Cognito Hosted UI in the user's default browser
  shell.openExternal(url);

  // Wait up to 5 minutes for the deep-link callback
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (pendingAuthRequest) {
        pendingAuthRequest = null;
        resolve({ success: false, error: 'Sign-in timed out. Please try again.' });
      }
    }, 5 * 60 * 1000);

    pendingAuthRequest = {
      verifier,
      state,
      timeout,
      resolve: (session) => {
        clearTimeout(timeout);
        pendingAuthRequest = null;
        resolve({
          success: true,
          email:   session.email,
          groups:  session.groups,
          isAdmin: session.isAdmin,
          isBeta:  session.isBeta,
        });
        // Kick off immediate subscription fetch now that we have a token
        refreshSubscription().catch(() => {});
      },
      reject: (err) => {
        clearTimeout(timeout);
        pendingAuthRequest = null;
        resolve({ success: false, error: err.message || 'Sign-in failed' });
      },
    };
  });
});

ipcMain.handle('auth:get-session', async () => {
  const sess = store.get('apexSession');
  if (!sess) return null;

  // Refresh if the ID token is close to expiring
  if (hostedUiAuth.needsRefresh(sess)) {
    try {
      const refreshed = await hostedUiAuth.refreshTokens(sess.refreshToken);
      store.set('apexSession', refreshed);
      return {
        email:   refreshed.email,
        groups:  refreshed.groups,
        isAdmin: refreshed.isAdmin,
        isBeta:  refreshed.isBeta,
      };
    } catch (e) {
      // Refresh failed — tokens invalid, clear the session
      store.delete('apexSession');
      return null;
    }
  }

  if (!hostedUiAuth.isSessionValid(sess)) return null;
  return {
    email:   sess.email,
    groups:  sess.groups  || [],
    isAdmin: !!sess.isAdmin,
    isBeta:  !!sess.isBeta,
  };
});

ipcMain.handle('auth:sign-out', async () => {
  store.delete('apexSession');
  store.delete('apexSubscription');
  store.delete('expiryWarningLedger');
  adminTierToggle = null;
  // Opening the Cognito logout URL clears the Hosted UI session cookie
  try { await shell.openExternal(hostedUiAuth.buildLogoutUrl()); } catch {}
  return true;
});

// Back-compat shims — older renderer code paths may still call these.
// Both now proxy to the Hosted UI versions.
ipcMain.handle('aws:get-session', async () => {
  const sess = store.get('apexSession');
  if (!sess || !hostedUiAuth.isSessionValid(sess)) return null;
  return { email: sess.email };
});
ipcMain.handle('aws:sign-out', async () => {
  store.delete('apexSession');
  store.delete('apexSubscription');
  store.delete('expiryWarningLedger');
  adminTierToggle = null;
  return true;
});

// ─── Subscription IPC handlers ──────────────────────────

async function refreshSubscription() {
  const sess = store.get('apexSession');
  if (!sess?.idToken) return null;

  // Ensure token is fresh before calling the API
  let idToken = sess.idToken;
  if (hostedUiAuth.needsRefresh(sess)) {
    try {
      const refreshed = await hostedUiAuth.refreshTokens(sess.refreshToken);
      store.set('apexSession', refreshed);
      idToken = refreshed.idToken;
    } catch {
      // Stale session — caller will handle via auth:get-session
    }
  }

  const cached = store.get('apexSubscription') || null;
  const sub = await billingManager.fetchSubscription(idToken, cached);

  // Only persist successful checks — failed calls just return the cache
  // enriched with offline/grace info; we don't want to overwrite cache
  // with stale data on every offline tick.
  if (!sub.offline) {
    store.set('apexSubscription', {
      plan:          sub.plan,
      expiresAt:     sub.expiresAt,
      billingSource: sub.billingSource,
      groups:        sub.groups,
      features:      sub.features,
      featureMap:    sub.featureMap,
      checkedAt:     sub.checkedAt,
    });
  }

  // Fire expiry warnings (72h, 24h) if we've crossed into a window
  const ledger = store.get('expiryWarningLedger') || {};
  const { toFire, ledger: nextLedger } = billingManager.computeExpiryWarnings(sub, ledger);
  if (toFire.length) {
    store.set('expiryWarningLedger', nextLedger);
    for (const warning of toFire) fireExpiryNotification(warning);
  }

  // Broadcast soft-expire so the renderer can show the re-subscribe banner
  if (sub.softExpired) {
    mainWindow?.webContents.send('subscription:soft-expired', {
      plan:      sub.plan,
      checkedAt: sub.checkedAt,
    });
  }

  // Always push the latest tier to the renderer
  mainWindow?.webContents.send('subscription:updated', sub);

  return sub;
}

ipcMain.handle('subscription:get', async (_, { force } = {}) => {
  if (force) return refreshSubscription();
  const cached = store.get('apexSubscription') || null;
  if (cached) return cached;
  return refreshSubscription();
});

ipcMain.handle('subscription:refresh', () => refreshSubscription());

// Admin Dev Access toggle — only takes effect if the signed-in user is
// actually in the `admins` Cognito group. Session-only (resets on quit).
ipcMain.handle('admin:set-tier-toggle', (_, tier) => {
  const sess = store.get('apexSession');
  if (!sess?.isAdmin) return { ok: false, error: 'not_admin' };
  const VALID_TIERS = new Set(['free', 'platinum', 'agency']);
  if (tier !== null && !VALID_TIERS.has(tier)) {
    return { ok: false, error: 'invalid_tier' };
  }
  adminTierToggle = tier;
  mainWindow?.webContents.send('admin:tier-toggle-changed', { tier });
  return { ok: true, tier };
});
ipcMain.handle('admin:get-tier-toggle', () => adminTierToggle);

// ─── Broadcast usage (analytics-only) ──────────────────
// Returns today's broadcast usage for display in the UI. No enforcement
// is attached to this — Platinum and Agency have unlimited broadcasting.
// The returned shape gives the UI enough to render "3.2 hours broadcast
// today" style status without implying any cap.
ipcMain.handle('broadcast:get-today-usage', () => {
  try {
    return { ok: true, usage: broadcastLedger.getTodayUsage() };
  } catch (err) {
    return { ok: false, error: err?.message || 'unknown_error' };
  }
});

// ─── Expiry notifications ───────────────────────────────
function fireExpiryNotification({ hours, expiresAt }) {
  try {
    const title = hours >= 48
      ? '⚡ Apex Revenue — Platinum expires in 3 days'
      : '⚡ Apex Revenue — Platinum expires in 24 hours';
    const body = hours >= 48
      ? `Your Platinum subscription ends ${new Date(expiresAt).toLocaleString()}. Renew now to keep AI prompts, whale alerts, and cloud sync active.`
      : `Last chance — Platinum expires in 24 hours. Without renewal, AI prompts and premium features will be disabled.`;

    if (!Notification.isSupported()) {
      // No native notifications — fall back to an in-app toast via IPC
      mainWindow?.webContents.send('subscription:expiry-warning', { hours, expiresAt });
      return;
    }

    const n = new Notification({
      title, body,
      icon: path.join(__dirname, '../assets/icons/icon.ico'),
      urgency: hours <= 24 ? 'critical' : 'normal',
    });
    n.on('click', () => {
      mainWindow?.show();
      mainWindow?.focus();
      shell.openExternal('https://apexrevenue.works/billing');
    });
    n.show();

    // Also notify the renderer so the in-app banner updates immediately
    mainWindow?.webContents.send('subscription:expiry-warning', { hours, expiresAt });
  } catch (e) {
    console.error('[expiry-notification]', e);
  }
}

ipcMain.handle('aws:sign-in', async (_, email, password) => {
  const auth = require('../shared/auth');
  try {
    const session = await auth.signIn(email, password);
    store.set('apexSession', session);
    return { success: true, email: session.claims?.email };
  } catch (e) { return { success: false, error: e.message || 'Sign in failed' }; }
});

// ─── AI Trigger Detection ───────────────────────────────
const triggerCooldowns = {};

function checkAiTriggers(snapshot) {
  const now = Date.now();
  const { AI_TRIGGERS } = require('../shared/apex-config');

  // Dead air: no tips for 3+ minutes
  const lastTip = snapshot.recentTips?.[0];
  if (!lastTip || (now - lastTip.timestamp) > 180000) {
    fireTrigger(AI_TRIGGERS.DEAD_AIR, snapshot, now);
  }

  // Viewer surge: 60+ viewers
  if (snapshot.viewers >= 60) {
    fireTrigger(AI_TRIGGERS.VIEWER_SURGE, snapshot, now);
  }

  // Whale present
  if (snapshot.whales?.length && snapshot.whales[0].total >= 200) {
    fireTrigger(AI_TRIGGERS.WHALE_PRESENT, snapshot, now);
  }

  // Hot streak: 500+ tokens/hr
  if (snapshot.tokensPerHour >= 500) {
    fireTrigger(AI_TRIGGERS.HOT_STREAK, snapshot, now);
  }
}

async function fireTrigger(trigger, context, now) {
  const last = triggerCooldowns[trigger.key] || 0;
  if (now - last < trigger.cooldownMs) return;
  triggerCooldowns[trigger.key] = now;

  try {
    await ipcMain.emit('aws:bedrock-prompt', null, trigger.key, context);
  } catch (e) { console.error('AI trigger error:', e); }
}

// ─── CloudWatch Heartbeat ───────────────────────────────
function startHeartbeat() {
  const { CW_HEARTBEAT_INTERVAL_MS } = require('../shared/aws-config');
  cwInterval = setInterval(() => {
    if (!store.get('awsMetricsEnabled')) return;
    const snapshot = tracker.getSnapshot();
    awsServices.emitHeartbeat(snapshot).catch(() => {});
  }, CW_HEARTBEAT_INTERVAL_MS);
}

// Register the apex-file:// privileged scheme BEFORE app.whenReady().
// This is how the renderer loads user-specified local files (images for
// image sources, video files for media sources) without disabling
// webSecurity. The flags:
//   • standard: lets the scheme behave like http:// for security policy
//   • secure:   treats responses as coming from a secure origin
//   • stream:   supports range requests — required by <video> elements
//               playing long files (seeking, chunked load)
//   • bypassCSP: render-side Content-Security-Policy doesn't block it
//   • supportFetchAPI: lets fetch() / Image()  work against the scheme
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'apex-file',
    privileges: {
      standard: true,
      secure: true,
      stream: true,
      bypassCSP: true,
      supportFetchAPI: true,
    },
  },
  {
    // apex-mp:// serves locally-installed MediaPipe WASM + model assets.
    // Needs bypassCSP (WebAssembly.instantiateStreaming fetches the .wasm
    // and must not be blocked by the renderer's CSP) and supportFetchAPI
    // (MediaPipe's FilesetResolver uses fetch() under the hood).
    scheme: 'apex-mp',
    privileges: {
      standard: true,
      secure: true,
      bypassCSP: true,
      supportFetchAPI: true,
    },
  },
]);

// ─── Hosted UI deep-link: apexrevenue:// ────────────────
//
// Cognito redirects to `apexrevenue://auth/callback?code=...` after sign-in.
// Register this app as the OS handler for the scheme so Chrome (or whatever
// browser the user completed the Hosted UI flow in) can hand the URL back.
//
// We also need a single-instance lock: if the user clicks a magic link
// while the app is already running, Electron would normally spawn a second
// instance and the callback would land in the fresh process (with no
// pending PKCE verifier). Acquiring the lock forces that second launch to
// forward its argv (Windows/Linux) or `open-url` event (macOS) to the
// running instance via the `second-instance` event.
if (process.defaultApp) {
  // During `npm start` we need to pass argv[1] so Electron knows which
  // script to hand the deep-link to.
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient('apexrevenue', process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient('apexrevenue');
}

function handleAuthCallbackUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return;
  if (!rawUrl.startsWith('apexrevenue://')) return;

  // Normalize: `apexrevenue://auth/callback?code=...&state=...`
  let parsed;
  try { parsed = new URL(rawUrl); }
  catch { return; }

  const host = parsed.hostname; // 'auth'
  const segment = (parsed.pathname || '').replace(/^\//, '');

  // Sign-out callback — just surface the event; state is already cleared
  if (host === 'auth' && segment === 'signout') {
    mainWindow?.webContents.send('auth:signed-out-remote');
    return;
  }

  // Sign-in callback — exchange code for tokens
  if (host === 'auth' && segment === 'callback') {
    const code  = parsed.searchParams.get('code');
    const state = parsed.searchParams.get('state');
    const error = parsed.searchParams.get('error');

    if (!pendingAuthRequest) {
      // No request in flight — ignore (browser bookmarked the callback, etc.)
      return;
    }
    if (error) {
      pendingAuthRequest.reject(new Error(parsed.searchParams.get('error_description') || error));
      return;
    }
    if (state !== pendingAuthRequest.state) {
      pendingAuthRequest.reject(new Error('OAuth state mismatch'));
      return;
    }
    if (!code) {
      pendingAuthRequest.reject(new Error('No authorization code in callback'));
      return;
    }

    hostedUiAuth.exchangeCodeForTokens(code, pendingAuthRequest.verifier)
      .then((session) => {
        store.set('apexSession', session);
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
        pendingAuthRequest.resolve(session);
      })
      .catch((err) => pendingAuthRequest.reject(err));
  }
}

// Windows / Linux: second launch → forward argv to primary instance
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    // Find the deep-link argument (Windows appends it to argv)
    const deepLink = argv.find((arg) => arg && arg.startsWith('apexrevenue://'));
    if (deepLink) handleAuthCallbackUrl(deepLink);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// macOS: system fires 'open-url' instead of re-launching
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleAuthCallbackUrl(url);
});

// ─── App Lifecycle ──────────────────────────────────────
app.whenReady().then(async () => {
  // Initialize the error logger FIRST so any subsequent startup error
  // has somewhere to land. Needs to happen in whenReady (not at import
  // time) because it uses app.getPath('userData') which is only
  // valid after the app is initialized.
  errorLogger.init();

  // Main-process uncaught exception: a last-line-of-defense for bugs
  // that slip through try/catch in async code. Log it and KEEP GOING
  // — Node's default behavior on uncaughtException is to exit, which
  // would be worse UX than a potentially-degraded-but-running app.
  // If the exception is fatal (e.g. corrupted state), later code
  // paths will fail more cleanly with their own error messages.
  process.on('uncaughtException', (err) => {
    try {
      errorLogger.log('fatal', 'main.uncaught', err && err.message, {
        stack: err && err.stack,
        name: err && err.name,
      });
    } catch {}
    console.error('[main] uncaughtException:', err);
  });

  // Promises rejected without a .catch land here. Common source of
  // silent bugs in async IPC handlers.
  process.on('unhandledRejection', (reason) => {
    try {
      const isErr = reason instanceof Error;
      errorLogger.log('error', 'main.rejection',
        isErr ? reason.message : String(reason),
        { stack: isErr ? reason.stack : undefined }
      );
    } catch {}
    console.error('[main] unhandledRejection:', reason);
  });

  // Renderer process crashed or was killed. Happens when the renderer
  // hits an OOM, a native module crashes, or Chromium itself segfaults.
  // The user would otherwise just see a blank window — logging this
  // at least gives us a breadcrumb.
  app.on('render-process-gone', (_event, _webContents, details) => {
    try {
      errorLogger.log('fatal', 'renderer.gone', `Renderer exited: ${details.reason}`, {
        exitCode: details.exitCode,
        reason: details.reason,
      });
    } catch {}
    console.error('[main] render-process-gone:', details);
  });

  // Wire the apex-file:// handler. Incoming URLs look like
  //   apex-file:///C:/Users/Ridge/Pictures/banner.png
  // which we parse into a native filesystem path via fileURLToPath.
  // Serves the file back to the renderer with a best-guess Content-Type
  // based on extension so <img>/<video> decode it correctly.
  protocol.handle('apex-file', async (req) => {
    try {
      const url = new URL(req.url);
      // pathname on Windows looks like '/C:/Users/...'; strip the leading
      // slash to get a usable native path.
      let filePath = decodeURIComponent(url.pathname);
      if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(filePath)) {
        filePath = filePath.slice(1);
      }
      if (!fs.existsSync(filePath)) {
        return new Response('Not found', { status: 404 });
      }
      const ext = path.extname(filePath).toLowerCase();
      const contentType = {
        '.png':  'image/png',
        '.jpg':  'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.webp': 'image/webp',
        '.gif':  'image/gif',
        '.bmp':  'image/bmp',
        '.mp4':  'video/mp4',
        '.webm': 'video/webm',
        '.mov':  'video/quicktime',
        '.mkv':  'video/x-matroska',
        '.m4v':  'video/mp4',
      }[ext] || 'application/octet-stream';

      // Honor Range requests for <video> seeking. Without this, seeking
      // a long video file would fail because Chromium expects partial
      // responses and we'd be sending the whole file.
      const stat = fs.statSync(filePath);
      const range = req.headers.get('range');
      if (range) {
        const match = /bytes=(\d+)-(\d+)?/.exec(range);
        if (match) {
          const start = parseInt(match[1], 10);
          const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
          const chunkSize = end - start + 1;
          const stream = fs.createReadStream(filePath, { start, end });
          return new Response(stream, {
            status: 206,
            headers: {
              'Content-Type': contentType,
              'Content-Range': `bytes ${start}-${end}/${stat.size}`,
              'Accept-Ranges': 'bytes',
              'Content-Length': String(chunkSize),
              'Cache-Control': 'no-cache',
            },
          });
        }
      }
      const buffer = fs.readFileSync(filePath);
      return new Response(buffer, {
        headers: {
          'Content-Type': contentType,
          'Content-Length': String(stat.size),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'no-cache',
        },
      });
    } catch (err) {
      console.error('[main] apex-file handler error:', err.message);
      return new Response('Internal error', { status: 500 });
    }
  });

  // ─── MediaPipe installer: protocol + IPC ───
  // Serves installed WASM + model files over apex-mp:// so MediaPipe's
  // FilesetResolver can load them without network. The installer module
  // owns all disk layout and lifecycle concerns — main.js just wires IPC.
  try {
    mediapipeInstaller.registerProtocol();
    console.log('[main] apex-mp:// handler registered for MediaPipe assets');
  } catch (err) {
    console.error('[main] apex-mp:// registration failed:', err.message);
  }

  // Bind coach-knowledge to Electron's user-data directory. Creates
  // <userData>/coach-knowledge/ lazily on first /research call. The
  // Coach can draw on this library automatically once artifacts are
  // in place.
  try {
    coachKnowledge.init(app);
    console.log('[main] coach-knowledge initialized at', app.getPath('userData'));
  } catch (err) {
    console.error('[main] coach-knowledge init failed:', err.message);
  }

  // Bind coach-profile (the performer's persistent identity/prefs).
  // Uses a single JSON file in userData, same directory as the
  // knowledge artifacts. Loads lazily on first get/update.
  try {
    coachProfile.init(app);
    profileCloudSync.init({
      store,
      coachProfile,
      getS3: () => awsServices.getS3Client(),
    });
    console.log('[main] coach-profile initialized at', app.getPath('userData'));
  } catch (err) {
    console.error('[main] coach-profile init failed:', err.message);
  }

  ipcMain.handle('mediapipe:status',    async () => mediapipeInstaller.getStatus());
  ipcMain.handle('mediapipe:uninstall', async () => mediapipeInstaller.uninstall());
  ipcMain.handle('mediapipe:install',   async (evt) => {
    // Stream progress events back to the renderer that initiated the
    // install. Using sender lets us scope to the right window even if
    // other BrowserWindows exist.
    const sender = evt.sender;
    const onProgress = (p) => {
      try { sender.send('mediapipe:progress', p); } catch {}
    };
    try {
      const status = await mediapipeInstaller.install({ onProgress });
      return { ok: true, status };
    } catch (err) {
      return { ok: false, error: err.message || String(err) };
    }
  });

  // Auto-approve media permissions (camera, mic, screen) in the renderer.
  // Without this, getUserMedia calls silently fail — the browser prompt
  // never appears in a frameless Electron window.
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    const allowed = ['media', 'display-capture', 'mediaKeySystem', 'geolocation'];
    callback(allowed.includes(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    const allowed = ['media', 'display-capture', 'mediaKeySystem'];
    return allowed.includes(permission);
  });

  // Preflight: probe dshow for device alt-names BEFORE the renderer starts
  // and calls getUserMedia on webcams. Windows cameras can go into an
  // exclusive-access state once held, and subsequent
  // `ffmpeg -list_devices true -f dshow -i dummy` probes may miss them
  // entirely or return them without the Alternative name line. Running
  // the probe at true app startup beats this race.
  //
  // The alt name (e.g. "@device_pnp_\\?\usb#vid_04f2&pid_b75e...") is
  // what we hand to FFmpeg at stream time in place of the friendly name
  // — it's colon-free so FFmpeg's av_strtok(":") dshow parser doesn't
  // mis-split on it. See stream-engine.js _resolveDshowVideoName for
  // full rationale.
  //
  // Best-effort: if FFmpeg isn't yet installed (first run), the probe
  // no-ops and the cache gets populated lazily at stream time instead.
  try {
    const pre = await streamEngine.preflightDeviceDetection();
    console.log(`[main] Preflight cached alt names for ${pre.cachedCount} webcam(s)`);
  } catch (err) {
    console.warn('[main] Preflight probe failed (non-fatal):', err.message);
  }

  createMainWindow();
  createCamView();
  createTray();

  // Phase 0: signal engine wires up IPC listeners ('cam:live-update',
  // 'signal-engine:set-thresholds', etc.) and emits ranked prompts back to
  // the renderer on 'signal-engine:update'.
  signalEngine.attach(mainWindow);

  // Load scenes from store
  const savedScenes = store.get('scenes') || [];
  sceneManager.init(savedScenes, store.get('activeSceneId'));

  // Save scenes whenever they change
  sceneManager.on('change', () => {
    store.set('scenes', sceneManager.getAll());
    store.set('activeSceneId', sceneManager.getActiveId());
    mainWindow?.webContents.send('scenes:updated', {
      scenes: sceneManager.getAll(),
      activeId: sceneManager.getActiveId(),
    });
  });

  multiView.init({
    store,
    sceneManager,
    getMainWindow: () => mainWindow,
    streamEngine,
  });

  ipcMain.handle('multi-view:apply-primary-stream', () => {
    try {
      multiView.applyPrimaryStreamFromScene();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e?.message || String(e) };
    }
  });

  // Stream status updates — forward to the renderer for the LIVE/FPS
  // badges in the preview header. The v3.3.19-v3.3.20 webcam release
  // handshake was removed in v3.3.24 because the pipe-streaming path
  // keeps the camera in the renderer permanently (no more release/
  // restore dance needed).
  // Track the last stream error we wrote to the error log. During an
  // FFmpeg failure shutdown the stream engine can emit 'status' 4-8
  // times in quick succession (close handler, ledger stop, cleanup,
  // final flush) — each with status.errorReason still populated.
  // Without dedup, the error log shows the same failure logged six
  // times in a row with identical errorLogPath, which drowns the
  // signal when debugging real recurring issues. Keep a tiny cache
  // of the last (errorReason, errorLogPath) tuple and skip writes
  // that match it. Reset when errorReason clears (stream success /
  // clean stop) so the next distinct failure WILL log.
  let _lastLoggedStreamError = null;

  streamEngine.on('status', (status) => {
    mainWindow?.webContents.send('stream:status', status);
    // Mirror stream errors into the central log so the Debug panel
    // surfaces them alongside other errors. The stream engine still
    // writes its own detailed per-incident log to userData/stream-logs/;
    // this is a shorter breadcrumb for the unified view.
    if (status && status.errorReason) {
      const key = `${status.errorReason}|${status.errorLogPath || ''}`;
      if (key !== _lastLoggedStreamError) {
        _lastLoggedStreamError = key;
        errorLogger.log('error', 'stream-engine', status.errorReason, {
          errorLogPath: status.errorLogPath,
        });
      }
    } else {
      // No error on this status update — clear the dedup cache so a
      // subsequent failure (possibly with identical message) re-logs.
      _lastLoggedStreamError = null;
    }
  });

  // When the stream engine's runtime encoder probe discovers that the
  // user's saved videoEncoder choice doesn't actually work on this
  // machine (e.g. h264_nvenc on a box without NVIDIA drivers), it emits
  // 'encoder-auto-changed'. Persist the working encoder to the store so
  // the user doesn't hit the same failure path next launch, and tell the
  // renderer so the UI can refresh + toast.
  streamEngine.on('encoder-auto-changed', ({ requested, resolved, reason }) => {
    errorLogger.log('warn', 'stream-engine', `Encoder auto-changed: ${requested} -> ${resolved}`, { reason });
    const current = store.get('obsSettings') || {};

    // Bitrate must also be recomputed when the encoder class changes.
    // Hardware encoders (NVENC/QSV/AMF) are more bit-efficient and can
    // stream clean HD at 3000-4000 kbps; software encoders (libopenh264/
    // libx264) need 3500-4500 for equivalent quality on a cam platform.
    // Falling back from hardware to software without bumping bitrate is
    // what triggered Chaturbate's "bitrate much lower than recommended"
    // warning for Ridge on v3.3.3 → fixed here in v3.3.4.
    const height = current.resolution?.height || 1080;
    const newBitrate = autoconfig.recommendBitrate(height, resolved);

    const updated = {
      ...current,
      videoEncoder: resolved,
      videoBitrate: newBitrate,
      _encoderAutoHealedAt: new Date().toISOString(),
      _encoderAutoHealedFrom: requested,
      _bitrateAutoAdjustedFrom: current.videoBitrate,
    };
    store.set('obsSettings', updated);
    console.log(`[Apex] Encoder auto-healed: ${requested} → ${resolved}. Bitrate: ${current.videoBitrate} → ${newBitrate}. Reason: ${reason}`);
    mainWindow?.webContents.send('obs-settings:encoder-auto-healed', {
      requested,
      resolved,
      reason,
      bitrateFrom: current.videoBitrate,
      bitrateTo: newBitrate,
    });
    mainWindow?.webContents.send('obs-settings:auto-refreshed', {
      encoder: resolved,
      videoBitrate: newBitrate,
    });
  });

  // Initialize AWS (silently)
  try { await awsServices.init(store); }
  catch (e) { console.error('AWS init error:', e); }

  try {
    const pr = await profileCloudSync.syncOnStartup();
    if (pr && !pr.skipped) console.log('[profile-cloud-sync] startup:', pr.direction || pr);
  } catch (e) {
    console.warn('[profile-cloud-sync] startup sync failed:', e.message);
  }

  // Check FFmpeg availability and notify renderer
  const ffmpegPath = ffmpegInstaller.findFFmpegPath();
  if (ffmpegPath) {
    streamEngine.ffmpegPath = ffmpegPath;
  }
  // Renderer will receive ffmpeg status via 'ffmpeg:check' IPC on load

  // First-launch OBS autoconfig. Runs once, ever. User edits after this
  // point are saved via store.set('obsSettings', ...) and always win on
  // subsequent launches — see maybeFirstRunObsAutoconfig for the guard.
  await maybeFirstRunObsAutoconfig();

  startHeartbeat();

  // ─── Cloud Sync Bootstrap (Phase 0) ──────────────────
  // If the performer is signed in, pull whales/prompts/preferences/thresholds
  // from RDS and seed the signal engine. Safe to skip on first-run or when
  // offline — the signal engine falls back to DEFAULT_THRESHOLDS and the push
  // queue holds mutations until the next connection window.
  (async () => {
    try {
      const auth = require('../shared/auth');
      const sess = store.get('apexSession');
      if (!sess || !auth.isSessionValid(sess)) return;

      const cache = await cloudSync.pullAll(sess.idToken);
      if (cache && cache.thresholds) signalEngine.thresholds = cache.thresholds;
      if (cache && cache.history30d) signalEngine.thirtyDayHistory = cache.history30d;

      // Flush the offline push queue every 60s while signed in.
      setInterval(() => {
        const s = store.get('apexSession');
        if (s && auth.isSessionValid(s)) {
          cloudSync.flushQueue(s.idToken).catch(() => {});
        }
      }, 60000);
    } catch (e) {
      console.warn('[CloudSync] bootstrap failed, continuing with local cache:', e.message);
    }
  })();

  // ─── Subscription polling (tier + offline grace + expiry warnings) ──
  // Kick off an immediate refresh so the renderer gets tier data as soon
  // as it mounts, then poll hourly. The poller handles offline gracefully
  // via the 3-day grace window in billing-manager.
  (async () => {
    try {
      const sess = store.get('apexSession');
      if (sess?.idToken && hostedUiAuth.isSessionValid(sess)) {
        refreshSubscription().catch(() => {});
      }
    } catch (e) {
      console.warn('[Subscription] initial refresh failed:', e.message);
    }
  })();

  if (subscriptionInterval) clearInterval(subscriptionInterval);
  subscriptionInterval = setInterval(() => {
    const sess = store.get('apexSession');
    if (sess?.idToken) refreshSubscription().catch(() => {});
  }, SUBSCRIPTION_CHECK_INTERVAL_MS);

  // ─── Auto-Updater ────────────────────────────────────
  setupAutoUpdater();
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600000);
});

// ─── Auto-Updater Setup ─────────────────────────────────
let updateReady = false;
let downloadedInstallerPath = null; // captured from update-downloaded event

function setupAutoUpdater() {
  // Unsigned NSIS builds: Windows updater defaults to verifying Authenticode.
  // Without a cert, verification fails and updates never become "available".
  // build.win.verifyUpdateCodeSignature is also set false in package.json.
  if (process.platform === 'win') {
    try {
      autoUpdater.verifyUpdateCodeSignature = false;
    } catch (_) { /* older electron-updater */ }
  }
  autoUpdater.autoDownload = true;
  // Disable auto-install on quit — we handle install explicitly via IPC
  // Having both autoInstallOnAppQuit=true AND calling quitAndInstall() causes a
  // race: the before-quit handler fires a second quitAndInstall which kills the
  // first relaunch attempt before it can spawn the new process.
  autoUpdater.autoInstallOnAppQuit = false;

  autoUpdater.on('checking-for-update', () => {
    mainWindow?.webContents.send('updates:status', { state: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    mainWindow?.webContents.send('updates:status', {
      state: 'available',
      version: info.version,
    });
  });

  autoUpdater.on('update-not-available', () => {
    mainWindow?.webContents.send('updates:status', { state: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    mainWindow?.webContents.send('updates:status', {
      state: 'downloading',
      percent: Math.round(progress.percent),
      bytesPerSecond: progress.bytesPerSecond,
    });
  });

  autoUpdater.on('update-downloaded', (info) => {
    updateReady = true;
    // electron-updater provides the cached installer path in info.downloadedFile
    downloadedInstallerPath = info.downloadedFile || null;
    mainWindow?.webContents.send('updates:status', {
      state: 'ready',
      version: info.version,
    });
  });

  autoUpdater.on('error', (err) => {
    mainWindow?.webContents.send('updates:status', {
      state: 'error',
      message: err.message,
    });
  });
}

// ─── IPC: Manual update check + install ─────────────────
//
// IMPORTANT: electron-updater's checkForUpdates() resolves to an
// UpdateCheckResult object that contains non-clonable internals
// (AbortController, cancellationToken, downloadPromise with native
// bindings). Returning it raw across the IPC boundary throws
// "An object could not be cloned" — which is what was showing up in
// errors.log for every manual update check. We extract just the
// fields the renderer actually needs.
ipcMain.handle('updates:check', async () => {
  const currentVersion = app.getVersion();
  try {
    const result = await autoUpdater.checkForUpdates();
    // checkForUpdates() resolves null when the updater is inactive (unpackaged app
    // without forceDevUpdateConfig) — no feed is queried, no events fire.
    if (result == null) {
      return {
        ok: true,
        currentVersion,
        updaterInactive: true,
        updateInfo: null,
        isUpdateAvailable: false,
      };
    }
    if (!result.updateInfo) {
      return { ok: true, currentVersion, updaterInactive: false, updateInfo: null, isUpdateAvailable: false };
    }
    const { version, releaseDate, releaseName, releaseNotes } = result.updateInfo;
    return {
      ok: true,
      currentVersion,
      updaterInactive: false,
      isUpdateAvailable: !!result.isUpdateAvailable,
      updateInfo: {
        version: version || null,
        releaseDate: releaseDate || null,
        releaseName: releaseName || null,
        // releaseNotes can be a string OR an array of {version,note} objects
        // depending on the provider; both forms are structured-clone safe.
        releaseNotes: releaseNotes || null,
      },
    };
  } catch (e) {
    return { ok: false, currentVersion, error: e?.message || String(e) };
  }
});

ipcMain.on('updates:install', () => {
  if (!updateReady) return;

  isQuitting = true;
  isUpdating = true; // prevent window-all-closed from calling app.quit() prematurely

  // Write an install log BEFORE we start tearing anything down. If anything
  // below silently fails, this file is the only surviving evidence of what
  // the update handler attempted — Ridge (or a future user) can inspect
  // %APPDATA%/apex-revenue-desktop/logs/update-*.log after a failed update.
  const logDir = path.join(app.getPath('userData'), 'logs');
  const logPath = path.join(logDir, `update-${new Date().toISOString().replace(/[:.]/g, '-')}.log`);
  const log = (line) => {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
    } catch {}
  };
  log(`updates:install invoked. downloadedInstallerPath=${downloadedInstallerPath}`);
  log(`pid=${process.pid} platform=${process.platform} app.getVersion=${app.getVersion()}`);

  // CRITICAL: app.exit(0) below is a hard exit that bypasses the 'before-quit'
  // event, which is where streamEngine.cleanup() normally kills any FFmpeg
  // child processes. If we don't kill them here explicitly, they survive as
  // orphans, keep holding locks on resources\ffmpeg.exe, and NSIS fails with
  // "Failed to uninstall old application files" during the uninstall phase.
  // Also kill cwInterval so no stray heartbeats fire during shutdown.
  try {
    if (cwInterval) clearInterval(cwInterval);
    streamEngine.cleanup();
    log('cleanup: FFmpeg killed + cwInterval cleared');
    console.log('[Updater] Killed FFmpeg + cleared heartbeat before install');
  } catch (e) {
    log(`cleanup ERROR: ${e.message}`);
    console.error('[Updater] Cleanup error (continuing):', e.message);
  }

  // v3.3.9: aggressive window/view teardown. The "ApexRevenue cannot be
  // closed" NSIS error fires when the installer detects our process
  // tree is still alive during its uninstall phase. The usual culprits
  // on Windows:
  //   • The cam-platform BrowserView is a separate WebContents process.
  //     Its embedded page (Chaturbate/Stripchat) may have beforeunload
  //     handlers or open WebSockets that stall graceful close.
  //   • Secondary BrowserWindows (if any) — must close all, not just
  //     mainWindow, before quitAndInstall can proceed.
  //   • Slow AWS/IoT/MQTT teardown keeping the main process event loop
  //     alive past the installer's wait timeout.

  // 1) Detach and destroy the cam BrowserView first — its page is most
  //    likely to have beforeunload stalls. BrowserView.webContents.close()
  //    forces close without running before-unload. webContents.destroy()
  //    (undocumented but exists) fully tears down the process.
  try {
    if (typeof camView !== 'undefined' && camView) {
      try { mainWindow?.removeBrowserView?.(camView); } catch {}
      try { camView.webContents?.close({ waitForBeforeUnload: false }); } catch {}
      try { camView.webContents?.destroy?.(); } catch {}
      log('camView destroyed');
    }
  } catch (e) {
    log(`camView teardown ERROR: ${e.message}`);
  }

  // 2) Destroy ALL BrowserWindows, not just mainWindow. Strip listeners
  //    first so 'close' handlers with e.preventDefault() can't block.
  try {
    const allWindows = BrowserWindow.getAllWindows();
    for (const win of allWindows) {
      try {
        win.removeAllListeners('close');
        win.removeAllListeners('before-unload');
        // webContents.close({waitForBeforeUnload:false}) is an Electron
        // 22+ API that skips the beforeunload prompt chain.
        try { win.webContents?.close({ waitForBeforeUnload: false }); } catch {}
        win.destroy();
      } catch {}
    }
    log(`Destroyed ${allWindows.length} window(s)`);
  } catch (e) {
    log(`window teardown ERROR: ${e.message}`);
  }

  // 2.5) Destroy the system tray icon. Tray holds a Windows system
  //      resource handle that can prevent the main process from
  //      exiting cleanly. Without this, the process remains alive in
  //      the background even after all windows are gone.
  try {
    if (typeof tray !== 'undefined' && tray && !tray.isDestroyed?.()) {
      tray.destroy();
      log('tray destroyed');
    }
  } catch (e) {
    log(`tray teardown ERROR: ${e.message}`);
  }

  // 3) Give child processes ~500ms to actually die after destroy(). The
  //    BrowserView/renderer processes exit asynchronously on Windows.
  setTimeout(() => {
    try {
      const installerPath = downloadedInstallerPath;
      log(`setTimeout fired. installerPath=${installerPath} exists=${installerPath && fs.existsSync(installerPath)}`);

      // BACKGROUND: earlier versions tried to launch the installer via a
      // detached PowerShell spawn + .unref(). That looks correct on every
      // other platform, but on Windows Electron apps run inside a Job
      // Object — when app.exit() fires, Windows kills ALL processes in
      // that job, including our "detached" PowerShell, BEFORE the
      // installer can be spawned. Node's detached flag maps to
      // DETACHED_PROCESS on Windows, not CREATE_BREAKAWAY_FROM_JOB.
      //
      // autoUpdater.quitAndInstall() ships with electron-updater's
      // Update.exe helper, which IS compiled with the proper breakaway
      // flags. It's the only reliable way to spawn the installer from
      // a dying Electron process on Windows.
      //
      // Args: (isSilent=false, isForceRunAfter=true)
      //   false → don't pass /S — our NSIS config is oneClick:false,
      //           /S causes the wizard to abort in undefined state.
      //   true  → re-launch the new version after install completes.
      log('Calling autoUpdater.quitAndInstall(false, true)');
      autoUpdater.quitAndInstall(false, true);

      // SAFETY NET: quitAndInstall internally calls app.quit(), which
      // waits for all windows to close gracefully and all the app's
      // event loop tasks to drain. If an AWS MQTT connection, a pending
      // network request, or a stuck renderer IPC blocks that drain,
      // Update.exe's wait-for-parent-death check times out and launches
      // the installer while our process is still alive — that's the
      // "ApexRevenue cannot be closed" dialog the user saw on v3.3.7→v3.3.8.
      //
      // Force app.exit(0) after 1.2s as a hard backup. app.exit is a
      // synchronous process-kill that bypasses the event loop entirely.
      // Windows's Job Object will cascade the kill to every renderer/
      // utility child, so by the time Update.exe's installer runs, the
      // whole ApexRevenue.exe process tree is confirmed dead.
      setTimeout(() => {
        log('SAFETY NET: quitAndInstall did not exit within 1.2s — forcing app.exit(0)');
        try { app.exit(0); } catch {}
      }, 1200);
    } catch (err) {
      log(`quitAndInstall ERROR: ${err.message}\n${err.stack || ''}`);
      console.error('[Updater] quitAndInstall failed:', err);
      isUpdating = false;
      // Last-ditch: restart the app in its current state so the user
      // can try again (or download manually).
      app.relaunch();
      app.exit(0);
    }
  }, 500);
});

// ─── IPC: FFmpeg ─────────────────────────────────────────
ipcMain.handle('ffmpeg:check', () => {
  const ffmpegPath = ffmpegInstaller.findFFmpegPath();
  return { installed: !!ffmpegPath, path: ffmpegPath };
});

ipcMain.handle('ffmpeg:install', async () => {
  try {
    const exePath = await ffmpegInstaller.downloadAndInstallFFmpeg((progress) => {
      mainWindow?.webContents.send('ffmpeg:progress', progress);
    });
    mainWindow?.webContents.send('ffmpeg:installed', { success: true, path: exePath });
    // Reload stream engine path now that FFmpeg is available
    streamEngine.ffmpegPath = exePath;
    return { success: true, path: exePath };
  } catch (err) {
    mainWindow?.webContents.send('ffmpeg:installed', { success: false, error: err.message });
    return { success: false, error: err.message };
  }
});

// ─── IPC: Audio device listing (dshow) ───────────────────
ipcMain.handle('sources:get-dshow-devices', async () => {
  const { spawn } = require('child_process');
  const ffmpegPath = ffmpegInstaller.findFFmpegPath() || 'ffmpeg';

  return new Promise((resolve) => {
    const devices = { audio: [], video: [] };

    const proc = spawn(ffmpegPath, [
      '-list_devices', 'true',
      '-f', 'dshow',
      '-i', 'dummy',
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });

    let output = '';
    proc.stderr.on('data', (d) => { output += d.toString(); });

    proc.on('close', () => {
      // Parse dshow device list from FFmpeg stderr output
      const lines = output.split('\n');
      let currentType = null;

      for (const line of lines) {
        if (line.includes('DirectShow audio devices')) { currentType = 'audio'; continue; }
        if (line.includes('DirectShow video devices')) { currentType = 'video'; continue; }

        const match = line.match(/"([^"]+)"\s*\(([^)]+)\)/);
        if (match && currentType) {
          devices[currentType].push({ name: match[1], type: match[2] });
        } else {
          // Alternative parse: lines like  "Microphone (Realtek Audio)"
          const alt = line.match(/dshow.*?"([^"]+)"/);
          if (alt && currentType) {
            devices[currentType].push({ name: alt[1] });
          }
        }
      }

      resolve(devices);
    });

    proc.on('error', () => resolve({ audio: [], video: [] }));

    // FFmpeg exits with error code for this command — that's expected
    setTimeout(() => {
      try { proc.kill(); } catch {}
    }, 5000);
  });
});

// ─── Toy Sync Engine ────────────────────────────────────
// Manages Lovense Connect API, Buttplug.io/Intiface WebSocket,
// and tip-to-vibration mapping for all connected toys.

const http  = require('http');
const https = require('https');

// ── Default vibration tier / pattern config ───────────────
const DEFAULT_TIERS = [
  { label: 'Tease',     minTokens: 1,   intensity: 15,  duration: 2  },
  { label: 'Feel It',   minTokens: 10,  intensity: 35,  duration: 4  },
  { label: 'Intense',   minTokens: 25,  intensity: 60,  duration: 6  },
  { label: 'Wild',      minTokens: 50,  intensity: 80,  duration: 10 },
  { label: 'MAX POWER', minTokens: 100, intensity: 100, duration: 15 },
];

// Step sequences for built-in patterns (intensity 0–100 relative, scaled at runtime)
const PATTERN_STEPS = {
  fireworks:      [
    { i: 100, d: 0.25 }, { i: 0, d: 0.15 }, { i: 80, d: 0.25 }, { i: 0, d: 0.15 },
    { i: 100, d: 0.4  }, { i: 0, d: 0.1  }, { i: 70, d: 0.2  }, { i: 100, d: 0.3 },
    { i: 0,   d: 0.1  }, { i: 90, d: 0.2  }, { i: 0, d: 0.1  }, { i: 100, d: 0.5 },
  ],
  earthquake:     [
    { i: 20, d: 0.5 }, { i: 40, d: 0.5 }, { i: 60, d: 0.5 }, { i: 80, d: 0.8 },
    { i: 100, d: 2.0 }, { i: 100, d: 0.3 }, { i: 80, d: 0.5 }, { i: 60, d: 0.5 },
    { i: 40, d: 0.3 }, { i: 20, d: 0.3 },
  ],
  wave:           [
    { i: 10, d: 0.4 }, { i: 25, d: 0.4 }, { i: 45, d: 0.4 }, { i: 65, d: 0.4 },
    { i: 85, d: 0.4 }, { i: 100, d: 0.8 }, { i: 85, d: 0.4 }, { i: 65, d: 0.4 },
    { i: 45, d: 0.4 }, { i: 25, d: 0.4 }, { i: 10, d: 0.4 }, { i: 0, d: 0.3 },
  ],
  pulse:          [
    { i: 80, d: 0.35 }, { i: 0, d: 0.35 }, { i: 80, d: 0.35 }, { i: 0, d: 0.35 },
    { i: 80, d: 0.35 }, { i: 0, d: 0.35 }, { i: 80, d: 0.35 }, { i: 0, d: 0.35 },
    { i: 80, d: 0.35 }, { i: 0, d: 0.35 },
  ],
  maxvibe:        [{ i: 100, d: 12 }],
  stopthequiver:  [{ i: 0, d: 0.1 }],
};

const DEFAULT_PATTERNS = [
  { id: 'fireworks',     label: 'Fireworks',       tokens: 50,  intensity: 100, enabled: true  },
  { id: 'earthquake',    label: 'Earthquake',      tokens: 75,  intensity: 100, enabled: true  },
  { id: 'wave',          label: 'Wave',            tokens: 25,  intensity: 80,  enabled: true  },
  { id: 'pulse',         label: 'Pulse',           tokens: 15,  intensity: 75,  enabled: true  },
  { id: 'maxvibe',       label: 'Maxvibe',         tokens: 100, intensity: 100, enabled: true  },
  { id: 'stopthequiver', label: 'Stop The Quiver', tokens: 0,   intensity: 0,   enabled: false },
];

let toyState = {
  lovense:  { connected: false, apiToken: '', toys: [], wsUrl: '' },
  buttplug: { connected: false, wsUrl: 'ws://localhost:12345', toys: [], ws: null },
  tipMap:   {
    enabled:  true,
    tiers:    DEFAULT_TIERS,
    patterns: DEFAULT_PATTERNS,
  },
};

// ── Lovense Connect HTTP helper ──────────────────────────
function lovenseRequest(path, params = {}) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ token: toyState.lovense.apiToken, ...params }).toString();
    const url = `https://api.lovense-api.com/api/lan${path}?${qs}`;
    https.get(url, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(data); } });
    }).on('error', reject);
  });
}

// ── Buttplug WebSocket connect ───────────────────────────
function connectButtplug(wsUrl) {
  const { WebSocket } = require('ws');
  if (toyState.buttplug.ws) {
    try { toyState.buttplug.ws.close(); } catch {}
    toyState.buttplug.ws = null;
  }
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error('Timeout')); }, 6000);

    ws.on('open', () => {
      // Buttplug v3 handshake
      ws.send(JSON.stringify([{ RequestServerInfo: { Id: 1, ClientName: 'Apex Revenue', MessageVersion: 3 } }]));
    });

    ws.on('message', (raw) => {
      try {
        const msgs = JSON.parse(raw.toString());
        for (const msg of msgs) {
          if (msg.ServerInfo) {
            clearTimeout(timeout);
            // Start scanning
            ws.send(JSON.stringify([{ StartScanning: { Id: 2 } }]));
            toyState.buttplug.ws = ws;
            toyState.buttplug.connected = true;
            resolve({ ok: true });
          }
          if (msg.DeviceAdded) {
            const d = msg.DeviceAdded;
            const existing = toyState.buttplug.toys.find((t) => t.DeviceIndex === d.DeviceIndex);
            if (!existing) {
              toyState.buttplug.toys.push({ DeviceIndex: d.DeviceIndex, DeviceName: d.DeviceName });
              mainWindow?.webContents.send('sync:state', getSyncState());
            }
          }
          if (msg.DeviceRemoved) {
            toyState.buttplug.toys = toyState.buttplug.toys.filter((t) => t.DeviceIndex !== msg.DeviceRemoved.DeviceIndex);
            mainWindow?.webContents.send('sync:state', getSyncState());
          }
        }
      } catch {}
    });

    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
    ws.on('close', () => {
      toyState.buttplug.connected = false;
      toyState.buttplug.toys = [];
      toyState.buttplug.ws = null;
      mainWindow?.webContents.send('sync:state', getSyncState());
    });
  });
}

function getSyncState() {
  return {
    lovense:  { connected: toyState.lovense.connected, toys: toyState.lovense.toys, apiToken: toyState.lovense.apiToken ? '••••••••' : '' },
    buttplug: { connected: toyState.buttplug.connected, toys: toyState.buttplug.toys, wsUrl: toyState.buttplug.wsUrl },
    tipMap:   toyState.tipMap,
  };
}

// ── Vibrate all connected toys ───────────────────────────
async function vibrateAll(intensity, durationSec) {
  // Lovense
  if (toyState.lovense.connected && toyState.lovense.apiToken) {
    try {
      await lovenseRequest('/command', {
        command: 'Vibrate',
        timeSec: durationSec,
        loopRunningSec: 0,
        loopPauseSec: 0,
        toy: '',  // empty = all toys
        apiVer: 1,
        v: Math.round(intensity / 10),  // Lovense scale 0-20
      });
    } catch (e) { console.warn('[Sync] Lovense vibrate error:', e.message); }
  }

  // Buttplug
  if (toyState.buttplug.connected && toyState.buttplug.ws && toyState.buttplug.toys.length) {
    const strength = Math.min(intensity / 100, 1.0);
    const cmds = toyState.buttplug.toys.map((toy, i) => ({
      LinearCmd: {
        Id: 100 + i,
        DeviceIndex: toy.DeviceIndex,
        Vectors: [{ Index: 0, Duration: durationSec * 1000, Position: strength }],
      },
    }));
    // Use VibrateCmd for vibration toys
    const vibCmds = toyState.buttplug.toys.map((toy, i) => ({
      VibrateCmd: {
        Id: 200 + i,
        DeviceIndex: toy.DeviceIndex,
        Speeds: [{ Index: 0, Speed: strength }],
      },
    }));
    try {
      toyState.buttplug.ws.send(JSON.stringify(vibCmds));
      setTimeout(() => {
        if (toyState.buttplug.ws) {
          const stopCmds = toyState.buttplug.toys.map((toy, i) => ({
            VibrateCmd: { Id: 300 + i, DeviceIndex: toy.DeviceIndex, Speeds: [{ Index: 0, Speed: 0 }] },
          }));
          toyState.buttplug.ws.send(JSON.stringify(stopCmds));
        }
      }, durationSec * 1000);
    } catch (e) { console.warn('[Sync] Buttplug vibrate error:', e.message); }
  }
}

// ── Stop all toys immediately ────────────────────────────
async function stopAll() {
  // Lovense: vibrate intensity 0 for 0 seconds
  if (toyState.lovense.connected && toyState.lovense.apiToken) {
    try {
      await lovenseRequest('/command', { command: 'Vibrate', timeSec: 0, toy: '', apiVer: 1, v: 0 });
    } catch {}
  }
  // Buttplug: send speed 0 to all toys
  if (toyState.buttplug.ws && toyState.buttplug.toys.length) {
    try {
      const cmds = toyState.buttplug.toys.map((toy, i) => ({
        VibrateCmd: { Id: 900 + i, DeviceIndex: toy.DeviceIndex, Speeds: [{ Index: 0, Speed: 0 }] },
      }));
      toyState.buttplug.ws.send(JSON.stringify(cmds));
    } catch {}
  }
}

// ── Execute a named vibration pattern ────────────────────
async function vibratePattern(patternId, intensityScale = 1.0) {
  if (patternId === 'stopthequiver') { await stopAll(); return; }
  const steps = PATTERN_STEPS[patternId];
  if (!steps) return;

  for (const step of steps) {
    const scaled = Math.min(100, Math.round(step.i * intensityScale));
    if (scaled > 0) {
      // Send vibrate but don't use the built-in stop timer — we manage timing here
      if (toyState.lovense.connected && toyState.lovense.apiToken) {
        try {
          await lovenseRequest('/command', {
            command: 'Vibrate', timeSec: step.d + 0.1,
            toy: '', apiVer: 1, v: Math.round(scaled / 5),  // Lovense 0-20
          });
        } catch {}
      }
      if (toyState.buttplug.ws && toyState.buttplug.toys.length) {
        try {
          const cmds = toyState.buttplug.toys.map((toy, i) => ({
            VibrateCmd: { Id: 800 + i, DeviceIndex: toy.DeviceIndex, Speeds: [{ Index: 0, Speed: scaled / 100 }] },
          }));
          toyState.buttplug.ws.send(JSON.stringify(cmds));
        } catch {}
      }
    } else {
      await stopAll();
    }
    // Wait for step duration before next step
    await new Promise((r) => setTimeout(r, Math.round(step.d * 1000)));
  }
  // Always stop cleanly at end
  await stopAll();
}

// ── IPC: Sync handlers ───────────────────────────────────
ipcMain.handle('sync:get-state', () => getSyncState());

ipcMain.handle('sync:lovense-connect', async (_, apiToken) => {
  toyState.lovense.apiToken = apiToken;
  try {
    const res = await lovenseRequest('/getToys');
    if (res.code === 200 || res.result) {
      toyState.lovense.connected = true;
      toyState.lovense.toys = res.data ? Object.values(res.data) : [];
      store.set('lovenseApiToken', apiToken);
      mainWindow?.webContents.send('sync:state', getSyncState());
      return { ok: true, toys: toyState.lovense.toys };
    }
    toyState.lovense.connected = false;
    return { ok: false, error: res.message || 'Invalid token' };
  } catch (e) {
    toyState.lovense.connected = false;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sync:lovense-disconnect', () => {
  toyState.lovense = { connected: false, apiToken: '', toys: [], wsUrl: '' };
  store.set('lovenseApiToken', '');
  mainWindow?.webContents.send('sync:state', getSyncState());
  return { ok: true };
});

ipcMain.handle('sync:buttplug-connect', async (_, wsUrl) => {
  toyState.buttplug.wsUrl = wsUrl || 'ws://localhost:12345';
  try {
    await connectButtplug(toyState.buttplug.wsUrl);
    store.set('buttplugWsUrl', toyState.buttplug.wsUrl);
    mainWindow?.webContents.send('sync:state', getSyncState());
    return { ok: true };
  } catch (e) {
    toyState.buttplug.connected = false;
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sync:buttplug-disconnect', () => {
  if (toyState.buttplug.ws) {
    try { toyState.buttplug.ws.close(); } catch {}
    toyState.buttplug.ws = null;
  }
  toyState.buttplug.connected = false;
  toyState.buttplug.toys = [];
  mainWindow?.webContents.send('sync:state', getSyncState());
  return { ok: true };
});

ipcMain.handle('sync:vibrate', async (_, intensity, durationSec) => {
  await vibrateAll(intensity, durationSec);
  return { ok: true };
});

ipcMain.handle('sync:save-tip-map', (_, tipMap) => {
  // Merge defaults for any missing fields
  toyState.tipMap = {
    enabled:  tipMap.enabled ?? toyState.tipMap.enabled,
    tiers:    tipMap.tiers    || toyState.tipMap.tiers,
    patterns: tipMap.patterns || toyState.tipMap.patterns,
  };
  store.set('toyTipMap', toyState.tipMap);
  return { ok: true };
});

ipcMain.handle('sync:fire-pattern', async (_, patternId, intensityOverride) => {
  const pattern = toyState.tipMap.patterns.find((p) => p.id === patternId);
  const scale = (intensityOverride ?? (pattern?.intensity ?? 100)) / 100;
  await vibratePattern(patternId, scale);
  return { ok: true };
});

// Auto-fire vibration on tips when enabled
const _origOnLiveUpdate = ipcMain.listeners('cam:live-update')[0];
ipcMain.on('cam:tip-vibrate', async (_, tipAmount) => {
  if (!toyState.tipMap.enabled) return;

  // Check custom patterns first (exact token match takes priority)
  const activePatterns = (toyState.tipMap.patterns || [])
    .filter((p) => p.enabled && p.tokens > 0 && p.id !== 'stopthequiver');
  const matchedPattern = activePatterns.find((p) => tipAmount === p.tokens)
    || activePatterns
        .filter((p) => tipAmount >= p.tokens)
        .sort((a, b) => b.tokens - a.tokens)[0];

  if (matchedPattern) {
    await vibratePattern(matchedPattern.id, matchedPattern.intensity / 100);
    return;
  }

  // Fall back to tier-based vibration
  const tiers = [...(toyState.tipMap.tiers || [])].sort((a, b) => b.minTokens - a.minTokens);
  const tier = tiers.find((t) => tipAmount >= t.minTokens);
  if (tier) await vibrateAll(tier.intensity, tier.duration);
});

// Restore saved config
(function restoreSyncConfig() {
  const savedToken  = store?.get?.('lovenseApiToken');
  const savedWsUrl  = store?.get?.('buttplugWsUrl');
  const savedTipMap = store?.get?.('toyTipMap');
  if (savedToken)  toyState.lovense.apiToken  = savedToken;
  if (savedWsUrl)  toyState.buttplug.wsUrl    = savedWsUrl;
  if (savedTipMap) {
    toyState.tipMap = {
      enabled:  savedTipMap.enabled  ?? true,
      tiers:    savedTipMap.tiers?.length    ? savedTipMap.tiers    : DEFAULT_TIERS,
      patterns: savedTipMap.patterns?.length ? savedTipMap.patterns : DEFAULT_PATTERNS,
    };
  }
})();

app.on('activate', () => {
  if (!mainWindow) createMainWindow();
  else mainWindow.show();
});

app.on('before-quit', () => {
  isQuitting = true;
  if (cwInterval) clearInterval(cwInterval);
  if (subscriptionInterval) clearInterval(subscriptionInterval);
  streamEngine.cleanup();
});

app.on('window-all-closed', () => {
  // Don't quit during update install — quitAndInstall handles its own quit
  if (process.platform !== 'darwin' && !isUpdating) app.quit();
});
