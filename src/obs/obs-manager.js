/**
 * OBS Manager - Core libobs integration via obs-studio-node
 *
 * Handles all OBS lifecycle: initialization, scene/source management,
 * encoder configuration, preview rendering, and streaming/recording output.
 *
 * IMPORTANT: This module MUST run in the Electron main process only.
 * The renderer process communicates via IPC handlers registered in main.js.
 */

const path = require('path');
const { v4: uuidv4 } = require('uuid');

let osn;
try {
  // Try loading from local osn/ directory (downloaded by scripts/setup-osn.js)
  const osnPath = path.join(__dirname, '..', '..', 'osn');
  osn = require(osnPath);
} catch (e1) {
  try {
    // Fallback: try from extraResources path (packaged Electron app)
    const resourcePath = process.resourcesPath
      ? path.join(process.resourcesPath, 'osn')
      : null;
    if (resourcePath) {
      osn = require(resourcePath);
    } else {
      throw e1;
    }
  } catch (e2) {
    console.warn('[OBS Manager] obs-studio-node not available:', e2.message);
    console.warn('[OBS Manager] Run "npm run setup" to download OBS binaries');
    osn = null;
  }
}

class OBSManager {
  constructor() {
    this.initialized = false;
    this.scene = null;
    this.sources = new Map();       // name -> { input, sceneItem }
    this.audioSources = new Map();  // name -> input
    this.streaming = false;
    this.recording = false;
    this.signalCallback = null;
    this.previewDisplayId = null;
  }

  // ─────────────────────────────────────────────
  // INITIALIZATION
  // ─────────────────────────────────────────────

  /**
   * Initialize the OBS backend.
   * Must be called once before any other OBS operations.
   *
   * @param {Object} options
   * @param {string} options.dataPath - Path to store OBS config/profiles
   * @param {string} options.locale - Locale string (default: 'en-US')
   */
  async initialize(options = {}) {
    if (!osn) {
      throw new Error('obs-studio-node is not installed. Run: npm install @streamlabs/obs-studio-node');
    }

    if (this.initialized) {
      console.log('[OBS Manager] Already initialized');
      return;
    }

    const {
      dataPath = path.join(require('os').homedir(), '.apex-revenue', 'obs-config'),
      locale = 'en-US'
    } = options;

    try {
      // 1. Host IPC server for obs-studio-node communication
      const uniqueId = `apex-revenue-${uuidv4()}`;
      osn.NodeObs.IPC.host(uniqueId);

      // 2. Set the working directory to the osn module
      let osnWorkDir = path.join(__dirname, '..', '..', 'osn');
      // In packaged app, use extraResources path
      if (process.resourcesPath && !require('fs').existsSync(osnWorkDir)) {
        osnWorkDir = path.join(process.resourcesPath, 'osn');
      }
      osn.NodeObs.SetWorkingDirectory(osnWorkDir);

      // 3. Initialize the OBS API
      const initResult = osn.NodeObs.OBS_API_initAPI(locale, dataPath, '1.0.0');
      if (initResult !== 0) {
        throw new Error(`OBS_API_initAPI failed with code: ${initResult}`);
      }

      // 4. Connect output signals for state monitoring
      this._connectSignals();

      this.initialized = true;
      console.log('[OBS Manager] Initialized successfully');
    } catch (err) {
      console.error('[OBS Manager] Initialization failed:', err);
      throw err;
    }
  }

  // ─────────────────────────────────────────────
  // VIDEO SETTINGS
  // ─────────────────────────────────────────────

  /**
   * Configure video output settings.
   *
   * @param {Object} settings
   * @param {string} settings.baseResolution - Base (canvas) resolution, e.g. '1920x1080'
   * @param {string} settings.outputResolution - Output (scaled) resolution, e.g. '1920x1080'
   * @param {number} settings.fps - Frames per second (default: 30)
   */
  configureVideo(settings = {}) {
    this._ensureInitialized();

    const {
      baseResolution = '1920x1080',
      outputResolution = '1920x1080',
      fps = 30
    } = settings;

    osn.NodeObs.OBS_settings_saveSettings('Video', {
      Base: baseResolution,
      Output: outputResolution,
      FPSCommon: String(fps),
      FPSType: 'Common FPS Values',
      ScaleType: 'bilinear'
    });

    console.log(`[OBS Manager] Video configured: ${baseResolution} -> ${outputResolution} @ ${fps}fps`);
  }

  // ─────────────────────────────────────────────
  // SCENE MANAGEMENT
  // ─────────────────────────────────────────────

  /**
   * Create the main scene. Only one scene is used for the Apex Revenue workflow.
   *
   * @param {string} name - Scene name (default: 'apex-main')
   */
  createScene(name = 'apex-main') {
    this._ensureInitialized();

    if (this.scene) {
      console.log('[OBS Manager] Removing existing scene');
      this.scene.release();
    }

    this.scene = osn.SceneFactory.create(name);
    console.log(`[OBS Manager] Scene created: ${name}`);
    return this.scene;
  }

  // ─────────────────────────────────────────────
  // SOURCE MANAGEMENT
  // ─────────────────────────────────────────────

  /**
   * Get available video capture devices (webcams).
   * @returns {Array<{id: string, name: string}>}
   */
  getWebcamDevices() {
    this._ensureInitialized();

    const platform = process.platform;
    const inputType = platform === 'win32' ? 'dshow_input' : 'av_capture_input';

    try {
      const dummyInput = osn.InputFactory.create(inputType, '__device_enum');
      const properties = dummyInput.properties;
      const deviceProp = properties.get(platform === 'win32' ? 'video_device_id' : 'device');
      const devices = [];

      if (deviceProp && deviceProp.details && deviceProp.details.items) {
        for (const item of deviceProp.details.items) {
          devices.push({ id: item.value, name: item.name });
        }
      }

      dummyInput.release();
      return devices;
    } catch (err) {
      console.error('[OBS Manager] Failed to enumerate webcam devices:', err);
      return [];
    }
  }

  /**
   * Get available audio input devices (microphones).
   * @returns {Array<{id: string, name: string}>}
   */
  getAudioInputDevices() {
    this._ensureInitialized();

    const inputType = process.platform === 'win32' ? 'wasapi_input_capture' : 'coreaudio_input_capture';

    try {
      const dummyInput = osn.InputFactory.create(inputType, '__audio_enum');
      const properties = dummyInput.properties;
      const deviceProp = properties.get('device_id');
      const devices = [];

      if (deviceProp && deviceProp.details && deviceProp.details.items) {
        for (const item of deviceProp.details.items) {
          devices.push({ id: item.value, name: item.name });
        }
      }

      dummyInput.release();
      return devices;
    } catch (err) {
      console.error('[OBS Manager] Failed to enumerate audio input devices:', err);
      return [];
    }
  }

  /**
   * Add a webcam source to the scene.
   *
   * @param {string} name - Unique source name
   * @param {Object} options
   * @param {string} options.deviceId - Camera device ID
   * @param {Object} options.position - {x, y} position on canvas
   * @param {Object} options.scale - {x, y} scale factors
   */
  addWebcamSource(name, options = {}) {
    this._ensureInitialized();
    this._ensureScene();

    const {
      deviceId = '',
      position = { x: 0, y: 0 },
      scale = { x: 1, y: 1 }
    } = options;

    const platform = process.platform;
    const inputType = platform === 'win32' ? 'dshow_input' : 'av_capture_input';
    const deviceProp = platform === 'win32' ? 'video_device_id' : 'device';

    const settings = {};
    if (deviceId) settings[deviceProp] = deviceId;

    const input = osn.InputFactory.create(inputType, name, settings);
    const sceneItem = this.scene.add(input);
    sceneItem.position = position;
    sceneItem.scale = scale;

    this.sources.set(name, { input, sceneItem });
    console.log(`[OBS Manager] Webcam source added: ${name}`);
    return sceneItem;
  }

  /**
   * Add a display/screen capture source to the scene.
   *
   * @param {string} name - Unique source name
   * @param {Object} options
   * @param {number} options.monitor - Monitor index (default: 0)
   * @param {Object} options.position - {x, y} position
   * @param {Object} options.scale - {x, y} scale
   */
  addDisplaySource(name, options = {}) {
    this._ensureInitialized();
    this._ensureScene();

    const {
      monitor = 0,
      position = { x: 0, y: 0 },
      scale = { x: 1, y: 1 }
    } = options;

    const platform = process.platform;
    const inputType = platform === 'win32' ? 'monitor_capture' : 'display_capture';
    const monitorProp = platform === 'win32' ? 'monitor' : 'display';

    const input = osn.InputFactory.create(inputType, name, {
      [monitorProp]: monitor
    });

    const sceneItem = this.scene.add(input);
    sceneItem.position = position;
    sceneItem.scale = scale;

    this.sources.set(name, { input, sceneItem });
    console.log(`[OBS Manager] Display source added: ${name} (monitor ${monitor})`);
    return sceneItem;
  }

  /**
   * Add an image overlay source to the scene.
   *
   * @param {string} name - Unique source name
   * @param {Object} options
   * @param {string} options.file - Path to image file
   * @param {Object} options.position - {x, y} position
   * @param {Object} options.scale - {x, y} scale
   */
  addImageSource(name, options = {}) {
    this._ensureInitialized();
    this._ensureScene();

    const {
      file = '',
      position = { x: 0, y: 0 },
      scale = { x: 1, y: 1 }
    } = options;

    const input = osn.InputFactory.create('image_source', name, { file });
    const sceneItem = this.scene.add(input);
    sceneItem.position = position;
    sceneItem.scale = scale;

    this.sources.set(name, { input, sceneItem });
    console.log(`[OBS Manager] Image source added: ${name}`);
    return sceneItem;
  }

  /**
   * Add a video file source to the scene.
   *
   * @param {string} name - Unique source name
   * @param {Object} options
   * @param {string} options.file - Path to video file
   * @param {boolean} options.looping - Loop the video (default: true)
   * @param {Object} options.position - {x, y} position
   * @param {Object} options.scale - {x, y} scale
   */
  addVideoSource(name, options = {}) {
    this._ensureInitialized();
    this._ensureScene();

    const {
      file = '',
      looping = true,
      position = { x: 0, y: 0 },
      scale = { x: 1, y: 1 }
    } = options;

    const input = osn.InputFactory.create('ffmpeg_source', name, {
      local_file: file,
      looping,
      is_local_file: true
    });

    const sceneItem = this.scene.add(input);
    sceneItem.position = position;
    sceneItem.scale = scale;

    this.sources.set(name, { input, sceneItem });
    console.log(`[OBS Manager] Video source added: ${name}`);
    return sceneItem;
  }

  /**
   * Add an audio capture source (microphone or desktop audio).
   *
   * @param {string} name - Unique source name
   * @param {Object} options
   * @param {string} options.type - 'microphone' or 'desktop'
   * @param {string} options.deviceId - Audio device ID
   */
  addAudioSource(name, options = {}) {
    this._ensureInitialized();

    const {
      type = 'microphone',
      deviceId = 'default'
    } = options;

    const platform = process.platform;
    let inputType;

    if (type === 'desktop') {
      inputType = platform === 'win32' ? 'wasapi_output_capture' : 'coreaudio_output_capture';
    } else {
      inputType = platform === 'win32' ? 'wasapi_input_capture' : 'coreaudio_input_capture';
    }

    const input = osn.InputFactory.create(inputType, name, {
      device_id: deviceId
    });

    this.audioSources.set(name, input);
    console.log(`[OBS Manager] Audio source added: ${name} (${type})`);
    return input;
  }

  /**
   * Remove a source from the scene.
   * @param {string} name - Source name to remove
   */
  removeSource(name) {
    const source = this.sources.get(name);
    if (source) {
      source.sceneItem.remove();
      source.input.release();
      this.sources.delete(name);
      console.log(`[OBS Manager] Source removed: ${name}`);
    }

    const audioSource = this.audioSources.get(name);
    if (audioSource) {
      audioSource.release();
      this.audioSources.delete(name);
      console.log(`[OBS Manager] Audio source removed: ${name}`);
    }
  }

  /**
   * Update a source's visibility.
   * @param {string} name - Source name
   * @param {boolean} visible - Whether source is visible
   */
  setSourceVisible(name, visible) {
    const source = this.sources.get(name);
    if (source) {
      source.sceneItem.visible = visible;
    }
  }

  /**
   * Update a source's position and scale.
   * @param {string} name - Source name
   * @param {Object} transform - {position: {x, y}, scale: {x, y}}
   */
  setSourceTransform(name, transform) {
    const source = this.sources.get(name);
    if (source) {
      if (transform.position) source.sceneItem.position = transform.position;
      if (transform.scale) source.sceneItem.scale = transform.scale;
      if (transform.rotation !== undefined) source.sceneItem.rotation = transform.rotation;
    }
  }

  // ─────────────────────────────────────────────
  // ENCODER & OUTPUT CONFIGURATION
  // ─────────────────────────────────────────────

  /**
   * Configure the streaming encoder settings.
   *
   * @param {Object} settings
   * @param {string} settings.encoder - Encoder type: 'x264', 'nvenc', 'qsv' (default: 'x264')
   * @param {number} settings.bitrate - Video bitrate in kbps (default: 2500)
   * @param {string} settings.preset - Encoder preset (default: 'veryfast')
   * @param {string} settings.rateControl - Rate control: 'CBR' or 'VBR' (default: 'CBR')
   * @param {number} settings.audioBitrate - Audio bitrate in kbps (default: 160)
   */
  configureStreamEncoder(settings = {}) {
    this._ensureInitialized();

    const {
      encoder = 'x264',
      bitrate = 2500,
      preset = 'veryfast',
      rateControl = 'CBR',
      audioBitrate = 160
    } = settings;

    // Map friendly names to OBS encoder IDs
    const encoderMap = {
      'x264': 'obs_x264',
      'nvenc': 'ffmpeg_nvenc',
      'qsv': 'obs_qsv11'
    };

    const encoderId = encoderMap[encoder] || 'obs_x264';

    osn.NodeObs.OBS_settings_saveSettings('Output', {
      Mode: 'Advanced',
      StreamEncoder: encoderId,
      VBitrate: bitrate,
      ABitrate: String(audioBitrate),
      Preset: preset,
      rate_control: rateControl
    });

    console.log(`[OBS Manager] Stream encoder configured: ${encoder} @ ${bitrate}kbps`);
  }

  /**
   * Configure the recording encoder and output settings.
   *
   * @param {Object} settings
   * @param {string} settings.outputPath - Directory to save recordings
   * @param {string} settings.format - Output format: 'mkv', 'mp4', 'flv' (default: 'mkv')
   * @param {number} settings.bitrate - Video bitrate in kbps (default: 6000)
   * @param {string} settings.encoder - Encoder: 'x264', 'nvenc' (default: 'x264')
   */
  configureRecording(settings = {}) {
    this._ensureInitialized();

    const {
      outputPath = path.join(require('os').homedir(), 'Videos', 'ApexRevenue'),
      format = 'mkv',
      bitrate = 6000,
      encoder = 'x264'
    } = settings;

    const encoderMap = {
      'x264': 'obs_x264',
      'nvenc': 'ffmpeg_nvenc'
    };

    osn.NodeObs.OBS_settings_saveSettings('Output', {
      RecEncoder: encoderMap[encoder] || 'obs_x264',
      RecFilePath: outputPath,
      RecFormat: format,
      RecVBitrate: bitrate
    });

    console.log(`[OBS Manager] Recording configured: ${format} @ ${bitrate}kbps -> ${outputPath}`);
  }

  // ─────────────────────────────────────────────
  // STREAMING SERVICE (RTMP)
  // ─────────────────────────────────────────────

  /**
   * Configure the RTMP streaming service.
   *
   * @param {Object} settings
   * @param {string} settings.server - RTMP server URL
   * @param {string} settings.key - Stream key / broadcast token
   */
  configureStreamService(settings = {}) {
    this._ensureInitialized();

    const {
      server = '',
      key = ''
    } = settings;

    if (!server || !key) {
      throw new Error('RTMP server URL and stream key are required');
    }

    osn.NodeObs.OBS_settings_saveSettings('Stream', {
      streamType: 'rtmp_custom',
      server: server,
      key: key
    });

    console.log(`[OBS Manager] Stream service configured: ${server}`);
  }

  // ─────────────────────────────────────────────
  // STREAMING CONTROLS
  // ─────────────────────────────────────────────

  /**
   * Start streaming to the configured RTMP server.
   */
  startStreaming() {
    this._ensureInitialized();

    if (this.streaming) {
      console.log('[OBS Manager] Already streaming');
      return;
    }

    osn.NodeObs.OBS_service_startStreaming();
    this.streaming = true;
    console.log('[OBS Manager] Streaming started');
  }

  /**
   * Stop the current stream.
   */
  stopStreaming() {
    this._ensureInitialized();

    if (!this.streaming) {
      console.log('[OBS Manager] Not currently streaming');
      return;
    }

    osn.NodeObs.OBS_service_stopStreaming();
    this.streaming = false;
    console.log('[OBS Manager] Streaming stopped');
  }

  /**
   * Start recording to disk.
   */
  startRecording() {
    this._ensureInitialized();

    if (this.recording) {
      console.log('[OBS Manager] Already recording');
      return;
    }

    osn.NodeObs.OBS_service_startRecording();
    this.recording = true;
    console.log('[OBS Manager] Recording started');
  }

  /**
   * Stop recording.
   */
  stopRecording() {
    this._ensureInitialized();

    if (!this.recording) {
      console.log('[OBS Manager] Not currently recording');
      return;
    }

    osn.NodeObs.OBS_service_stopRecording();
    this.recording = false;
    console.log('[OBS Manager] Recording stopped');
  }

  // ─────────────────────────────────────────────
  // PREVIEW DISPLAY
  // ─────────────────────────────────────────────

  /**
   * Create a preview display embedded in an Electron BrowserWindow.
   *
   * @param {Buffer} windowHandle - Native window handle from BrowserWindow.getNativeWindowHandle()
   * @param {Object} size - {width, height} of the preview area
   * @param {string} displayId - Unique display identifier (default: 'main-preview')
   */
  createPreview(windowHandle, size = {}, displayId = 'main-preview') {
    this._ensureInitialized();

    const { width = 1280, height = 720 } = size;

    osn.NodeObs.OBS_content_createDisplay(windowHandle, displayId, 0);
    osn.NodeObs.OBS_content_resizeDisplay(displayId, width, height);
    osn.NodeObs.OBS_content_setPaddingSize(displayId, 0);
    osn.NodeObs.OBS_content_setBackgroundColor(displayId, 24, 24, 28, 255);

    this.previewDisplayId = displayId;
    console.log(`[OBS Manager] Preview display created: ${displayId} (${width}x${height})`);
  }

  /**
   * Resize the preview display.
   * @param {number} width
   * @param {number} height
   */
  resizePreview(width, height) {
    if (this.previewDisplayId) {
      osn.NodeObs.OBS_content_resizeDisplay(this.previewDisplayId, width, height);
    }
  }

  /**
   * Destroy the preview display.
   */
  destroyPreview() {
    if (this.previewDisplayId) {
      osn.NodeObs.OBS_content_destroyDisplay(this.previewDisplayId);
      this.previewDisplayId = null;
    }
  }

  // ─────────────────────────────────────────────
  // STATE & STATUS
  // ─────────────────────────────────────────────

  /**
   * Get the current state of the OBS manager.
   * @returns {Object} Current state
   */
  getState() {
    return {
      initialized: this.initialized,
      streaming: this.streaming,
      recording: this.recording,
      scene: this.scene ? this.scene.name : null,
      sources: Array.from(this.sources.keys()),
      audioSources: Array.from(this.audioSources.keys()),
      hasPreview: !!this.previewDisplayId
    };
  }

  // ─────────────────────────────────────────────
  // SHUTDOWN
  // ─────────────────────────────────────────────

  /**
   * Shut down the OBS backend and release all resources.
   * Call this before app exit.
   */
  async shutdown() {
    if (!this.initialized) return;

    console.log('[OBS Manager] Shutting down...');

    // Stop outputs
    if (this.streaming) this.stopStreaming();
    if (this.recording) this.stopRecording();

    // Destroy preview
    this.destroyPreview();

    // Release all sources
    for (const [name, source] of this.sources) {
      source.input.release();
    }
    this.sources.clear();

    for (const [name, input] of this.audioSources) {
      input.release();
    }
    this.audioSources.clear();

    // Release scene
    if (this.scene) {
      this.scene.release();
      this.scene = null;
    }

    // Shutdown OBS
    try {
      osn.NodeObs.OBS_service_removeCallback();
      osn.NodeObs.IPC.disconnect();
    } catch (err) {
      console.error('[OBS Manager] Error during shutdown:', err);
    }

    this.initialized = false;
    console.log('[OBS Manager] Shutdown complete');
  }

  // ─────────────────────────────────────────────
  // PRIVATE HELPERS
  // ─────────────────────────────────────────────

  _ensureInitialized() {
    if (!this.initialized) {
      throw new Error('OBS Manager is not initialized. Call initialize() first.');
    }
  }

  _ensureScene() {
    if (!this.scene) {
      throw new Error('No scene created. Call createScene() first.');
    }
  }

  _connectSignals() {
    osn.NodeObs.OBS_service_connectOutputSignals((signal) => {
      console.log(`[OBS Manager] Signal: ${signal.type} (${signal.signal})`);

      switch (signal.type) {
        case 'streaming':
          if (signal.signal === 'stop') {
            this.streaming = false;
          }
          break;
        case 'recording':
          if (signal.signal === 'stop') {
            this.recording = false;
          }
          break;
      }

      // Forward to external callback if registered
      if (this.signalCallback) {
        this.signalCallback(signal);
      }
    });
  }

  /**
   * Register a callback for OBS output signals.
   * @param {Function} callback - Called with signal object {type, signal}
   */
  onSignal(callback) {
    this.signalCallback = callback;
  }
}

// Singleton instance
const obsManager = new OBSManager();
module.exports = obsManager;
