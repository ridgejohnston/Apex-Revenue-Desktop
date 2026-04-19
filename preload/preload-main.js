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

  // ─── OBS Settings Autoconfig ─────────────────────────
  // detect() returns { recommendations, specs, encoderLabels } WITHOUT
  // saving — used by the UI to show the user what would change before
  // they confirm. applyDetected({ fields }) applies the user-selected
  // subset of recommendations and returns the merged result.
  obsSettings: {
    detect:        () => ipcRenderer.invoke('obs-settings:detect'),
    applyDetected: (fields) => ipcRenderer.invoke('obs-settings:apply-detected', { fields }),
    onAutoRefreshed: (cb) => ipcRenderer.on('obs-settings:auto-refreshed', (_, data) => cb(data)),
    // Fired when startStream's runtime encoder probe discovers the user's
    // saved encoder isn't usable on this machine (e.g. NVENC on a box
    // without NVIDIA drivers) and silently corrects to a working one.
    // The renderer shows a dismissible toast explaining what changed.
    onEncoderAutoHealed: (cb) => ipcRenderer.on('obs-settings:encoder-auto-healed', (_, data) => cb(data)),
  },

  // v3.3.4: webcam device enumeration for the Video Source selector.
  // Returns array of { name, alternativeName } — webcam devices only,
  // no audio devices (those remain under settings.audioDevice).
  webcam: {
    list: () => ipcRenderer.invoke('webcam:list'),
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

  // ─── Slideshow folder enumeration ────────────────────
  // Used by PreviewCanvas to list image files in a folder for
  // image_slideshow sources. The stream engine has its own sync
  // enumeration in _buildSlideshowInput; this IPC exists specifically
  // to avoid the renderer needing fs access.
  slideshow: {
    listImages: (folderPath) => ipcRenderer.invoke('slideshow:list-images', folderPath),
  },

  // ─── Native file / folder picker ──────────────────────
  // Used by AddSourceModal's Browse buttons. openFile accepts an
  // options object with filters (Electron showOpenDialog spec).
  // openFolder takes no args. Both return absolute path string or
  // null on cancel.
  dialog: {
    openFile: (options) => ipcRenderer.invoke('dialog:open-file', options),
    openFolder: (options) => ipcRenderer.invoke('dialog:open-folder', options),
  },

  // ─── Error Log / Debug ────────────────────────────────
  // Central error logger. log() pushes renderer errors into the
  // same store as main-process errors. copyToClipboard() is the
  // primary user-facing action — hit one button, paste to the
  // dev/AI assistant. recent()/readAll() back the debug panel UI.
  errors: {
    log: (level, source, message, context) =>
      ipcRenderer.invoke('errors:log', level, source, message, context),
    recent: (n) => ipcRenderer.invoke('errors:recent', n),
    readAll: () => ipcRenderer.invoke('errors:read-all'),
    clear: () => ipcRenderer.invoke('errors:clear'),
    openFolder: () => ipcRenderer.invoke('errors:open-folder'),
    copyToClipboard: () => ipcRenderer.invoke('errors:copy-to-clipboard'),
  },

  // ─── FFmpeg ───────────────────────────────────────────
  ffmpeg: {
    check: () => ipcRenderer.invoke('ffmpeg:check'),
    install: () => ipcRenderer.invoke('ffmpeg:install'),
    onProgress: (cb) => ipcRenderer.on('ffmpeg:progress', (_, data) => cb(data)),
    onInstalled: (cb) => ipcRenderer.on('ffmpeg:installed', (_, data) => cb(data)),
  },

  // ─── MediaPipe: WASM + model installer ──────────────
  // Bundled @mediapipe/tasks-vision ships with every app release (it's
  // in package.json deps), but the ~5 MB WASM + segmentation model are
  // fetched separately so users who never use background effects don't
  // pay for them. The Install button in BeautyPanel drives this bridge.
  mediapipe: {
    status:      () => ipcRenderer.invoke('mediapipe:status'),
    install:     () => ipcRenderer.invoke('mediapipe:install'),
    uninstall:   () => ipcRenderer.invoke('mediapipe:uninstall'),
    onProgress:  (cb) => {
      const h = (_, data) => cb(data);
      ipcRenderer.on('mediapipe:progress', h);
      return () => ipcRenderer.removeListener('mediapipe:progress', h);
    },
  },

  // ─── AI Coach: multi-turn chat ──────────────────────
  // Conversational coach for live cam performers. Companion to the
  // one-shot AI Prompt Engine (aws.bedrockPrompt) — different UX,
  // same Bedrock client under the hood.
  coach: {
    sendMessage: (text, liveContext) =>
      ipcRenderer.invoke('coach:send-message', text, liveContext),
    reset:       () => ipcRenderer.invoke('coach:reset'),
    history:     () => ipcRenderer.invoke('coach:history'),
    // Training Log — knowledge artifacts the coach has acquired
    knowledgeList:   () => ipcRenderer.invoke('coach:knowledge-list'),
    knowledgeDelete: (filename) => ipcRenderer.invoke('coach:knowledge-delete', filename),
    knowledgeStats:  () => ipcRenderer.invoke('coach:knowledge-stats'),
    // Performer profile — niche, goals, hard NOs, regulars, style prefs.
    // Changes here affect every subsequent coach response (injected
    // into the system prompt). Local-only, not synced anywhere.
    profileGet:    () => ipcRenderer.invoke('coach:profile-get'),
    profileUpdate: (patch) => ipcRenderer.invoke('coach:profile-update', patch),
    profileClear:  () => ipcRenderer.invoke('coach:profile-clear'),
    // Progress events during long-running /research calls. Returns an
    // unsubscribe fn per React's useEffect cleanup idiom.
    onResearchProgress: (cb) => {
      const h = (_, data) => cb(data);
      ipcRenderer.on('coach:research-progress', h);
      return () => ipcRenderer.removeListener('coach:research-progress', h);
    },
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
    // Pipe-mode streaming (used for webcam sources). The renderer owns
    // the camera via getUserMedia, captures WebM chunks with
    // MediaRecorder, and sends them to FFmpeg over stdin via IPC.
    // Keeps the camera available to the renderer for preview rendering.
    startPipe: (config) => ipcRenderer.invoke('stream:start-pipe', config),
    stopPipe: () => ipcRenderer.invoke('stream:stop-pipe'),
    sendWebmChunk: (buffer) => ipcRenderer.send('stream:webm-chunk', buffer),
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

  // ─── Auth (Cognito Hosted UI + PKCE) ─────────────────
  auth: {
    hostedUiSignIn: () => ipcRenderer.invoke('auth:hosted-ui-signin'),
    signOut:        () => ipcRenderer.invoke('auth:sign-out'),
    getSession:     () => ipcRenderer.invoke('auth:get-session'),
    onSignedOutRemote: (cb) => ipcRenderer.on('auth:signed-out-remote', () => cb()),
  },

  // ─── Subscription / Billing ──────────────────────────
  subscription: {
    get:     (opts = {}) => ipcRenderer.invoke('subscription:get', opts),
    refresh: () => ipcRenderer.invoke('subscription:refresh'),
    onUpdated:        (cb) => ipcRenderer.on('subscription:updated',        (_, data) => cb(data)),
    onSoftExpired:    (cb) => ipcRenderer.on('subscription:soft-expired',   (_, data) => cb(data)),
    onExpiryWarning:  (cb) => ipcRenderer.on('subscription:expiry-warning', (_, data) => cb(data)),
  },

  // ─── Admin Dev Access (tier toggle) ──────────────────
  admin: {
    setTierToggle: (tier) => ipcRenderer.invoke('admin:set-tier-toggle', tier),
    getTierToggle: () => ipcRenderer.invoke('admin:get-tier-toggle'),
    onTierToggleChanged: (cb) => ipcRenderer.on('admin:tier-toggle-changed', (_, data) => cb(data)),
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
