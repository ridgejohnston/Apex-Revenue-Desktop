// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Main Window Preload v3.0
// AWS credentials are auto-loaded at boot — no setup IPC needed here.
// ═══════════════════════════════════════════════════════════════════════════════

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {

  // ── Store ──────────────────────────────────────────────────────────────────
  store: {
    get:    k   => ipcRenderer.invoke('store:get', k),
    set:    (k,v) => ipcRenderer.invoke('store:set', k, v),
    getAll: ()  => ipcRenderer.invoke('store:getAll'),
  },

  // ── Window controls ────────────────────────────────────────────────────────
  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    maximize: () => ipcRenderer.send('window:maximize'),
    close:    () => ipcRenderer.send('window:close'),
    quit:     () => ipcRenderer.send('window:quit'),
  },

  // ── Shell ──────────────────────────────────────────────────────────────────
  openExternal: url => ipcRenderer.send('shell:open', url),

  // ── Browser navigation (drives the BrowserView) ───────────────────────────
  navigate:      url => ipcRenderer.send('cam:navigate', url),
  camBack:       ()  => ipcRenderer.send('cam:back'),
  camForward:    ()  => ipcRenderer.send('cam:forward'),
  camReload:     ()  => ipcRenderer.send('cam:reload'),
  camCurrentUrl: ()  => ipcRenderer.invoke('cam:currentUrl'),

  // ── App events ─────────────────────────────────────────────────────────────
  setUsername: u => ipcRenderer.send('app:set-username', u),
  sessionEnd:  () => ipcRenderer.send('app:session-end'),

  // ── AWS service calls (auto-configured, always available) ──────────────────
  aws: {
    s3Backup:      data   => ipcRenderer.invoke('aws:s3-backup', data),
    bedrockPrompt: (data, trigger) => ipcRenderer.invoke('aws:bedrock-prompt', { sessionData: data, trigger }),
    pollySpeakText: text  => ipcRenderer.invoke('aws:polly-speak', text),
  },

  // ── Auto-updater ───────────────────────────────────────────────────────────
  updater: {
    checkNow:      ()  => ipcRenderer.invoke('update:check'),
    getStatus:     ()  => ipcRenderer.invoke('update:status'),
    installNow:    ()  => ipcRenderer.send('update:install'),
    setBannerHeight: h => ipcRenderer.send('update:banner-height', h),
  },

  // ── Inbound events ─────────────────────────────────────────────────────────
  onLiveUpdate:       cb => ipcRenderer.on('live-update',        (_, d) => cb(d)),
  onPlatformDetected: cb => ipcRenderer.on('platform-detected',  (_, p) => cb(p)),
  onUrlChanged:       cb => ipcRenderer.on('cam:url-changed',    (_, u) => cb(u)),
  onTitleChanged:     cb => ipcRenderer.on('cam:title-changed',  (_, t) => cb(t)),
  onAiPrompt:         cb => ipcRenderer.on('aws:ai-prompt',      (_, d) => cb(d)),
  onPollyAudio:       cb => ipcRenderer.on('aws:polly-audio',    (_, d) => cb(d)),
  onBackupDone:       cb => ipcRenderer.on('aws:backup-done',    (_, d) => cb(d)),
  onAwsStatus:        cb => ipcRenderer.on('aws:status',         (_, d) => cb(d)),

  // ── Update event listeners ─────────────────────────────────────────────────
  onUpdateChecking:   cb => ipcRenderer.on('update:checking',    ()     => cb()),
  onUpdateAvailable:  cb => ipcRenderer.on('update:available',   (_, d) => cb(d)),
  onUpdateProgress:   cb => ipcRenderer.on('update:progress',    (_, d) => cb(d)),
  onUpdateReady:      cb => ipcRenderer.on('update:ready',       (_, d) => cb(d)),
  onUpdateNotAvail:   cb => ipcRenderer.on('update:not-available',(_, d)=> cb(d)),
  onUpdateError:      cb => ipcRenderer.on('update:error',       (_, d) => cb(d)),

  // App asset (app.asar) hot-update events
  onAppUpdateDownloading: cb => ipcRenderer.on('app-update:downloading', (_, d) => cb(d)),
  onAppUpdateProgress:    cb => ipcRenderer.on('app-update:progress',    (_, d) => cb(d)),
  onAppUpdateReady:       cb => ipcRenderer.on('app-update:ready',       (_, d) => cb(d)),
  onAppUpdateError:       cb => ipcRenderer.on('app-update:error',       (_, d) => cb(d)),
  removeAllListeners: ch => ipcRenderer.removeAllListeners(ch),
});
