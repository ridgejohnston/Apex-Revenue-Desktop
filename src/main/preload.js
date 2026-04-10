/**
 * Preload Script - Exposes safe IPC bridge to renderer process
 *
 * Uses contextBridge to expose a controlled API surface.
 * The renderer NEVER gets direct access to Node.js or Electron.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('apex', {
  // ── OBS Core ──
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

  // ── Streaming ──
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

  // ── Recording ──
  recording: {
    configure: (settings) => ipcRenderer.invoke('recording:configure', settings),
    start: () => ipcRenderer.invoke('recording:start'),
    stop: () => ipcRenderer.invoke('recording:stop'),
    onStateChange: (cb) => {
      ipcRenderer.on('recording:stateChange', (_, data) => cb(data));
    }
  },

  // ── Settings ──
  settings: {
    get: (key) => ipcRenderer.invoke('settings:get', key),
    set: (key, value) => ipcRenderer.invoke('settings:set', key, value)
  },

  // ── Dialogs ──
  dialog: {
    selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),
    selectFile: (filters) => ipcRenderer.invoke('dialog:selectFile', filters)
  }
});
