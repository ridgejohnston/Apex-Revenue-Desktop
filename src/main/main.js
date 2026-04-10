/**
 * Apex Revenue Desktop - Main Process
 *
 * Electron main process that manages windows, IPC communication,
 * and orchestrates the OBS backend via obs-manager.
 */

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const Store = require('electron-store');
const obsManager = require('../obs/obs-manager');
const streamService = require('../obs/stream-service');

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
    }
  }
});

let mainWindow = null;
let obsInitialized = false;

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
    title: 'Apex Revenue Desktop',
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
    return true;
  } catch (err) {
    console.error('[Main] Failed to initialize OBS:', err);
    return false;
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
  await streamService.startStream();
  // Notify renderer of state change
  if (mainWindow) {
    mainWindow.webContents.send('stream:stateChange', { streaming: true });
  }
  return true;
});

ipcMain.handle('stream:stop', async () => {
  await streamService.stopStream();
  if (mainWindow) {
    mainWindow.webContents.send('stream:stateChange', { streaming: false });
  }
  return true;
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
// STREAM SERVICE EVENT FORWARDING
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

app.whenReady().then(() => {
  createMainWindow();
});

app.on('window-all-closed', async () => {
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
  await obsManager.shutdown();
});
