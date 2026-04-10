// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — App Renderer v3.0
// AWS auto-configured. Sidebar with all platform categories.
// ═══════════════════════════════════════════════════════════════════════════════

'use strict';

// ── State ─────────────────────────────────────────────────────────────────────
let liveData     = null;
let sessionStart = Date.now();
let peakViewers  = 0;
let avgTipSize   = 0;
let largestTip   = 0;
let currentUser  = null;
let awsActive    = false;
let cwHeartbeats = 0;
let backupCount  = 0;

const $ = id => document.getElementById(id);

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  bindTitlebar();
  bindSidebar();
  bindUrlBar();
  bindTabs();
  bindAuth();

  // Restore last URL into URL bar
  const lastUrl = await window.electronAPI.store.get('selectedUrl');
  if (lastUrl) $('url-bar').value = lastUrl;

  // Live data
  window.electronAPI.onLiveUpdate(handleLiveUpdate);
  window.electronAPI.onPlatformDetected(p => {
    $('sum-platform').textContent = p.charAt(0).toUpperCase() + p.slice(1);
  });
  window.electronAPI.onUrlChanged(url => { $('url-bar').value = url; });
  window.electronAPI.onTitleChanged(() => {});

  // AWS events — silent, just update status strip
  window.electronAPI.onAwsStatus(({ active }) => {
    awsActive = active;
    updateAwsStrip();
    if (active) $('aws-badge').classList.add('active');
  });
  window.electronAPI.onAiPrompt(showAiPrompt);
  window.electronAPI.onPollyAudio(playPollyAudio);
  window.electronAPI.onBackupDone(() => {
    backupCount++;
    $('aws-s3-label').textContent = `S3 ✓ (${backupCount})`;
    $('aws-s3-status').classList.add('flash');
    setTimeout(() => $('aws-s3-status').classList.remove('flash'), 800);
  });
  window.electronAPI.onCwHeartbeat?.(() => {
    cwHeartbeats++;
    $('aws-cw-label').textContent = `CW ✓ (${cwHeartbeats})`;
  }) || window.electronAPI.removeAllListeners('aws:cw-heartbeat');

  checkAuth();
  setInterval(updateTimer, 1000);
}

// ── Titlebar ──────────────────────────────────────────────────────────────────
function bindTitlebar() {
  $('wc-min').addEventListener('click', () => window.electronAPI.window.minimize());
  $('wc-max').addEventListener('click', () => window.electronAPI.window.maximize());
  $('wc-cls').addEventListener('click', () => window.electronAPI.window.close());
  $('btn-backup').addEventListener('click', async () => {
    const r = await window.electronAPI.aws.s3Backup(liveData);
    showToast(r.ok ? '✅ Session backed up to S3' : `❌ Backup: ${r.error || r.reason}`);
  });
}

// ── Sidebar ───────────────────────────────────────────────────────────────────
function bindSidebar() {
  // Collapsible categories
  document.querySelectorAll('.sb-cat-header').forEach(header => {
    header.addEventListener('click', () => {
      const cat   = header.closest('.sb-category');
      const items = cat.querySelector('.sb-cat-items');
      const chevron = header.querySelector('.sb-cat-chevron');
      const collapsed = cat.classList.toggle('collapsed');
      items.style.display  = collapsed ? 'none' : '';
      chevron.textContent  = collapsed ? '▸' : '▾';
    });
  });

  // Platform navigation
  document.querySelectorAll('.sb-item').forEach(item => {
    item.addEventListener('click', () => {
      const url = item.dataset.url;
      if (!url) return;
      document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
      item.classList.add('active');
      window.electronAPI.navigate(url);
      $('url-bar').value = url;
    });
  });

  // Sidebar search filter
  $('sb-search').addEventListener('input', e => {
    const q = e.target.value.toLowerCase().trim();
    document.querySelectorAll('.sb-category').forEach(cat => {
      let anyVisible = false;
      cat.querySelectorAll('.sb-item').forEach(item => {
        const name = item.querySelector('.sb-item-name').textContent.toLowerCase();
        const show = !q || name.includes(q);
        item.style.display = show ? '' : 'none';
        if (show) anyVisible = true;
      });
      // Show/hide the whole category based on matches
      cat.style.display = anyVisible ? '' : 'none';
      // Re-open collapsed categories when searching
      if (q && anyVisible) {
        cat.classList.remove('collapsed');
        cat.querySelector('.sb-cat-items').style.display = '';
        cat.querySelector('.sb-cat-chevron').textContent = '▾';
      }
    });
  });
}

// ── URL bar (drives the BrowserView directly) ─────────────────────────────────
function bindUrlBar() {
  $('url-bar').addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    let url = $('url-bar').value.trim();
    if (!url) return;
    if (!url.startsWith('http')) url = 'https://' + url;
    window.electronAPI.navigate(url);
    // Deselect any sidebar item when navigating by URL
    document.querySelectorAll('.sb-item').forEach(i => i.classList.remove('active'));
  });
  $('btn-back')  .addEventListener('click', () => window.electronAPI.camBack());
  $('btn-fwd')   .addEventListener('click', () => window.electronAPI.camForward());
  $('btn-reload').addEventListener('click', () => window.electronAPI.camReload());
  $('url-bar').addEventListener('focus', async () => {
    const url = await window.electronAPI.camCurrentUrl();
    if (url) $('url-bar').value = url;
  });
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function bindTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn') .forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      $(`tab-${btn.dataset.tab}`).classList.add('active');
    });
  });
  $('btn-dismiss-prompt').addEventListener('click', () => $('prompt-banner').classList.add('hidden'));
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function bindAuth() {
  $('btn-signin-panel') .addEventListener('click', () => showModal('modal-signin'));
  $('btn-modal-close')  .addEventListener('click', () => hideModal('modal-signin'));
  $('btn-signin-submit').addEventListener('click', doSignIn);
  $('input-password')   .addEventListener('keydown', e => { if (e.key === 'Enter') doSignIn(); });
  $('link-signup')      .addEventListener('click', () => window.electronAPI.openExternal('https://apexrevenue.works/signup.html'));
  $('link-forgot')      .addEventListener('click', () => window.electronAPI.openExternal('https://apexrevenue.works/'));
  $('footer-upgrade')   .addEventListener('click', () => window.electronAPI.openExternal('https://apexrevenue.works/'));
}

async function doSignIn() {
  const email = $('input-email').value.trim();
  const pass  = $('input-password').value;
  const errEl = $('signin-error');
  const btn   = $('btn-signin-submit');
  if (!email || !pass) { showError(errEl, 'Please enter email and password.'); return; }
  btn.disabled = true; btn.textContent = 'Signing in…'; errEl.classList.add('hidden');
  try {
    await apexSignIn(email, pass);
    hideModal('modal-signin');
    checkAuth();
  } catch(e) {
    showError(errEl, e.message || 'Sign in failed.');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

async function checkAuth() {
  try {
    const session = await apexGetValidSession();
    if (session) {
      currentUser = await apexGetUser();
      $('auth-notice').classList.add('hidden');
      $('footer-user').textContent = currentUser?.email || 'Signed in';
      $('live-label').textContent = 'LIVE';
      $('live-dot').classList.add('pulse');
      window.electronAPI.setUsername(currentUser?.email || 'unknown');
    } else {
      $('auth-notice').classList.remove('hidden');
      $('footer-user').textContent = 'Not signed in';
    }
  } catch {}
}

// ── AWS status strip ──────────────────────────────────────────────────────────
function updateAwsStrip() {
  if (!awsActive) return;
  $('aws-s3-label').textContent = 'S3 ready';
  $('aws-cw-label').textContent = 'CW live';
  $('aws-fh-label').textContent = 'FH ready';
  document.querySelectorAll('.aws-strip-item').forEach(el => el.classList.add('online'));
}

// ── Live data ─────────────────────────────────────────────────────────────────
function handleLiveUpdate(data) {
  liveData = data;
  $('stat-tph')    .textContent = fmt(data.tokensPerHour || 0);
  $('stat-viewers').textContent = fmt(data.viewers || 0);
  $('stat-conv')   .innerHTML   = (data.convRate || '0.0') + '<span>%</span>';

  peakViewers = Math.max(peakViewers, data.viewers || 0);
  const tips = data.tipEvents || [];
  if (tips.length) {
    const amounts = tips.map(t => t.amount);
    avgTipSize = Math.round(amounts.reduce((a, b) => a + b, 0) / amounts.length);
    largestTip = Math.max(...amounts);
  }

  $('sum-tokens') .textContent = fmt(data.totalTips || 0);
  $('sum-tippers').textContent = (data.fans || []).filter(f => f.tips > 0).length;
  $('sum-peak')   .textContent = fmt(peakViewers);
  $('sum-avg')    .textContent = avgTipSize + ' tkn';
  $('sum-largest').textContent = largestTip + ' tkn';

  renderWhales(data.whales || []);
  renderFans((data.fans || []).slice(0, 20));
  renderTipFeed(data.tipEvents || []);

  $('live-label').textContent = 'LIVE';
  $('live-dot').classList.add('pulse');

  // Mark sidebar item active
  try {
    const current = data.platform;
    document.querySelectorAll('.sb-item').forEach(item => {
      const url = item.dataset.url || '';
      item.classList.toggle('active', current && url.includes(current));
    });
  } catch {}
}

function renderWhales(whales) {
  const list = $('whale-list');
  $('whale-count').textContent = whales.length;
  if (!whales.length) { list.innerHTML = '<div class="empty-state">Waiting for high-value tippers…</div>'; return; }
  list.innerHTML = whales.slice(0, 5).map((w, i) => `
    <div class="fan-row whale-row">
      <span class="fan-rank">${i+1}</span><span class="fan-tier">🐋</span>
      <span class="fan-name">${esc(w.username)}</span>
      <span class="fan-tips">${fmt(w.tips)} tkn</span>
    </div>`).join('');
}

function renderFans(fans) {
  const list    = $('fan-list');
  const tippers = fans.filter(f => f.tips > 0);
  $('fan-count').textContent = tippers.length;
  if (!tippers.length) { list.innerHTML = '<div class="empty-state">Fan data accumulating…</div>'; return; }
  list.innerHTML = tippers.slice(0, 20).map((f, i) => `
    <div class="fan-row">
      <span class="fan-rank">#${i+1}</span><span class="fan-tier">${tierEmoji(f.tier)}</span>
      <span class="fan-name">${esc(f.username)}</span>
      <span class="fan-tips">${fmt(f.tips)}</span>
    </div>`).join('');
}

function renderTipFeed(events) {
  const feed   = $('tip-feed');
  const recent = [...events].sort((a, b) => b.timestamp - a.timestamp).slice(0, 20);
  if (!recent.length) { feed.innerHTML = '<div class="empty-state">No tips recorded yet…</div>'; return; }
  feed.innerHTML = recent.map(ev => `
    <div class="tip-event${ev.amount >= 200 ? ' big-tip' : ''}">
      <span class="tip-user">${esc(ev.username)}</span>
      <span class="tip-amount">+${ev.amount}</span>
      <span class="tip-time">${timeAgo(ev.timestamp)}</span>
    </div>`).join('');
}

// ── Bedrock AI prompt banner ──────────────────────────────────────────────────
function showAiPrompt({ prompt, fallback }) {
  if (!prompt) return;
  $('ai-prompt-text').textContent = prompt;
  const badge = $('ai-badge');
  badge.textContent = fallback ? 'LOCAL AI' : 'BEDROCK AI';
  badge.className   = `ai-badge ${fallback ? 'local' : 'bedrock'}`;
  $('prompt-banner').classList.remove('hidden');
}

// ── Polly audio playback ──────────────────────────────────────────────────────
function playPollyAudio({ audio }) {
  if (!audio) return;
  const el = $('polly-audio');
  el.src = `data:audio/mp3;base64,${audio}`;
  el.play().catch(() => {});
}

// ── Session timer ─────────────────────────────────────────────────────────────
function updateTimer() {
  const e = Date.now() - sessionStart;
  const h = Math.floor(e / 3600000);
  const m = Math.floor((e % 3600000) / 60000);
  const s = Math.floor((e % 60000) / 1000);
  $('session-timer').textContent =
    `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function fmt(n)       { n = parseInt(n, 10) || 0; return n >= 1000 ? (n/1000).toFixed(1) + 'k' : String(n); }
function tierEmoji(t) { return t===1?'🐋':t===2?'🔥':t===3?'💎':'👤'; }
function esc(s)       { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function timeAgo(ts)  { const d=Math.floor((Date.now()-ts)/1000); return d<60?d+'s':d<3600?Math.floor(d/60)+'m':Math.floor(d/3600)+'h'; }
function showModal(id) { $(id).classList.remove('hidden'); }
function hideModal(id) { $(id).classList.add('hidden'); }
function showError(el, m) { el.textContent = m; el.classList.remove('hidden'); }

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  requestAnimationFrame(() => { t.classList.add('show'); });
  setTimeout(() => { t.classList.remove('show'); setTimeout(() => t.remove(), 300); }, 3000);
}

document.addEventListener('DOMContentLoaded', init);
