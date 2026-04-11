/**
 * Apex Revenue Preload Script
 * Exposes secure IPC API to renderer process
 * Uses contextBridge for controlled API surface with no direct Node.js access
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apex', {
  // ──────────────────────────────────────────────
  // OBS STREAMING (Existing)
  // ──────────────────────────────────────────────

  obs: {
    initialize: () => ipcRenderer.invoke('obs:initialize'),
    getState: () => ipcRenderer.invoke('obs:getState'),
    getWebcamDevices: () => ipcRenderer.invoke('obs:getWebcamDevices'),
    getAudioInputDevices: () => ipcRenderer.invoke('obs:getAudioInputDevices'),
    addWebcam: (name, opts) => ipcRenderer.invoke('obs:addWebcam', name, opts),
    addDisplay: (name, opts) => ipcRenderer.invoke('obs:addDisplay', name, opts),
    addImage: (name, opts) => ipcRenderer.invoke('obs:addImage', name, opts),
    addVideo: (name, opts) => ipcRenderer.invoke('obs:addVideo', name, opts),
    addAudio: (name, opts) => ipcRenderer.invoke('obs:addAudio', name, opts),
    removeSource: (name) => ipcRenderer.invoke('obs:removeSource', name),
    setSourceVisible: (name, vis) => ipcRenderer.invoke('obs:setSourceVisible', name, vis),
    setSourceTransform: (name, t) => ipcRenderer.invoke('obs:setSourceTransform', name, t),
    createPreview: () => ipcRenderer.invoke('obs:createPreview'),
    resizePreview: (w, h) => ipcRenderer.invoke('obs:resizePreview', w, h)
  },

  // ──────────────────────────────────────────────
  // STREAMING (Existing)
  // ──────────────────────────────────────────────

  stream: {
    configure: (config) => ipcRenderer.invoke('stream:configure', config),
    start: () => ipcRenderer.invoke('stream:start'),
    stop: () => ipcRenderer.invoke('stream:stop'),
    getStatus: () => ipcRenderer.invoke('stream:getStatus'),
    getServers: () => ipcRenderer.invoke('stream:getServers'),
    onStateChange: (cb) => {
      ipcRenderer.on('stream:stateChange', (_, data) => cb(data));
    },
    onEvent: (cb) => {
      ipcRenderer.on('stream:event', (_, data) => cb(data));
    },
    onHealth: (cb) => {
      ipcRenderer.on('stream:health', (_, data) => cb(data));
    }
  },

  // ──────────────────────────────────────────────
  // RECORDING (Existing)
  // ──────────────────────────────────────────────

  recording: {
    configure: (settings) => ipcRenderer.invoke('recording:configure', settings),
    start: () => ipcRenderer.invoke('recording:start'),
    stop: () => ipcRenderer.invoke('recording:stop'),
    onStateChange: (cb) => {
      ipcRenderer.on('recording:stateChange', (_, data) => cb(data));
    }
  },

  // ──────────────────────────────────────────────
  // SETTINGS (Existing)
  // ──────────────────────────────────────────────

  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
  },

  // ──────────────────────────────────────────────
  // DIALOGS (Existing)
  // ──────────────────────────────────────────────

  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    selectFile: (filters) => ipcRenderer.invoke('dialog:selectFile', filters)
  },

  // ──────────────────────────────────────────────
  // AUTHENTICATION (New)
  // ──────────────────────────────────────────────

  auth: {
    login: (email, password) => ipcRenderer.invoke('auth:login', email, password),
    signup: (email, password) => ipcRenderer.invoke('auth:signup', email, password),
    confirmSignup: (email, code) => ipcRenderer.invoke('auth:confirmSignup', email, code),
    logout: () => ipcRenderer.invoke('auth:logout'),
    getSession: () => ipcRenderer.invoke('auth:getSession'),
    getUser: () => ipcRenderer.invoke('auth:getUser'),
    refreshTokens: () => ipcRenderer.invoke('auth:refreshTokens'),
    getLinkedAccounts: () => ipcRenderer.invoke('auth:getLinkedAccounts'),
    linkPlatform: (platform, username) =>
      ipcRenderer.invoke('auth:linkPlatform', platform, username),
    unlinkPlatform: (platform) => ipcRenderer.invoke('auth:unlinkPlatform', platform),
    isAdmin: () => ipcRenderer.invoke('auth:isAdmin'),
    onAuthChange: (callback) => {
      const listener = (event, user) => callback(user);
      ipcRenderer.on('auth:changed', listener);
      return () => ipcRenderer.removeListener('auth:changed', listener);
    }
  },

  // ──────────────────────────────────────────────
  // INTELLIGENCE (New)
  // ──────────────────────────────────────────────

  intelligence: {
    getLiveData: () => ipcRenderer.invoke('intelligence:getLiveData'),
    getFanLeaderboard: () => ipcRenderer.invoke('intelligence:getFanLeaderboard'),
    getEarnings: () => ipcRenderer.invoke('intelligence:getEarnings'),
    getSessions: () => ipcRenderer.invoke('intelligence:getSessions'),
    getTotalEarnings: () => ipcRenderer.invoke('intelligence:getTotalEarnings'),
    getSessionStats: () => ipcRenderer.invoke('intelligence:getSessionStats'),
    getAnalytics: (timeRange) =>
      ipcRenderer.invoke('intelligence:getAnalytics', timeRange),
    checkSubscription: () => ipcRenderer.invoke('intelligence:checkSubscription'),
    startSession: (roomName, settings) =>
      ipcRenderer.invoke('intelligence:startSession', roomName, settings),
    endSession: (roomName) => ipcRenderer.invoke('intelligence:endSession', roomName),
    recordTip: (amount, username, platform) =>
      ipcRenderer.invoke('intelligence:recordTip', amount, username, platform),
    onLiveUpdate: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('intelligence:liveUpdate', listener);
      return () => ipcRenderer.removeListener('intelligence:liveUpdate', listener);
    },
    onFanUpdate: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('intelligence:fanUpdate', listener);
      return () => ipcRenderer.removeListener('intelligence:fanUpdate', listener);
    },
    onSessionStarted: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('intelligence:sessionStarted', listener);
      return () => ipcRenderer.removeListener('intelligence:sessionStarted', listener);
    },
    onSessionEnded: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('intelligence:sessionEnded', listener);
      return () => ipcRenderer.removeListener('intelligence:sessionEnded', listener);
    },
    onBalanceUpdate: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('intelligence:balanceUpdate', listener);
      return () => ipcRenderer.removeListener('intelligence:balanceUpdate', listener);
    }
  },

  // ──────────────────────────────────────────────
  // RELAY (New)
  // ──────────────────────────────────────────────

  relay: {
    connect: (accessToken, username, platform) =>
      ipcRenderer.invoke('relay:connect', accessToken, username, platform),
    disconnect: () => ipcRenderer.invoke('relay:disconnect'),
    getStatus: () => ipcRenderer.invoke('relay:getStatus'),
    sendHeartbeat: () => ipcRenderer.invoke('relay:sendHeartbeat'),
    onFanControl: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('relay:fanControl', listener);
      return () => ipcRenderer.removeListener('relay:fanControl', listener);
    },
    onVibeCommand: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('relay:vibeCommand', listener);
      return () => ipcRenderer.removeListener('relay:vibeCommand', listener);
    },
    onRelayEvent: (callback) => {
      const listener = (event, data) => callback(data);
      ipcRenderer.on('relay:event', listener);
      return () => ipcRenderer.removeListener('relay:event', listener);
    },
    onConnected: (callback) => {
      const listener = (event) => callback();
      ipcRenderer.on('relay:connected', listener);
      return () => ipcRenderer.removeListener('relay:connected', listener);
    },
    onDisconnected: (callback) => {
      const listener = (event) => callback();
      ipcRenderer.on('relay:disconnected', listener);
      return () => ipcRenderer.removeListener('relay:disconnected', listener);
    }
  }
});
