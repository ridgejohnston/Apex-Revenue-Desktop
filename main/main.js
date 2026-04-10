// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Main Process v3.0
// AWS services auto-start on boot — no user configuration required.
// Layout: 200px left sidebar | BrowserView | 380px analytics panel
// ═══════════════════════════════════════════════════════════════════════════════

const {
  app, BrowserWindow, BrowserView, ipcMain, Tray,
  Menu, nativeImage, shell, session
} = require('electron');
const path    = require('path');
const Store   = require('electron-store');
const aws     = require('./aws-services');
const config  = require('../shared/aws-config');
const { initUpdater, stopUpdater } = require('./updater');

// ── Persistent store ──────────────────────────────────────────────────────────
const store = new Store({
  name: 'apex-revenue-data',
  encryptionKey: 'apex-revenue-v1-enc-key-2025',
  defaults: {
    apexLiveData:    { tokensPerHour: 0, viewers: 0, convRate: 0, whales: [], fans: [] },
    apexSession:     null,
    apexSubscription:null,
    selectedUrl:     'https://chaturbate.com/',
    windowBounds:    { width: 1440, height: 860 },
    // AWS — all ON by default
    awsVoiceEnabled:    true,
    awsBackupEnabled:   true,
    awsMetricsEnabled:  true,
    awsFirehoseEnabled: true,
    awsIotEnabled:      false,
    awsPromptMode:      'bedrock',
    awsCredentials:     null,
  }
});

// ── Bootstrap AWS credentials from gitignored config file ────────────────────
// config/aws-defaults.json is baked into the installer asar but never committed.
// Falls back to any credentials already saved in electron-store.
function loadAwsCredentials() {
  let creds = store.get('awsCredentials');
  if (!creds || !creds.accessKeyId) {
    try {
      const cfgPath = path.join(__dirname, '../config/aws-defaults.json');
      creds = JSON.parse(require('fs').readFileSync(cfgPath, 'utf8'));
      store.set('awsCredentials', creds); // persist for next launch
    } catch {
      // config file not present — AWS features will be inert
    }
  }
  if (creds?.accessKeyId) aws.setCredentials(creds);
}
loadAwsCredentials();

// ── Global state ──────────────────────────────────────────────────────────────
let mainWindow         = null;
let tray               = null;
let currentBrowserView = null;
let cloudwatchInterval = null;
let lastVoiceAlertAt   = 0;
let lastAiPromptAt     = 0;
let lastSessionData    = null;
let currentUsername    = null;
const sessionId        = `sess_${Date.now()}`;

// Layout constants
const SIDEBAR_W  = 200;
const PANEL_W    = 380;
const TITLEBAR_H = 40;

// ── Main window ───────────────────────────────────────────────────────────────
function createMainWindow() {
  const { width, height } = store.get('windowBounds', { width: 1440, height: 860 });

  mainWindow = new BrowserWindow({
    width, height,
    minWidth:  1000, minHeight: 640,
    frame:     false,
    backgroundColor: '#0a0a0f',
    show:      false,
    webPreferences: {
      preload: path.join(__dirname, '../preload/preload-main.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      webviewTag:       false,   // using BrowserView, not webview tag
      devTools:         true,
    },
    icon: path.join(__dirname, '../assets/icons/icon.ico'),
  });

  mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    setupBrowserView(store.get('selectedUrl', 'https://chaturbate.com/'));
    startCloudWatchHeartbeat();
    initUpdater(mainWindow);   // ← start auto-updater
    // Signal renderer that AWS is live
    mainWindow.webContents.once('did-finish-load', () => {
      mainWindow.webContents.send('aws:status', { active: true, region: config.REGION });
    });
  });

  mainWindow.on('resize', () => {
    const [w, h] = mainWindow.getSize();
    store.set('windowBounds', { width: w, height: h });
    layoutBrowserView();
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── BrowserView — fills space between sidebar and panel ───────────────────────
function setupBrowserView(url) {
  if (currentBrowserView) {
    mainWindow.removeBrowserView(currentBrowserView);
    currentBrowserView.webContents.destroy();
    currentBrowserView = null;
  }

  currentBrowserView = new BrowserView({
    webPreferences: {
      preload:          path.join(__dirname, '../preload/preload-cam.js'),
      contextIsolation: false,
      nodeIntegration:  false,
      webSecurity:      true,
    },
  });

  mainWindow.addBrowserView(currentBrowserView);
  layoutBrowserView();
  currentBrowserView.webContents.loadURL(url || 'https://chaturbate.com/');

  currentBrowserView.webContents.on('did-navigate', (_, u) => {
    mainWindow?.webContents.send('cam:url-changed', u);
  });
  currentBrowserView.webContents.on('did-navigate-in-page', (_, u) => {
    mainWindow?.webContents.send('cam:url-changed', u);
  });
  currentBrowserView.webContents.on('page-title-updated', (_, title) => {
    mainWindow?.webContents.send('cam:title-changed', title);
  });
}

function layoutBrowserView() {
  if (!currentBrowserView || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  currentBrowserView.setBounds({
    x:      SIDEBAR_W,
    y:      TITLEBAR_H,
    width:  Math.max(0, w - SIDEBAR_W - PANEL_W),
    height: Math.max(0, h - TITLEBAR_H),
  });
}

// ── System tray ───────────────────────────────────────────────────────────────
function createTray() {
  const icon = nativeImage.createFromPath(
    path.join(__dirname, '../assets/icons/tray-icon.png')
  );
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Apex Revenue Desktop');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Show',  click: () => { mainWindow?.show(); mainWindow?.focus(); } },
    { type: 'separator' },
    { label: 'Quit',  click: () => app.quit() },
  ]));
  tray.on('double-click', () => { mainWindow?.show(); mainWindow?.focus(); });
}

// ── CloudWatch heartbeat (every 60s, silent) ──────────────────────────────────
function startCloudWatchHeartbeat() {
  if (cloudwatchInterval) clearInterval(cloudwatchInterval);
  cloudwatchInterval = setInterval(async () => {
    if (!lastSessionData || !store.get('awsMetricsEnabled')) return;
    try {
      await aws.emitCloudWatchMetrics(lastSessionData, currentUsername || 'unknown');
      mainWindow?.webContents.send('aws:cw-heartbeat', { ts: Date.now() });
    } catch (e) { /* silent — AWS errors don't surface to user */ }
  }, config.CW_METRICS_INTERVAL);
}

// ── AI prompt trigger detection ───────────────────────────────────────────────
function detectTrigger(data) {
  const recent = (data.tipEvents || []).filter(e => Date.now() - e.timestamp < 180000);
  if (!recent.length && (data.viewers || 0) > 5) return 'dead_air';
  if ((data.viewers || 0) > 60)                   return 'viewer_surge';
  if ((data.whales  || []).length > 0)             return 'whale_present';
  if ((data.tokensPerHour || 0) > 500)             return 'hot_streak';
  return null;
}

function localFallback(trigger, data) {
  const w = (data.whales || [])[0];
  const map = {
    dead_air:      'Engagement lull — ask viewers a question or announce an upcoming show element.',
    viewer_surge:  `Viewer surge! ${data.viewers} people watching — announce a tip goal right now.`,
    whale_present: w ? `${w.username} (top tipper) is in the room — give them a personal shout-out!` : 'Your top fan is watching — acknowledge them!',
    hot_streak:    "You're on a hot streak! Keep the energy up and tease a special reward.",
  };
  return map[trigger] || 'Great session! Keep engaging your top fans.';
}

async function triggerAiPrompt(data, trigger) {
  try {
    let result;
    if (store.get('awsPromptMode') === 'bedrock') {
      result = await aws.generateAiPrompt(data, trigger);
    } else {
      result = { prompt: localFallback(trigger, data), signal: trigger, confidence: 0.6 };
    }
    if (!mainWindow || !result?.prompt) return;
    mainWindow.webContents.send('aws:ai-prompt', result);

    if (store.get('awsVoiceEnabled') && Date.now() - lastVoiceAlertAt > config.VOICE_ALERT_COOLDOWN) {
      lastVoiceAlertAt = Date.now();
      const audio = await aws.synthesizeSpeech(result.prompt);
      mainWindow.webContents.send('aws:polly-audio', { audio, text: result.prompt });
    }
  } catch {
    mainWindow?.webContents.send('aws:ai-prompt', {
      prompt: localFallback(trigger, data), signal: trigger, confidence: 0.4, fallback: true,
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// IPC — Store
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('store:get',    (_, k)   => store.get(k));
ipcMain.handle('store:set',    (_, k,v) => { store.set(k,v); return true; });
ipcMain.handle('store:getAll', ()       => store.store);

// ══════════════════════════════════════════════════════════════════════════════
// IPC — Live data from cam preload
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.on('cam:live-update', async (_, data) => {
  store.set('apexLiveData', data);
  lastSessionData = data;
  mainWindow?.webContents.send('live-update', data);

  // Firehose: queue new tip events silently
  if (store.get('awsFirehoseEnabled') && data.tipEvents?.length) {
    const prev = store.get('apexLiveData')?.tipEvents || [];
    data.tipEvents
      .filter(ev => !prev.some(p => p.timestamp === ev.timestamp && p.username === ev.username))
      .forEach(ev => aws.queueTipEvent(ev, { platform: data.platform, username: data.username }));
  }

  // Auto whale voice alert
  if (store.get('awsVoiceEnabled') && data.whales?.length &&
      Date.now() - lastVoiceAlertAt > config.VOICE_ALERT_COOLDOWN) {
    const w = data.whales[0];
    if (w?.tips >= 200) {
      lastVoiceAlertAt = Date.now();
      aws.speakAlert('whale', w.username, w.tips)
        .then(r => r && mainWindow?.webContents.send('aws:polly-audio', r))
        .catch(() => {});
    }
  }

  // AI prompt
  if (Date.now() - lastAiPromptAt > config.AI_PROMPT_COOLDOWN) {
    const trigger = detectTrigger(data);
    if (trigger) { lastAiPromptAt = Date.now(); triggerAiPrompt(data, trigger); }
  }
});

ipcMain.on('cam:platform-detected', (_, p) => mainWindow?.webContents.send('platform-detected', p));

// ══════════════════════════════════════════════════════════════════════════════
// IPC — AWS (still exposed for manual S3 backup / Polly test from renderer)
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.handle('aws:s3-backup', async (_, data) => {
  try {
    const r = await aws.backupSessionToS3(data || lastSessionData, currentUsername || 'unknown');
    mainWindow?.webContents.send('aws:backup-done', r);
    return { ok: true, ...r };
  } catch (err) { return { ok: false, error: err.message }; }
});

ipcMain.handle('aws:bedrock-prompt', async (_, { sessionData, trigger }) => {
  try { return await aws.generateAiPrompt(sessionData || lastSessionData, trigger || 'manual'); }
  catch (err) { return { prompt: localFallback(trigger, sessionData || {}), fallback: true, error: err.message }; }
});

ipcMain.handle('aws:polly-speak', async (_, text) => {
  try {
    const audio = await aws.synthesizeSpeech(text);
    mainWindow?.webContents.send('aws:polly-audio', { audio, text });
    return { ok: true };
  } catch (err) { return { ok: false, error: err.message }; }
});

// ══════════════════════════════════════════════════════════════════════════════
// IPC — Window / Browser navigation
// ══════════════════════════════════════════════════════════════════════════════
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => { if (mainWindow?.isMaximized()) mainWindow.unmaximize(); else mainWindow?.maximize(); });
ipcMain.on('window:close',    () => mainWindow?.hide());
ipcMain.on('window:quit',     () => { aws.flushFirehose(); stopUpdater(); app.quit(); });
ipcMain.on('shell:open',      (_, url) => shell.openExternal(url));

// Reposition BrowserView when update banner appears/disappears
ipcMain.on('update:banner-height', (_, bannerH) => {
  if (!currentBrowserView || !mainWindow) return;
  const [w, h] = mainWindow.getContentSize();
  currentBrowserView.setBounds({
    x:      SIDEBAR_W,
    y:      TITLEBAR_H + bannerH,
    width:  Math.max(0, w - SIDEBAR_W - PANEL_W),
    height: Math.max(0, h - TITLEBAR_H - bannerH),
  });
});

ipcMain.on('cam:navigate', (_, url) => {
  store.set('selectedUrl', url);
  if (currentBrowserView) currentBrowserView.webContents.loadURL(url);
});
ipcMain.on('cam:back',    () => { if (currentBrowserView?.webContents.canGoBack())    currentBrowserView.webContents.goBack(); });
ipcMain.on('cam:forward', () => { if (currentBrowserView?.webContents.canGoForward()) currentBrowserView.webContents.goForward(); });
ipcMain.on('cam:reload',  () => currentBrowserView?.webContents.reload());
ipcMain.handle('cam:currentUrl', () => currentBrowserView?.webContents.getURL() || '');

ipcMain.on('app:set-username', (_, u) => { currentUsername = u; });
ipcMain.on('app:session-end', async () => {
  if (!lastSessionData || !store.get('awsBackupEnabled')) return;
  aws.flushFirehose().catch(() => {});
  try {
    await aws.backupSessionToS3(lastSessionData, currentUsername || 'unknown');
    mainWindow?.webContents.send('aws:backup-done', { auto: true });
  } catch { /* silent */ }
});

// ── App lifecycle ──────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
    callback({ requestHeaders: details.requestHeaders });
  });
  createMainWindow();
  createTray();
});

app.on('window-all-closed', () => { /* stay in tray on Windows */ });
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createMainWindow(); });
app.on('before-quit', () => { aws.flushFirehose(); stopUpdater(); });
