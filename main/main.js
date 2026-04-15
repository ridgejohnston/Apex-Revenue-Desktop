/**
 * Apex Revenue Desktop v2 — Main Process
 * Combines Creator Intelligence Engine with full OBS-style streaming platform
 */

const { app, BrowserWindow, BrowserView, ipcMain, Tray, Menu, desktopCapturer, session, screen } = require('electron');
const path = require('path');
const Store = require('electron-store');
const awsServices = require('./aws-services');
const streamEngine = require('./stream-engine');
const sceneManager = require('./scene-manager');
const audioMixer = require('./audio-mixer');
const { autoUpdater } = require('electron-updater');
const EarningsTracker = require('../shared/earnings-tracker');
const { VERSION } = require('../shared/apex-config');

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
      streamUrl: 'rtmp://live.chaturbate.com/live-origin',
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
ipcMain.handle('store:set', (_, key, value) => store.set(key, value));

// Window controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) mainWindow.unmaximize();
  else mainWindow?.maximize();
});
ipcMain.on('window:close', () => mainWindow?.close());

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
ipcMain.handle('stream:start', async (_, config) => {
  const settings = { ...store.get('obsSettings'), ...config };
  return streamEngine.startStream(settings);
});
ipcMain.handle('stream:stop', () => streamEngine.stopStream());
ipcMain.handle('stream:get-status', () => streamEngine.getStatus());

ipcMain.handle('record:start', async (_, config) => {
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
  createMainWindow();
  createCamView();
  createTray();

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

  startHeartbeat();

  // ─── Auto-Updater ────────────────────────────────────
  setupAutoUpdater();
  autoUpdater.checkForUpdates().catch(() => {});
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600000);
});

// ─── Auto-Updater Setup ─────────────────────────────────
let updateReady = false;

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

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
  if (updateReady) {
    isQuitting = true;
    autoUpdater.quitAndInstall(false, true);
  }
});

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
  if (process.platform !== 'darwin') app.quit();
});
