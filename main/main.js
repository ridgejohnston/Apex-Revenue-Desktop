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
const ffmpegInstaller = require('./ffmpeg-installer');
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
ipcMain.on('window:exit', () => { isQuitting = true; app.quit(); });
ipcMain.on('window:restart', () => { isQuitting = true; app.relaunch(); app.exit(0); });

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

  // Detach the close handler so the window destroys immediately without
  // being intercepted by the "hide to tray" logic.
  if (mainWindow) {
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
  }

  // Defer to next tick so the window is fully destroyed before we hand off.
  // isSilent=true is required for zip-based updates — false causes electron-updater
  // to wait for installer UI interaction that never arrives, then it just exits.
  // isForceRunAfter=true spawns the new exe after extraction.
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch {
      // Fallback: if quitAndInstall throws (e.g. zip write permission error),
      // relaunch manually and exit so the user at least gets back in the app.
      app.relaunch();
      app.exit(0);
    }
  });
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

let toyState = {
  lovense:  { connected: false, apiToken: '', toys: [], wsUrl: '' },
  buttplug: { connected: false, wsUrl: 'ws://localhost:12345', toys: [], ws: null },
  tipMap:   { enabled: true, tiers: [
    { minTokens: 1,   intensity: 20, duration: 2 },
    { minTokens: 10,  intensity: 40, duration: 4 },
    { minTokens: 25,  intensity: 60, duration: 6 },
    { minTokens: 50,  intensity: 80, duration: 8 },
    { minTokens: 100, intensity: 100, duration: 10 },
  ]},
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
  toyState.tipMap = tipMap;
  store.set('toyTipMap', tipMap);
  return { ok: true };
});

// Auto-fire vibration on tips when enabled
const _origOnLiveUpdate = ipcMain.listeners('cam:live-update')[0];
ipcMain.on('cam:tip-vibrate', async (_, tipAmount) => {
  if (!toyState.tipMap.enabled) return;
  const tiers = [...toyState.tipMap.tiers].sort((a, b) => b.minTokens - a.minTokens);
  const tier = tiers.find((t) => tipAmount >= t.minTokens);
  if (tier) await vibrateAll(tier.intensity, tier.duration);
});

// Restore saved config
app.whenReady().then(() => {}).on('ready-pre-init', () => {});
(function restoreSyncConfig() {
  const savedToken = store?.get?.('lovenseApiToken');
  const savedWsUrl = store?.get?.('buttplugWsUrl');
  const savedTipMap = store?.get?.('toyTipMap');
  if (savedToken) toyState.lovense.apiToken = savedToken;
  if (savedWsUrl) toyState.buttplug.wsUrl = savedWsUrl;
  if (savedTipMap) toyState.tipMap = savedTipMap;
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
  if (process.platform !== 'darwin') app.quit();
});
