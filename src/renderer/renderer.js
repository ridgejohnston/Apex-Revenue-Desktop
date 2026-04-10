/**
 * Apex Revenue Desktop - Renderer Process
 *
 * Handles all UI interactions and communicates with the main process
 * via the `window.apex` bridge (exposed by preload.js).
 */

// ─────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────

const state = {
  obsInitialized: false,
  streaming: false,
  recording: false,
  sources: [],
  streamStartTime: null
};

// ─────────────────────────────────────────────
// DOM REFERENCES
// ─────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const dom = {
  // Header
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  uptime: $('uptime'),

  // Controls
  btnInitObs: $('btn-init-obs'),
  btnStream: $('btn-stream'),
  btnRecord: $('btn-record'),

  // Stream settings
  broadcastToken: $('broadcast-token'),
  toggleTokenVis: $('toggle-token-vis'),
  rtmpServer: $('rtmp-server'),
  encoder: $('encoder'),
  bitrate: $('bitrate'),
  preset: $('preset'),
  audioBitrate: $('audio-bitrate'),
  resolution: $('resolution'),
  fps: $('fps'),
  btnApplyStream: $('btn-apply-stream'),

  // Sources
  webcamDevice: $('webcam-device'),
  btnAddWebcam: $('btn-add-webcam'),
  micDevice: $('mic-device'),
  btnAddMic: $('btn-add-mic'),
  desktopAudio: $('desktop-audio'),
  bgImagePath: $('bg-image-path'),
  btnBrowseImage: $('btn-browse-image'),
  btnAddBgImage: $('btn-add-bg-image'),
  bgVideoPath: $('bg-video-path'),
  btnBrowseVideo: $('btn-browse-video'),
  btnAddBgVideo: $('btn-add-bg-video'),
  activeSourcesList: $('active-sources-list'),

  // Recording
  recordingPath: $('recording-path'),
  btnBrowseRecording: $('btn-browse-recording'),
  recordingFormat: $('recording-format'),
  recordingBitrate: $('recording-bitrate'),
  btnApplyRecording: $('btn-apply-recording'),

  // Health
  healthBitrate: $('health-bitrate'),
  healthFps: $('health-fps'),
  healthDropped: $('health-dropped')
};

// ─────────────────────────────────────────────
// TAB NAVIGATION
// ─────────────────────────────────────────────

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));

    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab');
    document.getElementById(targetId).classList.add('active');
  });
});

// ─────────────────────────────────────────────
// INITIALIZATION
// ─────────────────────────────────────────────

dom.btnInitObs.addEventListener('click', async () => {
  dom.btnInitObs.textContent = 'Initializing...';
  dom.btnInitObs.disabled = true;

  try {
    const result = await window.apex.obs.initialize();
    if (result) {
      state.obsInitialized = true;
      dom.btnInitObs.textContent = 'OBS Ready';
      dom.btnStream.disabled = false;
      dom.btnRecord.disabled = false;

      // Create preview
      await window.apex.obs.createPreview();

      // Populate device lists
      await populateDevices();

      // Load saved settings
      await loadSettings();

      updateStatus('ready', 'Ready');
    } else {
      dom.btnInitObs.textContent = 'Init Failed - Retry';
      dom.btnInitObs.disabled = false;
    }
  } catch (err) {
    console.error('OBS init failed:', err);
    dom.btnInitObs.textContent = 'Init Failed - Retry';
    dom.btnInitObs.disabled = false;
  }
});

// ─────────────────────────────────────────────
// STREAMING
// ─────────────────────────────────────────────

dom.btnStream.addEventListener('click', async () => {
  if (state.streaming) {
    dom.btnStream.disabled = true;
    dom.btnStream.textContent = 'Stopping...';
    await window.apex.stream.stop();
  } else {
    // Validate token
    if (!dom.broadcastToken.value.trim()) {
      alert('Please enter your Chaturbate broadcast token in the Stream settings tab.');
      return;
    }

    // Apply stream config before starting
    await applyStreamSettings();

    dom.btnStream.disabled = true;
    dom.btnStream.textContent = 'Starting...';
    await window.apex.stream.start();
  }
});

// Stream state change handler
window.apex.stream.onStateChange((data) => {
  state.streaming = data.streaming;
  updateStreamUI();
});

window.apex.stream.onEvent((data) => {
  console.log('[Stream Event]', data);
  if (data.event === 'stop') {
    state.streaming = false;
    state.streamStartTime = null;
    updateStreamUI();
  } else if (data.event === 'start') {
    state.streaming = true;
    state.streamStartTime = Date.now();
    updateStreamUI();
  }
});

window.apex.stream.onHealth((data) => {
  if (data.profile) {
    dom.healthBitrate.textContent = `Bitrate: ${data.profile.bitrate} kbps`;
    dom.healthFps.textContent = `FPS: ${data.profile.fps}`;
  }
  if (data.uptime > 0) {
    dom.uptime.textContent = formatUptime(data.uptime);
  }
});

// ─────────────────────────────────────────────
// RECORDING
// ─────────────────────────────────────────────

dom.btnRecord.addEventListener('click', async () => {
  if (state.recording) {
    await window.apex.recording.stop();
  } else {
    await window.apex.recording.start();
  }
});

window.apex.recording.onStateChange((data) => {
  state.recording = data.recording;
  updateRecordingUI();
});

// ─────────────────────────────────────────────
// STREAM SETTINGS
// ─────────────────────────────────────────────

dom.btnApplyStream.addEventListener('click', applyStreamSettings);

async function applyStreamSettings() {
  const config = {
    broadcastToken: dom.broadcastToken.value.trim(),
    server: dom.rtmpServer.value,
    bitrate: parseInt(dom.bitrate.value),
    encoder: dom.encoder.value,
    resolution: dom.resolution.value,
    fps: parseInt(dom.fps.value),
    audioBitrate: parseInt(dom.audioBitrate.value),
    preset: dom.preset.value
  };

  try {
    await window.apex.stream.configure(config);
    console.log('[Settings] Stream config applied');
  } catch (err) {
    console.error('[Settings] Failed to apply stream config:', err);
    alert('Failed to apply stream settings: ' + err.message);
  }
}

// Token visibility toggle
dom.toggleTokenVis.addEventListener('click', () => {
  const isPassword = dom.broadcastToken.type === 'password';
  dom.broadcastToken.type = isPassword ? 'text' : 'password';
  dom.toggleTokenVis.textContent = isPassword ? 'Hide' : 'Show';
});

// ─────────────────────────────────────────────
// SOURCE MANAGEMENT
// ─────────────────────────────────────────────

async function populateDevices() {
  try {
    const webcams = await window.apex.obs.getWebcamDevices();
    dom.webcamDevice.innerHTML = '<option value="">-- Select Webcam --</option>';
    webcams.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      dom.webcamDevice.appendChild(opt);
    });

    const mics = await window.apex.obs.getAudioInputDevices();
    dom.micDevice.innerHTML = '<option value="">-- Select Microphone --</option>';
    mics.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.id;
      opt.textContent = d.name;
      dom.micDevice.appendChild(opt);
    });
  } catch (err) {
    console.error('[Devices] Failed to enumerate:', err);
  }
}

dom.btnAddWebcam.addEventListener('click', async () => {
  const deviceId = dom.webcamDevice.value;
  if (!deviceId) return alert('Please select a webcam first.');

  await window.apex.obs.addWebcam('webcam-main', { deviceId });
  addSourceToList('webcam-main', 'Webcam');
});

dom.btnAddMic.addEventListener('click', async () => {
  const deviceId = dom.micDevice.value;
  if (!deviceId) return alert('Please select a microphone first.');

  await window.apex.obs.addAudio('mic-main', { type: 'microphone', deviceId });
  addSourceToList('mic-main', 'Microphone');
});

dom.desktopAudio.addEventListener('change', async (e) => {
  if (e.target.checked) {
    await window.apex.obs.addAudio('desktop-audio', { type: 'desktop' });
    addSourceToList('desktop-audio', 'Desktop Audio');
  } else {
    await window.apex.obs.removeSource('desktop-audio');
    removeSourceFromList('desktop-audio');
  }
});

// Image/Video browse
dom.btnBrowseImage.addEventListener('click', async () => {
  const file = await window.apex.dialog.selectFile([
    { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp'] }
  ]);
  if (file) dom.bgImagePath.value = file;
});

dom.btnBrowseVideo.addEventListener('click', async () => {
  const file = await window.apex.dialog.selectFile([
    { name: 'Videos', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov'] }
  ]);
  if (file) dom.bgVideoPath.value = file;
});

dom.btnAddBgImage.addEventListener('click', async () => {
  const file = dom.bgImagePath.value;
  if (!file) return alert('Please select an image file first.');

  await window.apex.obs.addImage('bg-image', { file, position: { x: 0, y: 0 } });
  addSourceToList('bg-image', 'Background Image');
});

dom.btnAddBgVideo.addEventListener('click', async () => {
  const file = dom.bgVideoPath.value;
  if (!file) return alert('Please select a video file first.');

  await window.apex.obs.addVideo('bg-video', { file, looping: true, position: { x: 0, y: 0 } });
  addSourceToList('bg-video', 'Background Video');
});

// Recording folder
dom.btnBrowseRecording.addEventListener('click', async () => {
  const folder = await window.apex.dialog.selectFolder();
  if (folder) dom.recordingPath.value = folder;
});

dom.btnApplyRecording.addEventListener('click', async () => {
  const settings = {
    outputPath: dom.recordingPath.value,
    format: dom.recordingFormat.value,
    bitrate: parseInt(dom.recordingBitrate.value)
  };

  await window.apex.recording.configure(settings);
  console.log('[Settings] Recording config applied');
});

// ─────────────────────────────────────────────
// SOURCES LIST UI
// ─────────────────────────────────────────────

function addSourceToList(name, type) {
  // Remove empty state
  const empty = dom.activeSourcesList.querySelector('.empty-state');
  if (empty) empty.remove();

  // Don't add duplicate
  if (document.getElementById(`source-${name}`)) return;

  const item = document.createElement('div');
  item.className = 'source-item';
  item.id = `source-${name}`;
  item.innerHTML = `
    <div>
      <span class="source-name">${name}</span>
      <span class="source-type">${type}</span>
    </div>
    <div class="source-actions">
      <button class="btn-icon" title="Toggle visibility" data-action="toggle" data-source="${name}">&#128065;</button>
      <button class="btn-icon" title="Remove" data-action="remove" data-source="${name}">&times;</button>
    </div>
  `;

  item.querySelector('[data-action="toggle"]').addEventListener('click', async (e) => {
    const src = e.currentTarget.dataset.source;
    const visible = e.currentTarget.textContent === '\u{1F441}';
    await window.apex.obs.setSourceVisible(src, !visible);
    e.currentTarget.textContent = visible ? '\u{1F441}\u{200D}\u{1F5E8}' : '\u{1F441}';
  });

  item.querySelector('[data-action="remove"]').addEventListener('click', async (e) => {
    const src = e.currentTarget.dataset.source;
    await window.apex.obs.removeSource(src);
    removeSourceFromList(src);
  });

  dom.activeSourcesList.appendChild(item);
  state.sources.push(name);
}

function removeSourceFromList(name) {
  const item = document.getElementById(`source-${name}`);
  if (item) item.remove();

  state.sources = state.sources.filter(s => s !== name);

  if (state.sources.length === 0) {
    dom.activeSourcesList.innerHTML = '<p class="empty-state">No sources added yet</p>';
  }
}

// ─────────────────────────────────────────────
// UI UPDATES
// ─────────────────────────────────────────────

function updateStatus(status, text) {
  dom.statusDot.className = 'status-dot ' + status;
  dom.statusText.textContent = text;
}

function updateStreamUI() {
  if (state.streaming) {
    dom.btnStream.textContent = 'Stop Stream';
    dom.btnStream.classList.add('live');
    dom.btnStream.disabled = false;
    updateStatus('live', 'LIVE');
  } else {
    dom.btnStream.textContent = 'Go Live';
    dom.btnStream.classList.remove('live');
    dom.btnStream.disabled = !state.obsInitialized;
    dom.uptime.textContent = '';
    if (state.obsInitialized) {
      updateStatus('ready', 'Ready');
    } else {
      updateStatus('offline', 'Offline');
    }
  }
}

function updateRecordingUI() {
  if (state.recording) {
    dom.btnRecord.textContent = 'Stop Recording';
    dom.btnRecord.classList.add('recording');
  } else {
    dom.btnRecord.textContent = 'Record';
    dom.btnRecord.classList.remove('recording');
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────
// LOAD SAVED SETTINGS
// ─────────────────────────────────────────────

async function loadSettings() {
  try {
    const allSettings = await window.apex.settings.get();

    if (allSettings.stream) {
      const s = allSettings.stream;
      if (s.broadcastToken) dom.broadcastToken.value = s.broadcastToken;
      if (s.server) dom.rtmpServer.value = s.server;
      if (s.encoder) dom.encoder.value = s.encoder;
      if (s.bitrate) dom.bitrate.value = s.bitrate;
      if (s.preset) dom.preset.value = s.preset;
      if (s.audioBitrate) dom.audioBitrate.value = s.audioBitrate;
      if (s.resolution) dom.resolution.value = s.resolution;
      if (s.fps) dom.fps.value = s.fps;
    }

    if (allSettings.recording) {
      const r = allSettings.recording;
      if (r.outputPath) dom.recordingPath.value = r.outputPath;
      if (r.format) dom.recordingFormat.value = r.format;
      if (r.bitrate) dom.recordingBitrate.value = r.bitrate;
    }
  } catch (err) {
    console.error('[Settings] Failed to load:', err);
  }
}

// ─────────────────────────────────────────────
// UPTIME TICKER
// ─────────────────────────────────────────────

setInterval(async () => {
  if (state.streaming) {
    try {
      const status = await window.apex.stream.getStatus();
      if (status.uptime > 0) {
        dom.uptime.textContent = formatUptime(status.uptime);
      }
    } catch (e) { /* ignore */ }
  }
}, 1000);
