/**
 * Apex Revenue Desktop v2 — Main Process
 * Combines Creator Intelligence Engine with full OBS-style streaming platform
 */

const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, desktopCapturer, session, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const Store = require('electron-store');
const awsServices = require('./aws-services');
const streamEngine = require('./stream-engine');
const sceneManager = require('./scene-manager');
const audioMixer = require('./audio-mixer');
const ffmpegInstaller = require('./ffmpeg-installer');
const autoconfig = require('./autoconfig');
const { autoUpdater } = require('electron-updater');
const EarningsTracker = require('../shared/earnings-tracker');
const { VERSION } = require('../shared/apex-config');
const signalEngine = require('./signal-engine');
const cloudSync = require('./cloud-sync');

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
  },
});

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
  return store.set(key, value);
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
async function maybeFirstRunObsAutoconfig() {
  try {
    const current = store.get('obsSettings') || {};

    // Already autoconfigured once? Leave user's saved state alone.
    if (current._autoconfiguredAt) return;

    const { recommendations, specs } = await autoconfig.detectRecommendedObsSettings({
      ffmpegPath: ffmpegInstaller.findFFmpegPath(),
      screenModule: screen,
      videosPath: app.getPath('videos'),
    });

    // Preserve any user-meaningful fields that shouldn't be auto-derived:
    // stream URL (platform choice), stream key (secret), audio device
    // (personal mic preference). Everything else gets the recommendation.
    const merged = {
      ...recommendations,
      streamUrl:   current.streamUrl   || 'rtmp://global.live.mmcdn.com/live-origin',
      streamKey:   current.streamKey   || '',
      audioDevice: current.audioDevice || '',
      outputPath:  current.outputPath  || recommendations.outputPath,
      _autoconfiguredAt: new Date().toISOString(),
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

ipcMain.handle('stream:start', async (_, config) => {
  await ensureFFmpegInstalled();
  const settings = { ...store.get('obsSettings'), ...config };
  return streamEngine.startStream(settings);
});
ipcMain.handle('stream:stop', () => streamEngine.stopStream());
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
  tracker.updateViewers(data.viewers || 0);
  if (data.tips) {
    data.tips.forEach((t) => tracker.addTip(t.username, t.amount, t.timestamp));
  }
  const snapshot = tracker.getSnapshot(data.viewers || 0);
  snapshot.fans = data.fans || [];
  mainWindow?.webContents.send('live-update', snapshot);

  // AI trigger detection
  checkAiTriggers(snapshot);
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

ipcMain.handle('aws:sign-in', async (_, email, password) => {
  const auth = require('../shared/auth');
  try {
    const session = await auth.signIn(email, password);
    store.set('apexSession', session);
    return { success: true, email: session.claims?.email };
  } catch (e) { return { success: false, error: e.message || 'Sign in failed' }; }
});

ipcMain.handle('aws:get-session', () => {
  const auth = require('../shared/auth');
  const sess = store.get('apexSession');
  if (!sess || !auth.isSessionValid(sess)) return null;
  return { email: auth.getEmail(sess) };
});

ipcMain.handle('aws:sign-out', () => {
  store.delete('apexSession');
  return true;
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

// ─── App Lifecycle ──────────────────────────────────────
app.whenReady().then(async () => {
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

  // Stream status updates
  streamEngine.on('status', (status) => {
    mainWindow?.webContents.send('stream:status', status);
  });

  // Initialize AWS (silently)
  try { await awsServices.init(store); }
  catch (e) { console.error('AWS init error:', e); }

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

  // ─── Auto-Updater ────────────────────────────────────
  setupAutoUpdater();
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600000);
});

// ─── Auto-Updater Setup ─────────────────────────────────
let updateReady = false;
let downloadedInstallerPath = null; // captured from update-downloaded event

function setupAutoUpdater() {
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
ipcMain.handle('updates:check', () => {
  return autoUpdater.checkForUpdates().catch((e) => ({ error: e.message }));
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

  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
    log('mainWindow destroyed');
  }

  // Give child processes ~500ms to actually die after SIGTERM. Without this
  // the PowerShell watcher may start polling while ffmpeg.exe is still
  // half-alive and holding the file handle.
  setTimeout(() => {
    try {
      const installerPath = downloadedInstallerPath;
      log(`setTimeout fired. installerPath=${installerPath} exists=${installerPath && fs.existsSync(installerPath)}`);

      if (installerPath && fs.existsSync(installerPath)) {
        // Use PowerShell to wait for THIS process to fully exit before launching
        // the installer. quitAndInstall() spawns the installer then calls app.quit(),
        // which means the installer starts while our process still has file locks —
        // causing "Failed to uninstall old application files." By waiting for the
        // PID to die first, the installer always finds files fully released.
        //
        // NOTE ON NSIS ARGS: our electron-builder config uses oneClick:false, which
        // produces a full-wizard installer. Passing /S (silent) to that kind of
        // installer causes it to abort immediately or run in undefined state —
        // that's the bug behind "I clicked Restart & Update and nothing happened."
        // With no silent flag, the installer shows its wizard UI (user sees it
        // actually installing, and any errors surface as real dialogs). The
        // installer's own NSIS manifest handles UAC elevation — no -Verb RunAs
        // needed, which also avoids the UAC-prompt-hidden-behind-powershell
        // edge case on some Windows configs.
        const pid = process.pid;
        const escaped = installerPath.replace(/'/g, "''");
        const psCmd = [
          `$proc = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
          `if ($proc) { $proc.WaitForExit(8000) }`,
          // Belt-and-suspenders: even if the main process exited, child
          // ffmpeg.exe procs take a moment to fully release handles. Wait for
          // any Apex-owned ffmpeg.exe instances. Ignore errors if none exist.
          `Get-Process ffmpeg -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*apex*' } | ForEach-Object { $_.WaitForExit(3000) }`,
          // Launch installer WITHOUT /S — wizard UI is visible so user sees
          // progress, NSIS manifest self-elevates, runAfterFinish relaunches
          // the app automatically.
          `Start-Process '${escaped}'`,
        ].join('; ');

        spawn('powershell.exe', [
          '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden',
          '-Command', psCmd,
        ], { detached: true, stdio: 'ignore', windowsHide: true }).unref();

        log('PowerShell watcher spawned (detached). Invoking app.exit(0) now.');
        // Exit immediately — PowerShell watcher will launch installer once we're gone
        app.exit(0);
      } else {
        log('Fallback: no cached installer path — calling autoUpdater.quitAndInstall(true, true)');
        // Fallback: no cached path — use electron-updater's built-in method
        autoUpdater.quitAndInstall(true, true);
      }
    } catch (err) {
      log(`setTimeout ERROR: ${err.message}\n${err.stack || ''}`);
      console.error('[Updater] Install failed:', err);
      isUpdating = false;
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
  streamEngine.cleanup();
});

app.on('window-all-closed', () => {
  // Don't quit during update install — quitAndInstall handles its own quit
  if (process.platform !== 'darwin' && !isUpdating) app.quit();
});
