/**
 * Apex Revenue Desktop - Renderer Process
 * Integrated with Creator Intelligence
 *
 * Handles UI interactions, OBS management, auth, intelligence panel,
 * and communication with the main process via window.apex bridge.
 */

// ════════════════════════════════════════════════════════════════════════════
// STATE
// ════════════════════════════════════════════════════════════════════════════

const state = {
  // OBS & Streaming
  obsInitialized: false,
  streaming: false,
  recording: false,
  streamStartTime: null,
  sources: [],

  // Intelligence Panel
  currentIntelPage: 'live',
  liveData: {
    earningsPerHour: 0,
    viewers: 0,
    conversionRate: 0,
    whales: [],
    prompts: [],
    heatMap: [],
    priceRecommendation: 0
  },
  fanLeaderboard: [],
  selectedFanFilter: 'all',

  // Auth
  user: null,
  isAuthenticated: false,

  // Sensations
  sensations: {},

  // Uptime
  uptimeInterval: null,
  uptime: 0
};

// ════════════════════════════════════════════════════════════════════════════
// DOM REFERENCES
// ════════════════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const dom = {
  // Header
  statusDot: $('statusDot'),
  statusText: $('statusText'),
  uptimeDisplay: $('uptimeDisplay'),
  accountWidget: $('accountWidget'),
  showLoginBtn: $('showLoginBtn'),

  // Stream controls
  initOBSBtn: $('initOBSBtn'),
  goLiveBtn: $('goLiveBtn'),
  recordBtn: $('recordBtn'),

  // Intelligence panel
  intelContent: $('intelContent'),
  intelNavBtns: document.querySelectorAll('.intel-nav-btn'),
  alertBanner: $('alertBanner'),
  alertText: $('alertText'),
  alertClose: document.querySelector('.alert-close'),

  // Stream settings
  streamKey: $('streamKey'),
  streamServer: $('streamServer'),
  bitrate: $('bitrate'),
  fps: $('fps'),

  // Sources
  sourcesList: $('sourcesList'),
  addSourceBtn: $('addSourceBtn'),

  // Recording
  recordingPath: $('recordingPath'),
  recordingFormat: $('recordingFormat'),
  selectPathBtn: $('selectPathBtn'),
  saveSettingsBtn: $('saveSettingsBtn'),

  // Settings tabs
  settingsTabs: document.querySelectorAll('.settings-tab'),
  settingsSections: document.querySelectorAll('.settings-section'),

  // Footer health stats
  statBitrate: $('statBitrate'),
  statFPS: $('statFPS'),
  statDropped: $('statDropped'),
  statUptime: $('statUptime'),

  // Auth modal
  authModal: $('authModal'),
  closeAuthModal: $('closeAuthModal'),
  authTabs: document.querySelectorAll('.auth-tab'),
  loginForm: $('loginForm'),
  signupForm: $('signupForm'),
  loginEmail: $('loginEmail'),
  loginPassword: $('loginPassword'),
  signupEmail: $('signupEmail'),
  signupPassword: $('signupPassword'),
  signupConfirm: $('signupConfirm'),
  loginError: $('loginError'),
  signupError: $('signupError'),

  // Platform modal
  platformModal: $('platformModal'),
  closePlatformModal: $('closePlatformModal'),
  chaturbateUsername: $('chaturbateUsername'),
  stripchatUsername: $('stripchatUsername')
};

// ════════════════════════════════════════════════════════════════════════════
// INITIALIZATION
// ════════════════════════════════════════════════════════════════════════════

// ════════════════════════════════════════════════════════════════════════════
// AUTH GATE — DOM REFERENCES
// ════════════════════════════════════════════════════════════════════════════

const gate = {
  overlay: $('authGate'),
  appRoot: $('app'),
  loginForm: $('gateLoginForm'),
  signupForm: $('gateSignupForm'),
  loginEmail: $('gateLoginEmail'),
  loginPassword: $('gateLoginPassword'),
  loginError: $('gateLoginError'),
  loginBtn: $('gateLoginBtn'),
  signupEmail: $('gateSignupEmail'),
  signupPassword: $('gateSignupPassword'),
  signupConfirm: $('gateSignupConfirm'),
  signupError: $('gateSignupError'),
  signupBtn: $('gateSignupBtn'),
  tabs: document.querySelectorAll('.auth-gate-tab')
};

document.addEventListener('DOMContentLoaded', async () => {
  initializeGateListeners();
  await checkAuthGate();
});

// ════════════════════════════════════════════════════════════════════════════
// AUTH GATE LOGIC
// ════════════════════════════════════════════════════════════════════════════

function initializeGateListeners() {
  // Tab switching
  gate.tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      gate.tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.gateTab === 'login';
      gate.loginForm.classList.toggle('active', isLogin);
      gate.signupForm.classList.toggle('active', !isLogin);
    });
  });

  // Login form
  gate.loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    gate.loginError.textContent = '';
    gate.loginBtn.disabled = true;
    gate.loginBtn.textContent = 'Signing in...';
    console.log('[Gate] Login form submitted');

    try {
      const result = await window.apex.auth.login(
        gate.loginEmail.value.trim(),
        gate.loginPassword.value
      );
      console.log('[Gate] Login result:', result?.success, result?.error);
      if (result && result.success) {
        state.user = result.user;
        state.isAuthenticated = true;
        unlockDashboard();
      } else {
        gate.loginError.textContent = (result && result.error) || 'Invalid email or password';
      }
    } catch (err) {
      console.error('[Gate] Login error:', err);
      gate.loginError.textContent = 'Connection error. Please try again.';
    } finally {
      gate.loginBtn.disabled = false;
      gate.loginBtn.textContent = 'Sign In';
    }
  });

  // Signup form
  gate.signupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    gate.signupError.textContent = '';

    const email = gate.signupEmail.value.trim();
    const password = gate.signupPassword.value;
    const confirm = gate.signupConfirm.value;

    if (password.length < 8) {
      gate.signupError.textContent = 'Password must be at least 8 characters';
      return;
    }
    if (password !== confirm) {
      gate.signupError.textContent = 'Passwords do not match';
      return;
    }

    gate.signupBtn.disabled = true;
    gate.signupBtn.textContent = 'Creating account...';

    try {
      const result = await window.apex.auth.signup(email, password);
      if (result.success) {
        if (result.needsVerification) {
          // Show verification code input
          showVerificationStep(email, password);
        } else {
          // Auto-confirmed (unlikely but handle it) — sign in directly
          const loginResult = await window.apex.auth.login(email, password);
          if (loginResult.success) {
            state.user = loginResult.user;
            state.isAuthenticated = true;
            unlockDashboard();
          }
        }
      } else {
        gate.signupError.textContent = result.error || 'Signup failed';
      }
    } catch (err) {
      gate.signupError.textContent = 'Connection error. Please try again.';
    } finally {
      gate.signupBtn.disabled = false;
      gate.signupBtn.textContent = 'Create Account';
    }
  });
}

function showVerificationStep(email, password) {
  // Replace the signup form content with a verification code input
  const formContent = gate.signupForm.querySelector('.auth-gate-form-inner') || gate.signupForm;
  const originalHTML = formContent.innerHTML;

  formContent.innerHTML = `
    <div class="auth-gate-verify">
      <h3 style="color:#e01020;margin:0 0 8px;">Check your email</h3>
      <p style="color:#aaa;font-size:13px;margin:0 0 16px;">
        We sent a verification code to <strong style="color:#fff;">${email}</strong>
      </p>
      <input type="text" id="gateVerifyCode" placeholder="Enter verification code"
        class="auth-gate-input" autocomplete="one-time-code" style="text-align:center;letter-spacing:4px;font-size:18px;" />
      <div id="gateVerifyError" class="auth-gate-error"></div>
      <button type="button" id="gateVerifyBtn" class="auth-gate-btn">Verify & Sign In</button>
      <button type="button" id="gateBackToSignup" class="auth-gate-link" style="margin-top:8px;background:none;border:none;color:#888;cursor:pointer;font-size:12px;">
        Back to sign up
      </button>
    </div>
  `;

  const codeInput = document.getElementById('gateVerifyCode');
  const verifyBtn = document.getElementById('gateVerifyBtn');
  const verifyError = document.getElementById('gateVerifyError');
  const backBtn = document.getElementById('gateBackToSignup');

  codeInput.focus();

  verifyBtn.addEventListener('click', async () => {
    const code = codeInput.value.trim();
    if (!code) { verifyError.textContent = 'Please enter the verification code'; return; }

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying...';
    verifyError.textContent = '';

    try {
      const confirmResult = await window.apex.auth.confirmSignup(email, code);
      if (confirmResult.success) {
        // Now sign in with the verified account
        verifyBtn.textContent = 'Signing in...';
        const loginResult = await window.apex.auth.login(email, password);
        if (loginResult.success) {
          state.user = loginResult.user;
          state.isAuthenticated = true;
          unlockDashboard();
        } else {
          verifyError.textContent = loginResult.error || 'Sign in failed after verification';
          verifyBtn.disabled = false;
          verifyBtn.textContent = 'Verify & Sign In';
        }
      } else {
        verifyError.textContent = confirmResult.error || 'Invalid code';
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Sign In';
      }
    } catch (err) {
      verifyError.textContent = 'Connection error. Please try again.';
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify & Sign In';
    }
  });

  backBtn.addEventListener('click', () => {
    formContent.innerHTML = originalHTML;
  });
}

async function checkAuthGate() {
  try {
    const session = await window.apex.auth.getSession();
    if (session && session.isAuthenticated && session.user) {
      state.user = session.user;
      state.isAuthenticated = true;
      unlockDashboard();

      // Refresh linked accounts from server (stored list may be stale)
      try {
        const accounts = await window.apex.auth.getLinkedAccounts();
        if (state.user) {
          state.user.linkedPlatforms = accounts;
        }
      } catch (e) {
        console.warn('Failed to refresh linked accounts:', e);
      }
    }
    // else: gate stays visible, user must log in
  } catch (err) {
    console.error('Auth gate check failed:', err);
    // Gate stays visible on error
  }
}

function unlockDashboard() {
  // Hide the gate, show the app
  gate.overlay.classList.add('hidden');
  gate.appRoot.classList.remove('app-hidden');

  // Now initialize the actual dashboard
  initializeEventListeners();
  loadSettings();
  startUptimeCounter();
  updateAccountWidget();
  renderIntelligencePage('live');
  setupStreamHealthUpdates();
}

function lockDashboard() {
  // Show the gate, hide the app
  gate.overlay.classList.remove('hidden');
  gate.appRoot.classList.add('app-hidden');

  // Reset gate forms
  gate.loginForm.reset();
  gate.signupForm.reset();
  gate.loginError.textContent = '';
  gate.signupError.textContent = '';
}

function initializeEventListeners() {
  // Stream controls
  dom.initOBSBtn.addEventListener('click', initializeOBS);
  dom.goLiveBtn.addEventListener('click', toggleLiveStream);
  dom.recordBtn.addEventListener('click', toggleRecording);

  // Intelligence panel navigation
  dom.intelNavBtns.forEach(btn => {
    btn.addEventListener('click', () => switchIntelPage(btn.dataset.page));
  });

  // Alert banner close
  if (dom.alertClose) {
    dom.alertClose.addEventListener('click', hideAlertBanner);
  }

  // Settings tabs
  dom.settingsTabs.forEach(tab => {
    tab.addEventListener('click', () => switchSettingsTab(tab.dataset.tab));
  });

  // Settings actions
  dom.saveSettingsBtn.addEventListener('click', saveStreamSettings);
  dom.selectPathBtn.addEventListener('click', selectRecordingPath);

  // Auth
  dom.showLoginBtn.addEventListener('click', showAuthModal);
  dom.closeAuthModal.addEventListener('click', hideAuthModal);
  dom.authTabs.forEach(tab => {
    tab.addEventListener('click', () => switchAuthTab(tab.dataset.authTab));
  });
  dom.loginForm.addEventListener('submit', handleLogin);
  dom.signupForm.addEventListener('submit', handleSignup);

  // Platform linking
  dom.closePlatformModal.addEventListener('click', hidePlatformModal);
  document.querySelectorAll('.link-btn').forEach(btn => {
    btn.addEventListener('click', () => linkPlatformAccount(btn.dataset.platform));
  });

  // Video overlay
  initializeOverlayListeners();
}

// ════════════════════════════════════════════════════════════════════════════
// VIDEO OVERLAY
// ════════════════════════════════════════════════════════════════════════════

const overlay = {
  video: null,
  controls: null,
  filePath: null,
  playing: false
};

function initializeOverlayListeners() {
  overlay.video = document.getElementById('videoOverlay');
  overlay.controls = document.getElementById('overlayControls');

  // Settings panel — choose video file
  const selectBtn = document.getElementById('selectOverlayBtn');
  const clearBtn = document.getElementById('clearOverlayBtn');
  const fileInfo = document.getElementById('overlayFileInfo');
  const fileName = document.getElementById('overlayFileName');
  const advanced = document.getElementById('overlayAdvanced');

  // Settings panel controls (synced with hover controls)
  const opacitySetting = document.getElementById('overlayOpacitySetting');
  const opacityValue = document.getElementById('overlayOpacityValue');
  const sizeSetting = document.getElementById('overlaySizeSetting');
  const positionSetting = document.getElementById('overlayPositionSetting');
  const mutedCheckbox = document.getElementById('overlayMuted');
  const playBtn = document.getElementById('overlayPlayBtn');
  const pauseBtn = document.getElementById('overlayPauseBtn');

  // Hover controls on preview
  const hoverPlayPause = document.getElementById('overlayPlayPause');
  const hoverOpacity = document.getElementById('overlayOpacity');
  const hoverOpacityLabel = document.getElementById('overlayOpacityLabel');
  const hoverSize = document.getElementById('overlaySize');
  const hoverPosition = document.getElementById('overlayPosition');
  const hoverRemove = document.getElementById('overlayRemove');

  // Select video file
  if (selectBtn) {
    selectBtn.addEventListener('click', async () => {
      const filePath = await window.apex.dialog.selectFile([
        { name: 'Video Files', extensions: ['mp4', 'webm', 'mkv', 'avi', 'mov', 'ogv'] },
        { name: 'All Files', extensions: ['*'] }
      ]);
      if (!filePath) return;

      overlay.filePath = filePath;
      const name = filePath.split(/[\\/]/).pop();
      fileName.textContent = name;
      fileInfo.classList.remove('hidden');
      advanced.classList.remove('hidden');

      // Load the video
      overlay.video.src = 'file://' + filePath;
      overlay.video.classList.add('active');
      overlay.controls.classList.remove('hidden');
      overlay.video.play().then(() => {
        overlay.playing = true;
        if (hoverPlayPause) hoverPlayPause.textContent = '⏸';
      }).catch(() => {});
    });
  }

  // Clear overlay
  function removeOverlay() {
    overlay.video.pause();
    overlay.video.removeAttribute('src');
    overlay.video.load();
    overlay.video.classList.remove('active');
    overlay.video.className = 'video-overlay';
    overlay.video.style.opacity = '';
    overlay.controls.classList.add('hidden');
    overlay.filePath = null;
    overlay.playing = false;
    fileInfo.classList.add('hidden');
    advanced.classList.add('hidden');
    if (opacitySetting) { opacitySetting.value = 100; opacityValue.textContent = '100%'; }
    if (hoverOpacity) { hoverOpacity.value = 100; hoverOpacityLabel.textContent = '100%'; }
    if (sizeSetting) sizeSetting.value = 'full';
    if (positionSetting) positionSetting.value = 'center';
    if (hoverSize) hoverSize.value = 'full';
    if (hoverPosition) hoverPosition.value = 'center';
  }

  if (clearBtn) clearBtn.addEventListener('click', removeOverlay);
  if (hoverRemove) hoverRemove.addEventListener('click', removeOverlay);

  // Apply size class
  function applyOverlaySize(size) {
    overlay.video.classList.remove('size-75', 'size-50', 'size-25', 'size-pip');
    if (size !== 'full') overlay.video.classList.add('size-' + size);
    // When not full, apply position
    applyOverlayPosition(positionSetting ? positionSetting.value : 'center');
  }

  // Apply position class
  function applyOverlayPosition(pos) {
    overlay.video.classList.remove('pos-center', 'pos-top-left', 'pos-top-right', 'pos-bottom-left', 'pos-bottom-right');
    const currentSize = sizeSetting ? sizeSetting.value : 'full';
    if (currentSize !== 'full') {
      overlay.video.classList.add('pos-' + pos);
    }
  }

  // Opacity handler (sync both controls)
  function setOpacity(val) {
    overlay.video.style.opacity = val / 100;
    if (opacitySetting) opacitySetting.value = val;
    if (opacityValue) opacityValue.textContent = val + '%';
    if (hoverOpacity) hoverOpacity.value = val;
    if (hoverOpacityLabel) hoverOpacityLabel.textContent = val + '%';
  }

  if (opacitySetting) opacitySetting.addEventListener('input', (e) => setOpacity(e.target.value));
  if (hoverOpacity) hoverOpacity.addEventListener('input', (e) => setOpacity(e.target.value));

  // Size handler (sync both)
  function setSize(val) {
    if (sizeSetting) sizeSetting.value = val;
    if (hoverSize) hoverSize.value = val;
    applyOverlaySize(val);
  }

  if (sizeSetting) sizeSetting.addEventListener('change', (e) => setSize(e.target.value));
  if (hoverSize) hoverSize.addEventListener('change', (e) => setSize(e.target.value));

  // Position handler (sync both)
  function setPosition(val) {
    if (positionSetting) positionSetting.value = val;
    if (hoverPosition) hoverPosition.value = val;
    applyOverlayPosition(val);
  }

  if (positionSetting) positionSetting.addEventListener('change', (e) => setPosition(e.target.value));
  if (hoverPosition) hoverPosition.addEventListener('change', (e) => setPosition(e.target.value));

  // Muted toggle
  if (mutedCheckbox) {
    mutedCheckbox.addEventListener('change', () => {
      overlay.video.muted = mutedCheckbox.checked;
    });
  }

  // Play / Pause (settings panel)
  if (playBtn) {
    playBtn.addEventListener('click', () => {
      if (overlay.filePath) {
        overlay.video.play();
        overlay.playing = true;
        if (hoverPlayPause) hoverPlayPause.textContent = '⏸';
      }
    });
  }

  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => {
      overlay.video.pause();
      overlay.playing = false;
      if (hoverPlayPause) hoverPlayPause.textContent = '▶';
    });
  }

  // Hover play/pause toggle
  if (hoverPlayPause) {
    hoverPlayPause.addEventListener('click', () => {
      if (overlay.playing) {
        overlay.video.pause();
        overlay.playing = false;
        hoverPlayPause.textContent = '▶';
      } else {
        overlay.video.play();
        overlay.playing = true;
        hoverPlayPause.textContent = '⏸';
      }
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// OBS FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

async function initializeOBS() {
  dom.initOBSBtn.textContent = 'Initializing...';
  dom.initOBSBtn.disabled = true;

  try {
    const result = await window.apex.obs.initialize();
    if (result.success) {
      state.obsInitialized = true;
      dom.initOBSBtn.textContent = 'OBS Ready';
      dom.initOBSBtn.disabled = true;
      dom.goLiveBtn.disabled = false;
      dom.recordBtn.disabled = false;
      updateStatus('Ready', 'ready');
      loadDevices();

      // Create the OBS preview and hide the placeholder
      try {
        await window.apex.obs.createPreview();
        const previewEl = document.getElementById('obsPreview');
        if (previewEl) {
          const placeholder = previewEl.querySelector('.preview-placeholder');
          if (placeholder) placeholder.style.display = 'none';
          previewEl.classList.add('preview-active');
        }
        console.log('[OBS] Preview created successfully');
      } catch (previewErr) {
        console.warn('[OBS] Preview creation failed:', previewErr);
        // Non-fatal — stream still works without preview
      }
    } else {
      showAlert('Failed to initialize OBS: ' + (result.error || 'Unknown error'), 'error');
      dom.initOBSBtn.textContent = 'Initialize OBS';
      dom.initOBSBtn.disabled = false;
    }
  } catch (error) {
    console.error('OBS init error:', error);
    showAlert('Error initializing OBS: ' + (error.message || error), 'error');
    dom.initOBSBtn.textContent = 'Initialize OBS';
    dom.initOBSBtn.disabled = false;
  }
}

async function toggleLiveStream() {
  if (!state.obsInitialized) {
    showAlert('Initialize OBS first', 'error');
    return;
  }

  if (state.streaming) {
    await stopStream();
  } else {
    await startStream();
  }
}

async function startStream() {
  dom.goLiveBtn.textContent = 'Starting...';
  dom.goLiveBtn.disabled = true;

  try {
    const streamKey = dom.streamKey.value || '';
    const rtmpUrl = dom.streamServer.value || '';

    // ── Username validation ──────────────────────────────────────────
    if (!state.user) {
      showAlert('You must be logged in to stream', 'error');
      dom.goLiveBtn.disabled = false;
      dom.goLiveBtn.textContent = 'Go Live';
      return;
    }

    const linkedPlatforms = state.user.linkedPlatforms || [];
    if (linkedPlatforms.length === 0) {
      showAlert('Link a platform account in Settings before streaming. This ensures your earnings data stays secure.', 'error');
      dom.goLiveBtn.disabled = false;
      dom.goLiveBtn.textContent = 'Go Live';
      return;
    }

    // Validate stream key is provided
    if (!streamKey.trim()) {
      showAlert('Enter your broadcast token / stream key in the Stream settings tab', 'error');
      dom.goLiveBtn.disabled = false;
      dom.goLiveBtn.textContent = 'Go Live';
      return;
    }

    // Validate RTMP URL is provided
    if (!rtmpUrl.trim()) {
      showAlert('Enter your RTMP URL in the Stream settings tab', 'error');
      dom.goLiveBtn.disabled = false;
      dom.goLiveBtn.textContent = 'Go Live';
      return;
    }

    console.log('[Stream] Starting with RTMP URL:', rtmpUrl, 'Key length:', streamKey.length);
    const result = await window.apex.stream.startStream(streamKey, rtmpUrl);

    if (result.success) {
      state.streaming = true;
      state.streamStartTime = Date.now();
      dom.goLiveBtn.textContent = 'Stop Stream';
      dom.goLiveBtn.classList.add('live');
      dom.recordBtn.disabled = false;
      updateStatus('LIVE', 'live');
      showAlert('Stream started successfully', 'success');
    } else {
      showAlert('Failed to start stream: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Stream start error:', error);
    showAlert('Error starting stream', 'error');
  } finally {
    dom.goLiveBtn.disabled = false;
  }
}

async function stopStream() {
  dom.goLiveBtn.textContent = 'Stopping...';
  dom.goLiveBtn.disabled = true;

  try {
    const result = await window.apex.stream.stopStream();

    if (result.success) {
      state.streaming = false;
      dom.goLiveBtn.textContent = 'Go Live';
      dom.goLiveBtn.classList.remove('live');
      dom.recordBtn.disabled = true;
      updateStatus('Ready', 'ready');
      showAlert('Stream stopped', 'info');
    } else {
      showAlert('Failed to stop stream: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Stream stop error:', error);
    showAlert('Error stopping stream', 'error');
  } finally {
    dom.goLiveBtn.disabled = false;
  }
}

async function toggleRecording() {
  if (!state.streaming) {
    showAlert('Start streaming first', 'error');
    return;
  }

  if (state.recording) {
    await stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    const result = await window.apex.recording.start();
    if (result.success) {
      state.recording = true;
      dom.recordBtn.textContent = 'Stop Recording';
      dom.recordBtn.classList.add('recording');
      showAlert('Recording started', 'success');
    } else {
      showAlert('Failed to start recording: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Recording start error:', error);
    showAlert('Error starting recording', 'error');
  }
}

async function stopRecording() {
  try {
    const result = await window.apex.recording.stop();
    if (result.success) {
      state.recording = false;
      dom.recordBtn.textContent = 'Record';
      dom.recordBtn.classList.remove('recording');
      showAlert('Recording stopped', 'success');
    } else {
      showAlert('Failed to stop recording: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('Recording stop error:', error);
    showAlert('Error stopping recording', 'error');
  }
}

async function loadDevices() {
  try {
    const devices = await window.apex.obs.getDevices();
    if (devices) {
      updateDeviceSelectors(devices);
    }
  } catch (error) {
    console.error('Error loading devices:', error);
  }
}

function updateDeviceSelectors(devices) {
  // This would populate the device selectors if they existed in new UI
  // For now, devices are handled in main process
}

// ════════════════════════════════════════════════════════════════════════════
// SETTINGS MANAGEMENT
// ════════════════════════════════════════════════════════════════════════════

function loadSettings() {
  try {
    const settings = window.apex.settings.load();
    if (settings) {
      dom.streamKey.value = settings.streamKey || '';
      dom.streamServer.value = settings.streamServer || '';
      dom.bitrate.value = settings.bitrate || 6;
      dom.fps.value = settings.fps || 30;
      dom.recordingPath.value = settings.recordingPath || '';
      dom.recordingFormat.value = settings.recordingFormat || 'mp4';
    }
  } catch (error) {
    console.error('Error loading settings:', error);
  }
}

async function saveStreamSettings() {
  try {
    const settings = {
      streamKey: dom.streamKey.value,
      streamServer: dom.streamServer.value,
      bitrate: parseFloat(dom.bitrate.value),
      fps: parseInt(dom.fps.value),
      recordingPath: dom.recordingPath.value,
      recordingFormat: dom.recordingFormat.value
    };

    window.apex.settings.save(settings);
    showAlert('Settings saved successfully', 'success');
  } catch (error) {
    console.error('Error saving settings:', error);
    showAlert('Error saving settings', 'error');
  }
}

async function selectRecordingPath() {
  try {
    const result = await window.apex.dialog.selectDirectory();
    if (result.path) {
      dom.recordingPath.value = result.path;
    }
  } catch (error) {
    console.error('Error selecting path:', error);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// INTELLIGENCE PANEL FUNCTIONS
// ════════════════════════════════════════════════════════════════════════════

function switchIntelPage(page) {
  state.currentIntelPage = page;
  dom.intelNavBtns.forEach(btn => btn.classList.remove('active'));
  document.querySelector(`[data-page="${page}"]`).classList.add('active');
  renderIntelligencePage(page);
}

function renderIntelligencePage(page) {
  let html = '';

  switch (page) {
    case 'live':
      html = renderLivePage();
      break;
    case 'fans':
      html = renderFansPage();
      break;
    case 'analytics':
      html = renderAnalyticsPage();
      break;
    case 'settings':
      html = renderSettingsPage();
      break;
    case 'sensations':
      html = renderSensationsPage();
      break;
    case 'help':
      html = renderHelpPage();
      break;
  }

  dom.intelContent.innerHTML = html;
  attachIntelPageEventListeners(page);
}

function renderLivePage() {
  const { earningsPerHour, viewers, conversionRate, whales, prompts, heatMap, priceRecommendation } = state.liveData;

  let html = `
    <div class="stats-row">
      <div class="stat-card">
        <div class="stat-label">Earnings/hr</div>
        <div class="stat-value">$${earningsPerHour.toFixed(0)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Viewers</div>
        <div class="stat-value">${viewers}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Conv %</div>
        <div class="stat-value">${(conversionRate * 100).toFixed(1)}%</div>
      </div>
    </div>
  `;

  // Whale Tracker
  if (whales && whales.length > 0) {
    html += `
      <div class="whale-tracker">
        <div class="whale-tracker-title">Top Spenders</div>
        <table class="whale-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Spent</th>
            </tr>
          </thead>
          <tbody>
            ${whales.slice(0, 5).map(whale => `
              <tr>
                <td>${whale.username}</td>
                <td>$${whale.spent.toFixed(0)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  // Monetization Prompts
  if (prompts && prompts.length > 0) {
    html += `
      <div class="prompts-container">
        ${prompts.slice(0, 3).map(prompt => `
          <div class="prompt-card">
            <div class="prompt-title">${prompt.title}</div>
            <div class="prompt-message">${prompt.message}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // Viewer Engagement Heat
  if (heatMap && heatMap.length > 0) {
    html += `
      <div class="heat-bars">
        ${heatMap.slice(0, 4).map(heat => `
          <div class="heat-bar-item">
            <div class="heat-bar-label">${heat.label}</div>
            <div class="heat-bar">
              <div class="heat-bar-fill" style="width: ${heat.value * 100}%"></div>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  }

  // AI Price Recommendation
  html += `
    <div class="pricing-card">
      <div class="pricing-title">AI Price Rec.</div>
      <div class="pricing-value">$${priceRecommendation.toFixed(0)}</div>
    </div>
  `;

  return html;
}

function renderFansPage() {
  const filters = ['all', 'gold', 'silver', 'bronze', 'left'];
  let html = `
    <div class="fan-filters">
      ${filters.map(filter => `
        <button class="filter-chip ${state.selectedFanFilter === filter ? 'active' : ''}" data-filter="${filter}">
          ${filter.charAt(0).toUpperCase() + filter.slice(1)}
        </button>
      `).join('')}
    </div>
    <div class="fan-list">
  `;

  const filteredFans = state.selectedFanFilter === 'all'
    ? state.fanLeaderboard
    : state.fanLeaderboard.filter(f => f.tier === state.selectedFanFilter);

  if (filteredFans.length === 0) {
    html += '<p class="placeholder-text">No fans in this tier</p>';
  } else {
    html += filteredFans.slice(0, 20).map((fan, idx) => `
      <div class="fan-item">
        <div class="fan-rank">${idx + 1}</div>
        <div class="fan-info">
          <div class="fan-name">${fan.username}</div>
          <div class="fan-spent">$${fan.totalSpent.toFixed(0)}</div>
        </div>
      </div>
    `).join('');
  }

  html += '</div>';
  return html;
}

function renderAnalyticsPage() {
  return `
    <div class="placeholder-text">
      <p>Analytics dashboard coming soon</p>
      <p style="font-size: 10px; margin-top: 8px; color: var(--text-muted);">
        Detailed performance metrics and charts will be available here.
      </p>
    </div>
  `;
}

function renderSettingsPage() {
  const platforms = state.user?.linkedPlatforms || [];

  return `
    <div class="settings-form">
      <div class="settings-form-group">
        <label>Email</label>
        <input type="text" value="${state.user?.email || ''}" disabled>
      </div>

      <div class="settings-form-group">
        <label>Username</label>
        <input type="text" value="${state.user?.username || ''}" disabled>
      </div>

      <h4 style="margin-top: 12px; margin-bottom: 8px; color: var(--text-secondary); font-size: 11px;">Linked Platforms</h4>
      <div class="platform-list">
        ${platforms.length === 0
          ? '<p class="placeholder-text">No platforms linked</p>'
          : platforms.map(p => `
            <div class="platform-item">
              <div>
                <div class="platform-name">${p.platform}</div>
                <div class="platform-username">${p.username}</div>
              </div>
              <button class="unlink-btn" data-platform="${p.platform}">Unlink</button>
            </div>
          `).join('')
        }
      </div>

      <button class="add-btn" id="linkPlatformBtn">+ Link Platform</button>
    </div>
  `;
}

function renderHelpPage() {
  return `
    <div class="placeholder-text">
      <h4 style="color: var(--text-primary); margin-bottom: 8px;">Help & Documentation</h4>
      <p>Getting started with Apex Revenue</p>
      <ul style="text-align: left; font-size: 10px; margin-top: 10px; line-height: 1.6; color: var(--text-secondary);">
        <li>Initialize OBS in the center panel</li>
        <li>Configure stream settings in the right sidebar</li>
        <li>View live earnings and stats on this panel</li>
        <li>Manage fan relationships in the Fans tab</li>
        <li>Link your platform accounts in Settings</li>
      </ul>
    </div>
  `;
}

// ────────────────────────────────────────────────────
// SENSATIONS PAGE
// ────────────────────────────────────────────────────

function renderSensationsPage() {
  const s = state.sensations || {};
  const tiers = s.tiers || [];
  const connected = s.connected || false;
  const arProgress = s.arProgress || 0;
  const arCount = s.arCount || 0;
  const arTokens = s.arTokens || 200;
  const arPercent = arTokens > 0 ? Math.min(100, Math.round((arProgress / arTokens) * 100)) : 0;
  const goalProgress = s.goalProgress || 0;
  const goalTokens = s.goalTokens || 1000;
  const goalEnabled = s.goalEnabled || false;
  const goalPercent = goalTokens > 0 ? Math.min(100, Math.round((goalProgress / goalTokens) * 100)) : 0;
  const sessionTokens = s.sessionTokens || 0;
  const leaderboard = s.leaderboard || [];
  const queueLength = s.queueLength || 0;
  const processing = s.processing || false;
  const comboBonus = s.comboBonus || false;

  let tierCardsHtml = tiers.map((t, i) => `
    <div class="sens-tier-card" data-tier="${t.id}">
      <div class="sens-tier-header">
        <span class="sens-tier-emoji">${t.emoji || ''}</span>
        <span class="sens-tier-label">${t.label}</span>
      </div>
      <div class="sens-tier-detail">
        <span>${t.min}–${t.max === 999999 ? '∞' : t.max} tkns</span>
        <span>Lv ${t.vibe} • ${t.secs}s</span>
      </div>
    </div>
  `).join('');

  let leaderboardHtml = leaderboard.length === 0
    ? '<div class="sens-empty">No tips yet this session</div>'
    : leaderboard.slice(0, 5).map((entry, i) => `
      <div class="sens-lb-row">
        <span class="sens-lb-rank">${i === 0 ? '👑' : i + 1}</span>
        <span class="sens-lb-name">${entry.user || entry.username}</span>
        <span class="sens-lb-amount">${entry.total || entry.amount} tkns</span>
      </div>
    `).join('');

  return `
    <div class="sensations-page">
      <!-- Connection Status -->
      <div class="sens-status ${connected ? 'sens-connected' : 'sens-disconnected'}">
        <span class="sens-status-dot"></span>
        <span>${connected ? 'Toy Connected' : 'Toy Disconnected'}</span>
        <button class="sens-toggle-btn" id="sensToggleConnect">${connected ? 'Disconnect' : 'Connect'}</button>
      </div>

      <!-- Session Stats Row -->
      <div class="sens-stats-row">
        <div class="sens-stat">
          <div class="sens-stat-value">${sessionTokens}</div>
          <div class="sens-stat-label">Session Tokens</div>
        </div>
        <div class="sens-stat">
          <div class="sens-stat-value">${queueLength}</div>
          <div class="sens-stat-label">Queue${processing ? ' ▶' : ''}</div>
        </div>
        <div class="sens-stat">
          <div class="sens-stat-value">${arCount}</div>
          <div class="sens-stat-label">Goals Hit</div>
        </div>
      </div>

      <!-- Auto-Reset Goal -->
      <div class="sens-section">
        <div class="sens-section-title">Auto-Reset Goal</div>
        <div class="sens-progress-bar">
          <div class="sens-progress-fill" style="width: ${arPercent}%"></div>
        </div>
        <div class="sens-progress-label">${arProgress} / ${arTokens} tokens (${arPercent}%)</div>
      </div>

      ${goalEnabled ? `
      <!-- Session Goal -->
      <div class="sens-section">
        <div class="sens-section-title">Session Goal</div>
        <div class="sens-progress-bar">
          <div class="sens-progress-fill sens-goal-fill" style="width: ${goalPercent}%"></div>
        </div>
        <div class="sens-progress-label">${goalProgress} / ${goalTokens} tokens</div>
      </div>
      ` : ''}

      <!-- Vibration Tiers -->
      <div class="sens-section">
        <div class="sens-section-title">Vibration Tiers</div>
        <div class="sens-tier-grid">${tierCardsHtml || '<div class="sens-empty">Configure tiers in settings</div>'}</div>
      </div>

      <!-- Leaderboard -->
      <div class="sens-section">
        <div class="sens-section-title">Top Tippers</div>
        <div class="sens-leaderboard">${leaderboardHtml}</div>
      </div>

      <!-- Actions -->
      <div class="sens-actions">
        <button class="sens-action-btn" id="sensResetSession">Reset Session</button>
      </div>
    </div>
  `;
}

async function loadSensationsState() {
  if (!window.apex?.sensations) return;
  try {
    const [stateData, tiers, settings, queue] = await Promise.all([
      window.apex.sensations.getState(),
      window.apex.sensations.getTiers(),
      window.apex.sensations.getSettings(),
      window.apex.sensations.getQueue()
    ]);
    if (stateData) {
      state.sensations = {
        ...stateData,
        tiers: tiers || [],
        arTokens: settings?.ar_tokens || 200,
        goalTokens: settings?.goal_tokens || 1000,
        goalEnabled: settings?.enable_goal === 'yes',
        comboBonus: settings?.combo_bonus === 'yes',
        queueLength: queue?.length || 0,
      };
    }
  } catch (err) {
    console.warn('Failed to load sensations state:', err);
  }
}

function attachIntelPageEventListeners(page) {
  if (page === 'fans') {
    document.querySelectorAll('.filter-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        state.selectedFanFilter = chip.dataset.filter;
        renderIntelligencePage('fans');
      });
    });
  }

  if (page === 'settings') {
    const linkBtn = document.getElementById('linkPlatformBtn');
    if (linkBtn) {
      linkBtn.addEventListener('click', showPlatformModal);
    }

    document.querySelectorAll('.unlink-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        unlinkPlatformAccount(btn.dataset.platform);
      });
    });
  }

  if (page === 'sensations') {
    loadSensationsState().then(() => {
      if (state.currentIntelPage === 'sensations') {
        dom.intelContent.innerHTML = renderSensationsPage();
        // Re-attach after re-render
        attachSensationsListeners();
      }
    });
    attachSensationsListeners();
  }
}

function attachSensationsListeners() {
  const toggleBtn = document.getElementById('sensToggleConnect');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', async () => {
      const connected = state.sensations?.connected || false;
      await window.apex.sensations.setConnected(!connected);
      state.sensations = { ...state.sensations, connected: !connected };
      renderIntelligencePage('sensations');
    });
  }

  const resetBtn = document.getElementById('sensResetSession');
  if (resetBtn) {
    resetBtn.addEventListener('click', async () => {
      await window.apex.sensations.resetSession();
      await loadSensationsState();
      renderIntelligencePage('sensations');
    });
  }
}

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ════════════════════════════════════════════════════════════════════════════

// checkAuthStatus is now handled by checkAuthGate() at startup

function updateAccountWidget() {
  if (state.isAuthenticated && state.user) {
    dom.accountWidget.innerHTML = `
      <div class="account-info">
        <div class="account-email">${state.user.email}</div>
        <button class="logout-btn" id="logoutBtn">Logout</button>
      </div>
    `;
    document.getElementById('logoutBtn').addEventListener('click', handleLogout);
  } else {
    dom.accountWidget.innerHTML = '<button class="login-btn" id="showLoginBtn">Login</button>';
    dom.showLoginBtn.addEventListener('click', showAuthModal);
  }
}

function showAuthModal() {
  dom.authModal.classList.add('active');
}

function hideAuthModal() {
  dom.authModal.classList.remove('active');
  dom.loginForm.reset();
  dom.signupForm.reset();
}

function switchAuthTab(tab) {
  dom.authTabs.forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-auth-tab="${tab}"]`).classList.add('active');

  dom.loginForm.classList.toggle('active', tab === 'login');
  dom.signupForm.classList.toggle('active', tab === 'signup');
}

async function handleLogin(e) {
  e.preventDefault();
  const email = dom.loginEmail.value;
  const password = dom.loginPassword.value;

  if (!email || !password) {
    dom.loginError.textContent = 'Please fill in all fields';
    return;
  }

  try {
    const result = await window.apex.auth.login(email, password);
    if (result.success) {
      state.user = result.user;
      state.isAuthenticated = true;
      hideAuthModal();
      updateAccountWidget();
      showAlert('Logged in successfully', 'success');
    } else {
      dom.loginError.textContent = result.error || 'Login failed';
    }
  } catch (error) {
    dom.loginError.textContent = 'Login error: ' + error.message;
  }
}

async function handleSignup(e) {
  e.preventDefault();
  const email = dom.signupEmail.value;
  const password = dom.signupPassword.value;
  const confirm = dom.signupConfirm.value;

  if (!email || !password || !confirm) {
    dom.signupError.textContent = 'Please fill in all fields';
    return;
  }

  if (password !== confirm) {
    dom.signupError.textContent = 'Passwords do not match';
    return;
  }

  try {
    const result = await window.apex.auth.signup(email, password);
    if (result.success) {
      state.user = result.user;
      state.isAuthenticated = true;
      hideAuthModal();
      updateAccountWidget();
      showAlert('Account created successfully', 'success');
    } else {
      dom.signupError.textContent = result.error || 'Signup failed';
    }
  } catch (error) {
    dom.signupError.textContent = 'Signup error: ' + error.message;
  }
}

async function handleLogout() {
  try {
    await window.apex.auth.logout();
    state.user = null;
    state.isAuthenticated = false;
    lockDashboard();
  } catch (error) {
    console.error('Logout error:', error);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// PLATFORM LINKING
// ════════════════════════════════════════════════════════════════════════════

function showPlatformModal() {
  dom.platformModal.classList.remove('hidden');
}

function hidePlatformModal() {
  dom.platformModal.classList.add('hidden');
  dom.chaturbateUsername.value = '';
  dom.stripchatUsername.value = '';
}

async function linkPlatformAccount(platform) {
  const username = platform === 'chaturbate'
    ? dom.chaturbateUsername.value
    : dom.stripchatUsername.value;

  if (!username) {
    showAlert(`Please enter ${platform} username`, 'error');
    return;
  }

  try {
    const result = await window.apex.auth.linkPlatform(platform, username);
    if (result.success) {
      showAlert(`${platform} linked successfully`, 'success');
      if (state.user) {
        state.user.linkedPlatforms = result.platforms;
      }
      renderIntelligencePage('settings');
      hidePlatformModal();
    } else {
      showAlert(result.error || 'Failed to link platform', 'error');
    }
  } catch (error) {
    showAlert('Error linking platform: ' + error.message, 'error');
  }
}

async function unlinkPlatformAccount(platform) {
  try {
    const result = await window.apex.auth.unlinkPlatform(platform);
    if (result.success) {
      showAlert(`${platform} unlinked`, 'success');
      if (state.user) {
        state.user.linkedPlatforms = result.platforms;
      }
      renderIntelligencePage('settings');
    } else {
      showAlert('Failed to unlink platform', 'error');
    }
  } catch (error) {
    showAlert('Error unlinking platform: ' + error.message, 'error');
  }
}

// ════════════════════════════════════════════════════════════════════════════
// UI UTILITIES
// ════════════════════════════════════════════════════════════════════════════

function switchSettingsTab(tab) {
  dom.settingsTabs.forEach(t => t.classList.remove('active'));
  dom.settingsSections.forEach(s => s.classList.remove('active'));

  document.querySelector(`[data-tab="${tab}"]`).classList.add('active');
  document.getElementById(tab + 'Settings').classList.add('active');
}

function updateStatus(text, status) {
  dom.statusText.textContent = text;
  dom.statusDot.className = 'status-dot';
  if (status === 'live') {
    dom.statusDot.classList.add('live');
  } else if (status === 'ready') {
    dom.statusDot.classList.add('ready');
  }
}

function showAlert(message, type = 'info') {
  dom.alertText.textContent = message;
  dom.alertBanner.classList.remove('alert-hidden');

  // Auto-hide after 4 seconds
  setTimeout(() => {
    dom.alertBanner.classList.add('alert-hidden');
  }, 4000);
}

function hideAlertBanner() {
  dom.alertBanner.classList.add('alert-hidden');
}

function startUptimeCounter() {
  state.uptimeInterval = setInterval(() => {
    state.uptime++;
    const hours = Math.floor(state.uptime / 3600);
    const minutes = Math.floor((state.uptime % 3600) / 60);
    const seconds = state.uptime % 60;

    const formatted = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    dom.uptimeDisplay.textContent = formatted;
    dom.statUptime.textContent = formatted;
  }, 1000);
}

function setupStreamHealthUpdates() {
  // Simulate health stats updates
  setInterval(() => {
    if (state.streaming) {
      const bitrate = (Math.random() * 3 + 4).toFixed(1);
      const fps = Math.floor(Math.random() * 10) + 25;
      const dropped = Math.floor(Math.random() * 5);

      dom.statBitrate.textContent = bitrate + ' Mbps';
      dom.statFPS.textContent = fps;
      dom.statDropped.textContent = dropped;
    }
  }, 1000);
}

// ════════════════════════════════════════════════════════════════════════════
// REAL-TIME UPDATES FROM MAIN PROCESS
// ════════════════════════════════════════════════════════════════════════════

// Listen for live data updates
if (window.apex?.intelligence) {
  window.apex.intelligence.onLiveUpdate?.((data) => {
    state.liveData = { ...state.liveData, ...data };
    if (state.currentIntelPage === 'live') {
      renderIntelligencePage('live');
    }
  });

  window.apex.intelligence.onFanUpdate?.((fans) => {
    state.fanLeaderboard = fans;
    if (state.currentIntelPage === 'fans') {
      renderIntelligencePage('fans');
    }
  });

  window.apex.intelligence.onRelayEvent?.((event) => {
    console.log('Relay event:', event);
  });
}

// Listen for sensations real-time events
if (window.apex?.sensations) {
  window.apex.sensations.onQueueUpdate?.((data) => {
    if (state.sensations) {
      state.sensations.queueLength = data.length || 0;
      state.sensations.processing = data.processing || false;
    }
    if (state.currentIntelPage === 'sensations') renderIntelligencePage('sensations');
  });

  window.apex.sensations.onLeaderboardUpdate?.((data) => {
    if (state.sensations) state.sensations.leaderboard = data || [];
    if (state.currentIntelPage === 'sensations') renderIntelligencePage('sensations');
  });

  window.apex.sensations.onGoalReached?.((data) => {
    showAlert(`Goal reached! ${data.description || ''}`, 'success');
    if (state.sensations) {
      state.sensations.arProgress = 0;
      state.sensations.arCount = (state.sensations.arCount || 0) + 1;
    }
    if (state.currentIntelPage === 'sensations') renderIntelligencePage('sensations');
  });

  window.apex.sensations.onAutoReset?.((data) => {
    if (state.sensations) {
      state.sensations.arProgress = data.overflow || 0;
      state.sensations.arCount = data.count || state.sensations.arCount;
    }
    if (state.currentIntelPage === 'sensations') renderIntelligencePage('sensations');
  });

  window.apex.sensations.onComboHit?.((data) => {
    showAlert(`${data.username} combo x${data.count}! ${data.multiplier}x bonus`, 'success');
  });

  window.apex.sensations.onVibrate?.((data) => {
    if (state.sensations) state.sensations.sessionTokens = data.sessionTokens || state.sensations.sessionTokens;
    if (state.currentIntelPage === 'sensations') renderIntelligencePage('sensations');
  });

  window.apex.sensations.onGrandFinale?.(() => {
    showAlert('GRAND FINALE! All goals complete!', 'success');
  });

  window.apex.sensations.onNotice?.((data) => {
    console.log('Sensations notice:', data.message);
  });
}

// Listen for auth state changes (including server-side token revocation)
if (window.apex?.auth) {
  window.apex.auth.onAuthChange?.((user) => {
    if (user) {
      state.user = user;
      state.isAuthenticated = true;
      updateAccountWidget();
    } else {
      state.user = null;
      state.isAuthenticated = false;
      lockDashboard();
    }
  });
}
