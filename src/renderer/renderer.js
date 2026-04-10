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

document.addEventListener('DOMContentLoaded', async () => {
  initializeEventListeners();
  loadSettings();
  startUptimeCounter();
  checkAuthStatus();
  renderIntelligencePage('live');
  setupStreamHealthUpdates();
});

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
    } else {
      showAlert('Failed to initialize OBS: ' + result.error, 'error');
    }
  } catch (error) {
    console.error('OBS init error:', error);
    showAlert('Error initializing OBS', 'error');
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
  dom.goLiveBtn.textContent = 'Stopping...';
  dom.goLiveBtn.disabled = true;

  try {
    const streamKey = dom.streamKey.value || 'test-key';
    const result = await window.apex.stream.startStream(streamKey);

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
}

// ════════════════════════════════════════════════════════════════════════════
// AUTHENTICATION
// ════════════════════════════════════════════════════════════════════════════

async function checkAuthStatus() {
  try {
    const session = await window.apex.auth.getSession();
    if (session && session.user) {
      state.user = session.user;
      state.isAuthenticated = true;
      updateAccountWidget();
    }
  } catch (error) {
    console.error('Error checking auth status:', error);
  }
}

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
    updateAccountWidget();
    showAlert('Logged out', 'info');
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

// Listen for auth state changes
if (window.apex?.auth) {
  window.apex.auth.onAuthChange?.((user) => {
    if (user) {
      state.user = user;
      state.isAuthenticated = true;
    } else {
      state.user = null;
      state.isAuthenticated = false;
    }
    updateAccountWidget();
  });
}
