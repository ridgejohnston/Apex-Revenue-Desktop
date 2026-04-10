// ═══════════════════════════════════════════════════════════════════════════════
// APEX REVENUE DESKTOP — Cam Platform Preload (content.js adapted for Electron)
// Runs in the BrowserView rendering the cam platform page.
// Scrapes DOM → sends live data to main process → main forwards to app window.
// ═══════════════════════════════════════════════════════════════════════════════

const { ipcRenderer } = require('electron');

// ── State ─────────────────────────────────────────────────────────────────────
const s = {
  viewers: 0,
  fans: {},
  tipEvents: [],
  startTime: Date.now(),
  username: '',
  platform: 'chaturbate'
};

// ── Detect current platform ───────────────────────────────────────────────────
function detectPlatform(url) {
  if (url.includes('chaturbate.com'))  return 'chaturbate';
  if (url.includes('stripchat.com'))   return 'stripchat';
  if (url.includes('myfreecams.com'))  return 'myfreecams';
  if (url.includes('xtease.com'))      return 'xtease';
  return 'chaturbate';
}

s.platform = detectPlatform(window.location.href);
ipcRenderer.send('cam:platform-detected', s.platform);

// ── Fan scoring ───────────────────────────────────────────────────────────────
function sortedFans() {
  return Object.entries(s.fans)
    .map(([name, data]) => ({ username: name, ...data }))
    .sort((a, b) => b.tips !== a.tips ? b.tips - a.tips : (a.tier||9) - (b.tier||9));
}

function totalTips() { return sortedFans().reduce((sum, f) => sum + f.tips, 0); }

function tokensPerHour() {
  const now = Date.now();
  const elapsed = now - s.startTime;
  const eh = elapsed / 3600000;
  if (eh < 0.005) return 0;
  const wm = Math.min(900000, elapsed);
  const wh = wm / 3600000;
  const recent = s.tipEvents
    .filter(ev => now - ev.timestamp <= wm)
    .reduce((acc, ev) => acc + ev.amount, 0);
  return Math.round(recent / wh);
}

function convRate() {
  if (!s.viewers) return '0.0';
  return (Object.values(s.fans).filter(f => f.tips > 0).length / s.viewers * 100).toFixed(1);
}

// ── Broadcast state to main process ──────────────────────────────────────────
function broadcastUpdate() {
  const fans    = sortedFans();
  const whales  = fans.filter(f => f.tier === 1 && f.tips > 0);
  const payload = {
    platform:      s.platform,
    viewers:       s.viewers,
    tokensPerHour: tokensPerHour(),
    convRate:      convRate(),
    totalTips:     totalTips(),
    whales:        whales.length ? whales : fans.filter(f => f.tier === 2 && f.tips > 0),
    fans,
    presentFans:   fans.filter(f => f.present),
    tipEvents:     s.tipEvents.filter(ev => Date.now() - ev.timestamp < 7200000),
    startTime:     s.startTime,
    username:      s.username
  };
  ipcRenderer.send('cam:live-update', payload);
}

// ── Register a tip event ──────────────────────────────────────────────────────
function registerTip(username, amount) {
  if (!username || amount <= 0) return;
  s.tipEvents.push({ username, amount, timestamp: Date.now() });
  if (!s.fans[username]) s.fans[username] = { tips: 0, joins: 0, leaves: 0, present: true, tier: 4 };
  s.fans[username].tips    += amount;
  s.fans[username].present  = true;
  if (s.fans[username].joins === 0) s.fans[username].joins = 1;
  const total = s.fans[username].tips;
  s.fans[username].tier = total >= 200 ? 1 : total >= 50 ? 2 : total >= 10 ? 3 : 4;
  broadcastUpdate();
}

// ═══════════════════════════════════════════════════════════════════════════════
// PLATFORM SCRAPERS
// ═══════════════════════════════════════════════════════════════════════════════

// ── Chaturbate ─────────────────────────────────────────────────────────────────
function scrapeChaturbate() {
  // Username
  try {
    const metaUser = document.querySelector('meta[name="chaturbate-user"]') ||
                     document.querySelector('[data-room]');
    if (metaUser) {
      s.username = metaUser.getAttribute('content') || metaUser.getAttribute('data-room') || s.username;
    }
    // Fallback: title
    if (!s.username) {
      const titleMatch = document.title.match(/^([^\s]+)/);
      if (titleMatch) s.username = titleMatch[1];
    }
  } catch(e) {}

  // Viewer count
  try {
    const vcEl = document.querySelector('#viewer_count, .viewer-count, [data-viewers]');
    if (vcEl) {
      const raw = parseInt(vcEl.textContent.replace(/[^0-9]/g,''), 10);
      if (!isNaN(raw)) s.viewers = raw;
    }
  } catch(e) {}

  // User list (fan presence + tiers)
  try {
    const tabEl = document.querySelector('#UserListTab, .users-list');
    if (tabEl) {
      const items = tabEl.querySelectorAll('[data-testid="username-label"], .username');
      items.forEach(item => {
        const nameEl = item.querySelector('[data-testid="username"]') || item;
        const name   = nameEl.textContent?.trim();
        if (!name) return;
        let tier = 4;
        if (item.classList.contains('tippedTonsRecently'))  tier = 1;
        else if (item.classList.contains('tippedALotRecently')) tier = 2;
        else if (item.classList.contains('hasTokens'))      tier = 3;
        if (!s.fans[name]) s.fans[name] = { tips: 0, joins: 0, leaves: 0, present: true, tier };
        else { s.fans[name].present = true; if (tier < s.fans[name].tier) s.fans[name].tier = tier; }
        if (s.fans[name].joins === 0) s.fans[name].joins = 1;
      });
    }
  } catch(e) {}

  // Chat tip detection
  try {
    const chatLog = document.querySelector('#chat-messages, .chat-messages, #chatScrollableWrapper');
    if (chatLog) {
      const msgs = chatLog.querySelectorAll('.tip-amount, .tipmessage, [data-tip]');
      msgs.forEach(msg => {
        const dataProcessed = msg.getAttribute('data-apex-processed');
        if (dataProcessed) return;
        msg.setAttribute('data-apex-processed', '1');
        const amtMatch = msg.textContent.match(/(\d+)\s*tokens?/i);
        const userEl   = msg.closest('[data-user]') || msg.previousElementSibling;
        const user     = msg.getAttribute('data-user') || userEl?.getAttribute('data-user') || userEl?.textContent?.trim();
        if (amtMatch && user) registerTip(user.split(/\s/)[0], parseInt(amtMatch[1], 10));
      });
    }
  } catch(e) {}
}

// ── Stripchat ─────────────────────────────────────────────────────────────────
function scrapeStripchat() {
  try {
    const vcEl = document.querySelector('[class*="viewersCount"], [class*="viewer-count"]');
    if (vcEl) {
      const raw = parseInt(vcEl.textContent.replace(/[^0-9]/g,''), 10);
      if (!isNaN(raw)) s.viewers = raw;
    }
  } catch(e) {}

  try {
    const tips = document.querySelectorAll('[class*="tip"][class*="message"]:not([data-apex])');
    tips.forEach(el => {
      el.setAttribute('data-apex', '1');
      const amtMatch = el.textContent.match(/(\d+)/);
      const nameMatch = el.textContent.match(/^([^\s]+)/);
      if (amtMatch && nameMatch) registerTip(nameMatch[1], parseInt(amtMatch[1], 10));
    });
  } catch(e) {}
}

// ── MyFreeCams ────────────────────────────────────────────────────────────────
function scrapeMyFreeCams() {
  try {
    const vcEl = document.querySelector('.nc_cnt, [class*="viewerCount"]');
    if (vcEl) {
      const raw = parseInt(vcEl.textContent.replace(/[^0-9]/g,''), 10);
      if (!isNaN(raw)) s.viewers = raw;
    }
  } catch(e) {}
}

// ── Main scrape loop ──────────────────────────────────────────────────────────
function scrape() {
  switch (s.platform) {
    case 'chaturbate':  scrapeChaturbate();  break;
    case 'stripchat':   scrapeStripchat();   break;
    case 'myfreecams':  scrapeMyFreeCams();  break;
    default:            scrapeChaturbate();
  }
  broadcastUpdate();
}

// ── Chaturbate WebSocket tip interception (real-time tips) ────────────────────
// Patches the native WebSocket to intercept tip messages
(function patchWebSocket() {
  const OrigWS = window.WebSocket;
  window.WebSocket = function(url, protocols) {
    const ws = protocols ? new OrigWS(url, protocols) : new OrigWS(url);
    ws.addEventListener('message', function(event) {
      try {
        const raw = typeof event.data === 'string' ? event.data : '';
        if (!raw.includes('tip')) return;
        // Chaturbate tip message format: {"method":"onTipAlert","data":{"from_username":"...","amount":50,...}}
        const parsed = JSON.parse(raw.replace(/^[^{]+/, ''));
        if (parsed?.method === 'onTipAlert' && parsed?.data) {
          const { from_username, amount } = parsed.data;
          if (from_username && amount > 0) registerTip(from_username, parseInt(amount, 10));
        }
      } catch(e) {}
    });
    return ws;
  };
  window.WebSocket.prototype = OrigWS.prototype;
  Object.defineProperty(window.WebSocket, 'CONNECTING', { value: OrigWS.CONNECTING });
  Object.defineProperty(window.WebSocket, 'OPEN',       { value: OrigWS.OPEN });
  Object.defineProperty(window.WebSocket, 'CLOSING',    { value: OrigWS.CLOSING });
  Object.defineProperty(window.WebSocket, 'CLOSED',     { value: OrigWS.CLOSED });
})();

// ── Chat mutation observer (for DOM-based tip messages) ───────────────────────
let chatObserver = null;
function startChatObserver() {
  const target = document.querySelector('#chat-messages, .chat-messages, #chatScrollableWrapper, [class*="chat"]');
  if (!target || chatObserver) return;
  chatObserver = new MutationObserver(() => scrape());
  chatObserver.observe(target, { childList: true, subtree: true });
}

// ── Polling fallback ──────────────────────────────────────────────────────────
setInterval(scrape, 3000);

// Start observer when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { scrape(); setTimeout(startChatObserver, 2000); });
} else {
  scrape();
  setTimeout(startChatObserver, 2000);
}

console.log('[Apex Revenue Desktop] Cam preload injected —', s.platform);
