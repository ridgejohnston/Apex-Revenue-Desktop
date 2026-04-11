/**
 * Stream Service - Chaturbate RTMP streaming service
 *
 * Manages RTMP connection profiles, Chaturbate-specific configuration,
 * and stream lifecycle with health monitoring.
 */

const obsManager = require('./obs-manager');

// Known Chaturbate RTMP servers
const CHATURBATE_SERVERS = {
  global: {
    name: 'Global (Recommended)',
    url: 'rtmp://global.live.mmcdn.com/live-origin'
  }
};

class StreamService {
  constructor() {
    this.profile = null;
    this.healthInterval = null;
    this.streamStartTime = null;
    this.eventHandlers = new Map();
  }

  /**
   * Configure a Chaturbate streaming profile.
   *
   * @param {Object} config
   * @param {string} config.broadcastToken - Your Chaturbate broadcast token (stream key)
   * @param {string} config.server - Server key or custom RTMP URL (default: 'global')
   * @param {number} config.bitrate - Video bitrate in kbps (default: 2500)
   * @param {string} config.encoder - Encoder: 'x264', 'nvenc' (default: 'x264')
   * @param {string} config.resolution - Output resolution (default: '1920x1080')
   * @param {number} config.fps - Frames per second (default: 30)
   * @param {number} config.audioBitrate - Audio bitrate in kbps (default: 160)
   * @param {string} config.preset - Encoder preset (default: 'veryfast')
   */
  configure(config = {}) {
    const {
      broadcastToken = '',
      server = 'global',
      bitrate = 2500,
      encoder = 'x264',
      resolution = '1920x1080',
      fps = 30,
      audioBitrate = 160,
      preset = 'veryfast'
    } = config;

    if (!broadcastToken) {
      throw new Error('Broadcast token is required. Get it from Chaturbate: Broadcast Yourself -> Use External Encoder -> View RTMP/OBS broadcast information');
    }

    // Resolve server URL — use as-is if it looks like a URL, otherwise look up preset
    const serverUrl = server.startsWith('rtmp://') || server.startsWith('rtmps://')
      ? server
      : (CHATURBATE_SERVERS[server] ? CHATURBATE_SERVERS[server].url : server);

    console.log(`[Stream Service] Resolved server: "${server}" -> "${serverUrl}"`);

    this.profile = {
      broadcastToken,
      serverUrl,
      serverName: CHATURBATE_SERVERS[server] ? CHATURBATE_SERVERS[server].name : 'Custom',
      bitrate,
      encoder,
      resolution,
      fps,
      audioBitrate,
      preset
    };

    // Apply video settings
    obsManager.configureVideo({
      baseResolution: resolution,
      outputResolution: resolution,
      fps
    });

    // Apply encoder settings
    obsManager.configureStreamEncoder({
      encoder,
      bitrate,
      preset,
      rateControl: 'CBR',
      audioBitrate
    });

    // Apply RTMP service
    obsManager.configureStreamService({
      server: serverUrl,
      key: broadcastToken
    });

    console.log(`[Stream Service] Configured for Chaturbate (${this.profile.serverName})`);
    console.log(`[Stream Service] ${encoder} @ ${bitrate}kbps, ${resolution} @ ${fps}fps`);

    return this.profile;
  }

  /**
   * Start streaming to Chaturbate.
   */
  async startStream() {
    if (!this.profile) {
      throw new Error('Stream not configured. Call configure() first.');
    }

    // Register signal handler for stream state changes
    obsManager.onSignal((signal) => {
      this._handleSignal(signal);
    });

    obsManager.startStreaming();
    this.streamStartTime = Date.now();
    this._startHealthMonitor();

    this._emit('streamStart', {
      server: this.profile.serverName,
      time: new Date().toISOString()
    });
  }

  /**
   * Stop streaming.
   */
  async stopStream() {
    obsManager.stopStreaming();
    this._stopHealthMonitor();

    const duration = this.streamStartTime
      ? Math.floor((Date.now() - this.streamStartTime) / 1000)
      : 0;

    this.streamStartTime = null;

    this._emit('streamStop', {
      duration,
      time: new Date().toISOString()
    });
  }

  /**
   * Get current stream status.
   * @returns {Object} Stream status
   */
  getStatus() {
    const state = obsManager.getState();
    const uptime = this.streamStartTime
      ? Math.floor((Date.now() - this.streamStartTime) / 1000)
      : 0;

    return {
      streaming: state.streaming,
      recording: state.recording,
      uptime,
      profile: this.profile ? {
        server: this.profile.serverName,
        bitrate: this.profile.bitrate,
        encoder: this.profile.encoder,
        resolution: this.profile.resolution,
        fps: this.profile.fps
      } : null
    };
  }

  /**
   * Get available Chaturbate RTMP servers.
   * @returns {Object} Server map
   */
  getServers() {
    return { ...CHATURBATE_SERVERS };
  }

  /**
   * Register an event handler.
   * @param {string} event - Event name
   * @param {Function} handler - Handler function
   */
  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
  }

  /**
   * Remove an event handler.
   * @param {string} event - Event name
   * @param {Function} handler - Handler to remove
   */
  off(event, handler) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      const idx = handlers.indexOf(handler);
      if (idx !== -1) handlers.splice(idx, 1);
    }
  }

  // ─────────────────────────────────────────────
  // PRIVATE
  // ─────────────────────────────────────────────

  _emit(event, data) {
    const handlers = this.eventHandlers.get(event) || [];
    for (const handler of handlers) {
      try {
        handler(data);
      } catch (err) {
        console.error(`[Stream Service] Error in ${event} handler:`, err);
      }
    }
  }

  _handleSignal(signal) {
    console.log(`[Stream Service] OBS Signal: ${signal.type} - ${signal.signal}`);

    if (signal.type === 'streaming') {
      switch (signal.signal) {
        case 'stop':
          this._stopHealthMonitor();
          this._emit('streamStop', { reason: 'obs_signal' });
          break;
        case 'reconnect':
          this._emit('streamReconnect', { time: new Date().toISOString() });
          break;
      }
    }
  }

  _startHealthMonitor() {
    this._stopHealthMonitor();
    this.healthInterval = setInterval(() => {
      const status = this.getStatus();
      this._emit('streamHealth', status);
    }, 5000); // Check every 5 seconds
  }

  _stopHealthMonitor() {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }
}

const streamService = new StreamService();
module.exports = streamService;
