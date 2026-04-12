/**
 * Apex Revenue — Audio Mixer
 * Per-source volume controls, muting, and level monitoring
 */

const { EventEmitter } = require('events');

class AudioMixer extends EventEmitter {
  constructor() {
    super();
    this.devices = new Map();
    this.levels = new Map();
    this._monitorInterval = null;
  }

  init() {
    // Default audio devices
    this.devices.set('desktop-audio', {
      id: 'desktop-audio',
      name: 'Desktop Audio',
      type: 'output',
      volume: 1.0,
      muted: false,
      monitorType: 'none', // 'none' | 'monitor_only' | 'monitor_and_output'
      filters: [],
    });

    this.devices.set('mic-audio', {
      id: 'mic-audio',
      name: 'Mic/Aux',
      type: 'input',
      volume: 1.0,
      muted: false,
      monitorType: 'none',
      filters: [],
    });

    // Start level monitoring
    this._startMonitoring();
  }

  getDevices() {
    return Array.from(this.devices.values());
  }

  addDevice(config) {
    const device = {
      id: config.id || `audio-${Date.now()}`,
      name: config.name || 'Audio Source',
      type: config.type || 'input',
      volume: config.volume ?? 1.0,
      muted: false,
      monitorType: 'none',
      filters: [],
    };
    this.devices.set(device.id, device);
    this.emit('change');
    return device;
  }

  removeDevice(deviceId) {
    this.devices.delete(deviceId);
    this.emit('change');
  }

  setVolume(deviceId, volume) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.volume = Math.max(0, Math.min(1, volume));
      this.emit('change');
    }
  }

  setMuted(deviceId, muted) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.muted = muted;
      this.emit('change');
    }
  }

  toggleMute(deviceId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.muted = !device.muted;
      this.emit('change');
    }
    return device?.muted;
  }

  setMonitorType(deviceId, monitorType) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.monitorType = monitorType;
      this.emit('change');
    }
  }

  addFilter(deviceId, filter) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.filters.push({
        id: `filter-${Date.now()}`,
        type: filter.type, // 'noise_gate' | 'noise_suppression' | 'gain' | 'compressor' | 'limiter' | 'eq'
        enabled: true,
        settings: filter.settings || {},
        ...filter,
      });
      this.emit('change');
    }
  }

  removeFilter(deviceId, filterId) {
    const device = this.devices.get(deviceId);
    if (device) {
      device.filters = device.filters.filter((f) => f.id !== filterId);
      this.emit('change');
    }
  }

  getLevels() {
    // Return simulated audio levels (in production, this would read from FFmpeg/Web Audio API)
    const result = {};
    this.devices.forEach((device, id) => {
      if (device.muted) {
        result[id] = { left: -Infinity, right: -Infinity, peak: -Infinity };
      } else {
        // Simulated levels for UI — real implementation would use system audio APIs
        result[id] = {
          left: -60 + Math.random() * 50 * device.volume,
          right: -60 + Math.random() * 50 * device.volume,
          peak: -60 + Math.random() * 55 * device.volume,
        };
      }
    });
    return result;
  }

  _startMonitoring() {
    this._monitorInterval = setInterval(() => {
      this.emit('levels', this.getLevels());
    }, 100); // 10fps level updates
  }

  cleanup() {
    if (this._monitorInterval) clearInterval(this._monitorInterval);
  }
}

module.exports = new AudioMixer();
