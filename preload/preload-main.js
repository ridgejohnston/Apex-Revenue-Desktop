/**
 * Apex Revenue — Preload (Main Renderer)
 * Context-isolated bridge between Electron main process and React UI
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // ─── Store ───────────────────────────────────────────
  store: {
    get: (key) => ipcRenderer.invoke('store:get', key),
    set: (key, value) => ipcRenderer.invoke('store:set', key, value),
  },

  // ─── Window Controls ─────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
    exit:     () => ipcRenderer.send('window:exit'),
    restart:  () => ipcRenderer.send('window:restart'),
  },

  // ─── Scenes ──────────────────────────────────────────
  scenes: {
    getAll: () => ipcRenderer.invoke('scenes:get-all'),
    getActive: () => ipcRenderer.invoke('scenes:get-active'),
    create: (name) => ipcRenderer.invoke('scenes:create', name),
    remove: (id) => ipcRenderer.invoke('scenes:delete', id),
    setActive: (id) => ipcRenderer.invoke('scenes:set-active', id),
    rename: (id, name) => ipcRenderer.invoke('scenes:rename', id, name),
    duplicate: (id) => ipcRenderer.invoke('scenes:duplicate', id),
    onUpdated: (cb) => ipcRenderer.on('scenes:updated', (_, data) => cb(data)),
  },

  // ─── Sources ─────────────────────────────────────────
  sources: {
    add: (sceneId, config) => ipcRenderer.invoke('sources:add', sceneId, config),
    remove: (sceneId, sourceId) => ipcRenderer.invoke('sources:remove', sceneId, sourceId),
    update: (sceneId, sourceId, props) => ipcRenderer.invoke('sources:update', sceneId, sourceId, props),
    reorder: (sceneId, sourceIds) => ipcRenderer.invoke('sources:reorder', sceneId, sourceIds),
    toggleVisible: (sceneId, sourceId) => ipcRenderer.invoke('sources:toggle-visible', sceneId, sourceId),
    toggleLock: (sceneId, sourceId) => ipcRenderer.invoke('sources:toggle-lock', sceneId, sourceId),
    getScreens: () => ipcRenderer.invoke('sources:get-screens'),
    getWindows: () => ipcRenderer.invoke('sources:get-windows'),
    getDshowDevices: () => ipcRenderer.invoke('sources:get-dshow-devices'),
    getDesktopStreamId: (sourceId) => ipcRenderer.invoke('sources:get-desktop-stream-id', sourceId),
  },

  // ─── FFmpeg ───────────────────────────────────────────
  ffmpeg: {
    check: () => ipcRenderer.invoke('ffmpeg:check'),
    install: () => ipcRenderer.invoke('ffmpeg:install'),
    onProgress: (cb) => ipcRenderer.on('ffmpeg:progress', (_, data) => cb(data)),
    onInstalled: (cb) => ipcRenderer.on('ffmpeg:installed', (_, data) => cb(data)),
  },

  // ─── Audio Mixer ─────────────────────────────────────
  audio: {
    getDevices: () => ipcRenderer.invoke('audio:get-devices'),
    setVolume: (id, vol) => ipcRenderer.invoke('audio:set-volume', id, vol),
    setMuted: (id, muted) => ipcRenderer.invoke('audio:set-muted', id, muted),
    getLevels: () => ipcRenderer.invoke('audio:get-levels'),
  },

  // ─── Stream Engine ───────────────────────────────────
  stream: {
    start: (config) => ipcRenderer.invoke('stream:start', config),
    stop: () => ipcRenderer.invoke('stream:stop'),
    getStatus: () => ipcRenderer.invoke('stream:get-status'),
    onStatus: (cb) => ipcRenderer.on('stream:status', (_, data) => cb(data)),
  },

  record: {
    start: (config) => ipcRenderer.invoke('record:start', config),
    stop: () => ipcRenderer.invoke('record:stop'),
  },

  virtualCam: {
    start: () => ipcRenderer.invoke('virtual-cam:start'),
    stop: () => ipcRenderer.invoke('virtual-cam:stop'),
  },

  // ─── Cam Site / BrowserView ──────────────────────────
  cam: {
    navigate: (url) => ipcRenderer.send('cam:navigate', url),
    back: () => ipcRenderer.send('cam:back'),
    forward: () => ipcRenderer.send('cam:forward'),
    reload: () => ipcRenderer.send('cam:reload'),
    onPlatformDetected: (cb) => ipcRenderer.on('cam:platform-detected', (_, p) => cb(p)),
  },

  // ─── AWS Services ────────────────────────────────────
  aws: {
    signIn: (email, password) => ipcRenderer.invoke('aws:sign-in', email, password),
    signOut: () => ipcRenderer.invoke('aws:sign-out'),
    getSession: () => ipcRenderer.invoke('aws:get-session'),
    bedrockPrompt: (trigger, ctx) => ipcRenderer.invoke('aws:bedrock-prompt', trigger, ctx),
    pollySpeak: (text) => ipcRenderer.invoke('aws:polly-speak', text),
    s3Backup: () => ipcRenderer.invoke('aws:s3-backup'),
    onAiPrompt: (cb) => ipcRenderer.on('aws:ai-prompt', (_, data) => cb(data)),
    onPollyAudio: (cb) => ipcRenderer.on('aws:polly-audio', (_, data) => cb(data)),
    onBackupDone: (cb) => ipcRenderer.on('aws:backup-done', (_, data) => cb(data)),
  },

  // ─── Live Data ───────────────────────────────────────
  onLiveUpdate: (cb) => ipcRenderer.on('live-update', (_, data) => cb(data)),

  // ─── Auto-Updater ────────────────────────────────────
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    install: () => ipcRenderer.send('updates:install'),
    onStatus: (cb) => ipcRenderer.on('updates:status', (_, data) => cb(data)),
  },

  // ─── Toy Sync ────────────────────────────────────────
  sync: {
    getState:           ()              => ipcRenderer.invoke('sync:get-state'),
    lovenseConnect:     (token)         => ipcRenderer.invoke('sync:lovense-connect', token),
    lovenseDisconnect:  ()              => ipcRenderer.invoke('sync:lovense-disconnect'),
    buttplugConnect:    (wsUrl)         => ipcRenderer.invoke('sync:buttplug-connect', wsUrl),
    buttplugDisconnect: ()              => ipcRenderer.invoke('sync:buttplug-disconnect'),
    vibrate:            (intensity, dur) => ipcRenderer.invoke('sync:vibrate', intensity, dur),
    saveTipMap:         (tipMap)        => ipcRenderer.invoke('sync:save-tip-map', tipMap),
    firePattern:        (id, intensity) => ipcRenderer.invoke('sync:fire-pattern', id, intensity),
    onState:            (cb)            => ipcRenderer.on('sync:state', (_, data) => cb(data)),
  },

  // ─── App Info ────────────────────────────────────────
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPlatforms: () => require('../shared/apex-config').DEFAULT_PLATFORMS,
  getWhaleTiers: () => require('../shared/apex-config').WHALE_TIERS,
});
