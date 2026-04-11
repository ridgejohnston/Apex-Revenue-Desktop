/**
 * Apex Revenue Desktop - Main Process
 *
 * Electron main process that manages windows, IPC communication,
 * orchestrates OBS backend, and integrates authentication, intelligence, and relay services.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const obsManager = require('../obs/obs-manager');
const streamService = require('../obs/stream-service');
const AuthService = require('../services/auth-service');
const IntelligenceService = require('../services/intelligence-service');
const RelayService = require('../services/relay-service');
const SensationsService = require('../services/sensations-service');

// Persistent settings store
const store = new Store({
  name: 'apex-revenue-settings',
  defaults: {
    stream: {
      broadcastToken: '',
      server: 'global',
      bitrate: 2500,
      encoder: 'x264',
      resolution: '1920x1080',
      fps: 30,
      audioBitrate: 160,
      preset: 'veryfast'
    },
    sources: {
      webcamDeviceId: '',
      micDeviceId: '',
      desktopAudioEnabled: true
    },
    recording: {
      outputPath: '',
      format: 'mkv',
      bitrate: 6000
    },
    ui: {
      windowBounds: { width: 1280, height: 820 },
      alwaysOnTop: false
    },
    auth: {
      autoRefresh: true
    },
    intelligence: {
      updateInterval: 5000
    }
  }
});

let mainWindow = null;
let obsInitialized = false;

// Service instances
let authService = null;
let intelligenceService = null;
let relayService = null;
let sensationsService = null;

// ─────────────────────────────────────────────
// WINDOW CREATION
// ─────────────────────────────────────────────

function createMainWindow() {
  const bounds = store.get('ui.windowBounds');

  mainWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    minWidth: 960,
    minHeight: 600,
    title: 'Apex Revenue — Livestream Management Platform',
    backgroundColor: '#18181c',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    icon: path.join(__dirname, '..', '..', 'assets', 'icon.png'),
    show: false
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('resize', () => {
    const [width, height] = mainWindow.getSize();
    store.set('ui.windowBounds', { width, height });

    // Resize OBS preview if active
    if (obsInitialized) {
      const previewWidth = Math.floor(width * 0.65);
      const previewHeight = Math.floor(previewWidth * 9 / 16);
      obsManager.resizePreview(previewWidth, previewHeight);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // Open DevTools in development
  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// ─────────────────────────────────────────────
// OBS INITIALIZATION
// ─────────────────────────────────────────────

async function initializeOBS() {
  try {
    await obsManager.initialize({
      dataPath: path.join(app.getPath('userData'), 'obs-config')
    });

    // Configure video with saved settings
    const streamSettings = store.get('stream');
    obsManager.configureVideo({
      baseResolution: streamSettings.resolution,
      outputResolution: streamSettings.resolution,
      fps: streamSettings.fps
    });

    // Create main scene
    obsManager.createScene('apex-main');

    obsInitialized = true;
    console.log('[Main] OBS initialized successfully');
    return { success: true };
  } catch (err) {
    console.error('[Main] Failed to initialize OBS:', err);
    return { success: false, error: err.message || String(err) };
  }
}

// ─────────────────────────────────────────────
// IPC HANDLERS - OBS Operations
// ─────────────────────────────────────────────

// --- Initialization ---
ipcMain.handle('obs:initialize', async () => {
  return await initializeOBS();
});

ipcMain.handle('obs:getState', () => {
  return obsManager.getState();
});

// --- Device Enumeration ---
ipcMain.handle('obs:getWebcamDevices', () => {
  return obsManager.getWebcamDevices();
});

ipcMain.handle('obs:getAudioInputDevices', () => {
  return obsManager.getAudioInputDevices();
});

// --- Source Management ---
ipcMain.handle('obs:addWebcam', (event, name, options) => {
  obsManager.addWebcamSource(name, options);
  return true;
});

ipcMain.handle('obs:addDisplay', (event, name, options) => {
  obsManager.addDisplaySource(name, options);
  return true;
});

ipcMain.handle('obs:addImage', (event, name, options) => {
  obsManager.addImageSource(name, options);
  return true;
});

ipcMain.handle('obs:addVideo', (event, name, options) => {
  obsManager.addVideoSource(name, options);
  return true;
});

ipcMain.handle('obs:addAudio', (event, name, options) => {
  obsManager.addAudioSource(name, options);
  return true;
});

ipcMain.handle('obs:removeSource', (event, name) => {
  obsManager.removeSource(name);
  return true;
});

ipcMain.handle('obs:setSourceVisible', (event, name, visible) => {
  obsManager.setSourceVisible(name, visible);
  return true;
});

ipcMain.handle('obs:setSourceTransform', (event, name, transform) => {
  obsManager.setSourceTransform(name, transform);
  return true;
});

// --- Preview ---
ipcMain.handle('obs:createPreview', (event) => {
  const handle = mainWindow.getNativeWindowHandle();
  const [width, height] = mainWindow.getSize();
  const previewWidth = Math.floor(width * 0.65);
  const previewHeight = Math.floor(previewWidth * 9 / 16);
  obsManager.createPreview(handle, { width: previewWidth, height: previewHeight });
  return true;
});

ipcMain.handle('obs:resizePreview', (event, width, height) => {
  obsManager.resizePreview(width, height);
  return true;
});

// --- Streaming ---
ipcMain.handle('stream:configure', (event, config) => {
  // Save settings
  store.set('stream', { ...store.get('stream'), ...config });
  return streamService.configure(config);
});

ipcMain.handle('stream:start', async () => {
  try {
    await streamService.startStream();
    if (mainWindow) {
      mainWindow.webContents.send('stream:stateChange', { streaming: true });
    }
    return { success: true };
  } catch (err) {
    console.error('[Main] Stream start error:', err);
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('stream:startStream', async (event, streamKey) => {
  try {
    // Configure stream with the provided key and saved settings
    const streamSettings = store.get('stream') || {};
    streamService.configure({
      broadcastToken: streamKey,
      server: streamSettings.server || 'global',
      bitrate: streamSettings.bitrate || 2500,
      encoder: streamSettings.encoder || 'x264',
      resolution: streamSettings.resolution || '1920x1080',
      fps: streamSettings.fps || 30,
      audioBitrate: streamSettings.audioBitrate || 160,
      preset: streamSettings.preset || 'veryfast'
    });

    await streamService.startStream();
    if (mainWindow) {
      mainWindow.webContents.send('stream:stateChange', { streaming: true });
    }
    return { success: true };
  } catch (err) {
    console.error('[Main] Stream startStream error:', err);
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('stream:stop', async () => {
  try {
    await streamService.stopStream();
    if (mainWindow) {
      mainWindow.webContents.send('stream:stateChange', { streaming: false });
    }
    return { success: true };
  } catch (err) {
    console.error('[Main] Stream stop error:', err);
    return { success: false, error: err.message || String(err) };
  }
});

ipcMain.handle('stream:getStatus', () => {
  return streamService.getStatus();
});

ipcMain.handle('stream:getServers', () => {
  return streamService.getServers();
});

// --- Recording ---
ipcMain.handle('recording:configure', (event, settings) => {
  store.set('recording', { ...store.get('recording'), ...settings });
  obsManager.configureRecording(settings);
  return true;
});

ipcMain.handle('recording:start', () => {
  obsManager.startRecording();
  if (mainWindow) {
    mainWindow.webContents.send('recording:stateChange', { recording: true });
  }
  return true;
});

ipcMain.handle('recording:stop', () => {
  obsManager.stopRecording();
  if (mainWindow) {
    mainWindow.webContents.send('recording:stateChange', { recording: false });
  }
  return true;
});

// --- Settings ---
ipcMain.handle('settings:get', (event, key) => {
  return key ? store.get(key) : store.store;
});

ipcMain.handle('settings:set', (event, key, value) => {
  store.set(key, value);
  return true;
});

// --- File Dialogs ---
ipcMain.handle('dialog:selectFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory']
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('dialog:selectFile', async (event, filters) => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: filters || [
      { name: 'Media Files', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'mp4', 'webm', 'mkv', 'avi'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });
  return result.canceled ? null : result.filePaths[0];
});

// ─────────────────────────────────────────────
// IPC HANDLERS - AUTHENTICATION (New)
// ─────────────────────────────────────────────

ipcMain.handle('auth:login', async (event, email, password) => {
  if (!authService) return { success: false, error: 'Auth service not ready' };
  try {
    return await authService.login(email, password);
  } catch (err) {
    console.error('auth:login IPC error:', err);
    return { success: false, error: err.message || 'Login failed' };
  }
});

ipcMain.handle('auth:signup', async (event, email, password) => {
  if (!authService) return { success: false, error: 'Auth service not ready' };
  try {
    return await authService.signup(email, password);
  } catch (err) {
    console.error('auth:signup IPC error:', err);
    return { success: false, error: err.message || 'Signup failed' };
  }
});

ipcMain.handle('auth:confirmSignup', async (event, email, code) => {
  if (!authService) return { success: false, error: 'Auth service not ready' };
  try {
    return await authService.confirmSignup(email, code);
  } catch (err) {
    console.error('auth:confirmSignup IPC error:', err);
    return { success: false, error: err.message || 'Confirmation failed' };
  }
});

ipcMain.handle('auth:logout', async () => {
  if (!authService) return { success: false, error: 'Auth service not ready' };
  try {
    return await authService.logout();
  } catch (err) {
    console.error('auth:logout IPC error:', err);
    return { success: false, error: err.message || 'Logout failed' };
  }
});

ipcMain.handle('auth:getSession', () => {
  if (!authService) return { isAuthenticated: false, user: null, tokens: {} };
  return authService.getSession();
});

ipcMain.handle('auth:getUser', () => {
  if (!authService) return null;
  return authService.getUser();
});

ipcMain.handle('auth:refreshTokens', async () => {
  return await authService.refreshTokens();
});

ipcMain.handle('auth:getLinkedAccounts', async () => {
  return await authService.getLinkedAccounts();
});

ipcMain.handle('auth:linkPlatform', async (event, platform, username) => {
  return await authService.linkPlatform(platform, username);
});

ipcMain.handle('auth:unlinkPlatform', async (event, platform) => {
  return await authService.unlinkPlatform(platform);
});

ipcMain.handle('auth:isAdmin', () => {
  return authService.isAdmin();
});

// ─────────────────────────────────────────────
// AUTH GUARD HELPER
// ─────────────────────────────────────────────

function requireAuth(handlerName) {
  if (!authService) return { success: false, error: 'Service not ready' };
  const session = authService.getSession();
  if (!session || !session.isAuthenticated) {
    console.warn(`[Auth Guard] Blocked unauthenticated call to ${handlerName}`);
    return { success: false, error: 'Authentication required' };
  }
  return null; // null = passed
}

// ─────────────────────────────────────────────
// IPC HANDLERS - INTELLIGENCE (Auth-guarded)
// ─────────────────────────────────────────────

ipcMain.handle('intelligence:getLiveData', () => {
  const denied = requireAuth('intelligence:getLiveData');
  if (denied) return denied;
  return intelligenceService.getLiveData();
});

ipcMain.handle('intelligence:getFanLeaderboard', () => {
  const denied = requireAuth('intelligence:getFanLeaderboard');
  if (denied) return denied;
  return intelligenceService.getFanLeaderboard();
});

ipcMain.handle('intelligence:getEarnings', () => {
  const denied = requireAuth('intelligence:getEarnings');
  if (denied) return denied;
  return intelligenceService.getEarnings();
});

ipcMain.handle('intelligence:getSessions', () => {
  const denied = requireAuth('intelligence:getSessions');
  if (denied) return denied;
  return intelligenceService.getSessions();
});

ipcMain.handle('intelligence:getTotalEarnings', () => {
  const denied = requireAuth('intelligence:getTotalEarnings');
  if (denied) return denied;
  return intelligenceService.getTotalEarnings();
});

ipcMain.handle('intelligence:getSessionStats', () => {
  const denied = requireAuth('intelligence:getSessionStats');
  if (denied) return denied;
  return intelligenceService.getSessionStats();
});

ipcMain.handle('intelligence:getAnalytics', async (event, timeRange) => {
  const denied = requireAuth('intelligence:getAnalytics');
  if (denied) return denied;
  const token = authService.getAccessToken();
  return await intelligenceService.getAnalytics(token, timeRange);
});

ipcMain.handle('intelligence:checkSubscription', async () => {
  const denied = requireAuth('intelligence:checkSubscription');
  if (denied) return denied;
  const token = authService.getAccessToken();
  return await intelligenceService.checkSubscription(token);
});

ipcMain.handle('intelligence:startSession', (event, roomName, settings) => {
  const denied = requireAuth('intelligence:startSession');
  if (denied) return denied;
  intelligenceService.startSession(roomName, settings);
  return true;
});

ipcMain.handle('intelligence:endSession', (event, roomName) => {
  const denied = requireAuth('intelligence:endSession');
  if (denied) return denied;
  intelligenceService.endSession(roomName);
  return true;
});

ipcMain.handle('intelligence:recordTip', (event, amount, username, platform) => {
  const denied = requireAuth('intelligence:recordTip');
  if (denied) return denied;
  return intelligenceService.recordTip(amount, username, platform);
});

// ─────────────────────────────────────────────
// IPC HANDLERS - RELAY (New)
// ─────────────────────────────────────────────

ipcMain.handle('relay:connect', async (event, accessToken, username, platform) => {
  const denied = requireAuth('relay:connect');
  if (denied) return denied;
  return await relayService.connect(accessToken, username, platform);
});

ipcMain.handle('relay:disconnect', () => {
  const denied = requireAuth('relay:disconnect');
  if (denied) return denied;
  relayService.disconnect();
  return true;
});

ipcMain.handle('relay:getStatus', () => {
  const denied = requireAuth('relay:getStatus');
  if (denied) return denied;
  return relayService.getStatus();
});

ipcMain.handle('relay:sendHeartbeat', () => {
  const denied = requireAuth('relay:sendHeartbeat');
  if (denied) return denied;
  relayService.sendHeartbeat();
  return true;
});

// ─────────────────────────────────────────────
// IPC HANDLERS - SENSATIONS (New)
// ─────────────────────────────────────────────

ipcMain.handle('sensations:getState', () => {
  return sensationsService ? sensationsService.getState() : null;
});

ipcMain.handle('sensations:getSettings', () => {
  return sensationsService ? sensationsService.getSettings() : null;
});

ipcMain.handle('sensations:configure', (event, settings) => {
  if (!sensationsService) return { success: false, error: 'Service not initialized' };
  try {
    sensationsService.configure(settings);
    store.set('sensations', settings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sensations:handleTip', (event, amount, username, platform) => {
  if (!sensationsService) return { success: false, error: 'Service not initialized' };
  try {
    sensationsService.handleTip(amount, username, platform);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sensations:getTiers', () => {
  return sensationsService ? sensationsService.getTiers() : [];
});

ipcMain.handle('sensations:adjustTier', (event, tierIndex, changes) => {
  if (!sensationsService) return { success: false, error: 'Service not initialized' };
  try {
    sensationsService.adjustTier(tierIndex, changes);
    const settings = sensationsService.getSettings();
    store.set('sensations', settings);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('sensations:getQueue', () => {
  return sensationsService ? sensationsService.getQueueStatus() : { queue: [], isProcessing: false };
});

ipcMain.handle('sensations:resetSession', () => {
  if (!sensationsService) return { success: false, error: 'Service not initialized' };
  sensationsService.resetSession();
  return { success: true };
});

ipcMain.handle('sensations:setConnected', (event, connected) => {
  if (!sensationsService) return { success: false, error: 'Service not initialized' };
  sensationsService.setToyConnected(connected);
  return { success: true };
});

// ─────────────────────────────────────────────
// SERVICE EVENT FORWARDING
// (Registered after services are created in app.whenReady)
// ─────────────────────────────────────────────

function registerServiceEvents() {
  // Auth service events
  authService.onAuthChange((user) => {
    if (mainWindow) {
      mainWindow.webContents.send('auth:changed', user);
    }
  });

  // Intelligence service events
  intelligenceService.on('liveUpdate', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:liveUpdate', data);
  });

  intelligenceService.on('fanUpdate', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:fanUpdate', data);
  });

  intelligenceService.on('sessionStarted', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:sessionStarted', data);
  });

  intelligenceService.on('sessionEnded', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:sessionEnded', data);
  });

  intelligenceService.on('tipReceived', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:tipReceived', data);
  });

  intelligenceService.on('balanceUpdate', (data) => {
    if (mainWindow) mainWindow.webContents.send('intelligence:balanceUpdate', data);
  });

  // Relay service events
  relayService.on('connected', () => {
    if (mainWindow) mainWindow.webContents.send('relay:connected');
  });

  relayService.on('disconnected', () => {
    if (mainWindow) mainWindow.webContents.send('relay:disconnected');
  });

  relayService.on('fanControl', (data) => {
    if (mainWindow) mainWindow.webContents.send('relay:fanControl', data);
  });

  relayService.on('vibeCommand', (data) => {
    if (mainWindow) mainWindow.webContents.send('relay:vibeCommand', data);
  });

  relayService.on('relayEvent', (data) => {
    if (mainWindow) mainWindow.webContents.send('relay:event', data);
  });

  // Sensations service events
  sensationsService.on('vibrate', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:vibrate', data);
  });

  sensationsService.on('notice', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:notice', data);
  });

  sensationsService.on('goalReached', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:goalReached', data);
  });

  sensationsService.on('autoReset', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:autoReset', data);
  });

  sensationsService.on('grandFinale', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:grandFinale', data);
  });

  sensationsService.on('comboHit', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:comboHit', data);
  });

  sensationsService.on('leaderboardUpdate', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:leaderboardUpdate', data);
  });

  sensationsService.on('queueUpdate', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:queueUpdate', data);
  });

  sensationsService.on('tierChange', (data) => {
    if (mainWindow) mainWindow.webContents.send('sensations:tierChange', data);
  });
}

// ─────────────────────────────────────────────
// STREAM SERVICE EVENT FORWARDING (Existing)
// ─────────────────────────────────────────────

streamService.on('streamStart', (data) => {
  if (mainWindow) mainWindow.webContents.send('stream:event', { event: 'start', ...data });
});

streamService.on('streamStop', (data) => {
  if (mainWindow) mainWindow.webContents.send('stream:event', { event: 'stop', ...data });
});

streamService.on('streamReconnect', (data) => {
  if (mainWindow) mainWindow.webContents.send('stream:event', { event: 'reconnect', ...data });
});

streamService.on('streamHealth', (data) => {
  if (mainWindow) mainWindow.webContents.send('stream:health', data);
});

// ─────────────────────────────────────────────
// APP LIFECYCLE
// ─────────────────────────────────────────────

app.whenReady().then(async () => {
  // Initialize services
  authService = new AuthService();
  intelligenceService = new IntelligenceService(authService);
  relayService = new RelayService();
  sensationsService = new SensationsService();
  // Restore saved sensations settings
  const savedSensations = store.get('sensations');
  if (savedSensations) sensationsService.configure(savedSensations);

  // Register event forwarding now that services exist
  registerServiceEvents();

  createMainWindow();
});

app.on('window-all-closed', async () => {
  // Cleanup services
  if (relayService) {
    relayService.disconnect();
  }
  if (intelligenceService) {
    intelligenceService.stopPeriodicUpdates();
  }

  await obsManager.shutdown();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createMainWindow();
  }
});

app.on('before-quit', async () => {
  // Cleanup services
  if (relayService) {
    relayService.disconnect();
  }
  if (intelligenceService) {
    intelligenceService.stopPeriodicUpdates();
  }

  await obsManager.shutdown();
});
