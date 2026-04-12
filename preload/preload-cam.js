/**
 * Apex Revenue — Preload (BrowserView / Cam Site)
 * WebSocket interception + DOM scraping for live tip/viewer data
 */

const { ipcRenderer } = require('electron');

// ─── Platform Detection ─────────────────────────────────
function detectPlatform(url) {
  if (/chaturbate\.com/i.test(url)) return 'chaturbate';
  if (/stripchat\.com/i.test(url)) return 'stripchat';
  if (/myfreecams\.com/i.test(url)) return 'myfreecams';
  if (/xtease\.com/i.test(url)) return 'xtease';
  if (/camsoda\.com/i.test(url)) return 'camsoda';
  return null;
}

// ─── State ──────────────────────────────────────────────
let currentPlatform = null;
let viewers = 0;
let pendingTips = [];
let fanMap = new Map(); // username → { total, tier, lastSeen }

// ─── WebSocket Interception ─────────────────────────────
const OriginalWebSocket = window.WebSocket;

window.WebSocket = function (url, protocols) {
  const ws = protocols
    ? new OriginalWebSocket(url, protocols)
    : new OriginalWebSocket(url);

  ws.addEventListener('message', (event) => {
    try {
      parseTipFromWS(event.data);
    } catch {}
  });

  return ws;
};

// Copy static properties
Object.keys(OriginalWebSocket).forEach((key) => {
  window.WebSocket[key] = OriginalWebSocket[key];
});
window.WebSocket.prototype = OriginalWebSocket.prototype;

function parseTipFromWS(data) {
  if (typeof data !== 'string') return;

  // Chaturbate tip format
  const cbMatch = data.match(/"method":"onTip".*?"from_username":"(\w+)".*?"amount":(\d+)/);
  if (cbMatch) {
    registerTip(cbMatch[1], parseInt(cbMatch[2]));
    return;
  }

  // Stripchat tip format
  const scMatch = data.match(/"type":"tip".*?"username":"(\w+)".*?"amount":(\d+)/);
  if (scMatch) {
    registerTip(scMatch[1], parseInt(scMatch[2]));
    return;
  }

  // Generic tip patterns
  const genericMatch = data.match(/tip.*?(\w+).*?(\d+)\s*(?:tokens?|tk)/i);
  if (genericMatch) {
    registerTip(genericMatch[1], parseInt(genericMatch[2]));
  }
}

function registerTip(username, amount) {
  pendingTips.push({ username, amount, timestamp: Date.now() });

  const existing = fanMap.get(username) || { total: 0, tier: 4, lastSeen: 0 };
  existing.total += amount;
  existing.lastSeen = Date.now();
  existing.tier = calculateTier(existing.total);
  fanMap.set(username, existing);
}

function calculateTier(total) {
  if (total >= 200) return 1;
  if (total >= 50) return 2;
  if (total >= 10) return 3;
  return 4;
}

// ─── DOM Scraping (3-second poll) ───────────────────────
function scrapeDOM() {
  const platform = detectPlatform(window.location.href);

  if (platform !== currentPlatform) {
    currentPlatform = platform;
    if (platform) ipcRenderer.send('cam:platform-detected', platform);
  }

  // Viewer count selectors by platform
  const viewerSelectors = [
    '#viewer_count', '.viewer-count', '[data-viewers]',
    '.viewers-count', '.viewer_count', '.cnt-viewers',
    '[class*="viewer"]', '[class*="Viewer"]',
  ];

  for (const sel of viewerSelectors) {
    const el = document.querySelector(sel);
    if (el) {
      const text = el.textContent || el.getAttribute('data-viewers') || '';
      const num = parseInt(text.replace(/[^\d]/g, ''));
      if (!isNaN(num) && num > 0) { viewers = num; break; }
    }
  }

  // Chat-based tip detection (fallback)
  const tipSelectors = [
    '.tip-amount', '.tipmessage', '[data-tip]',
    '.tip_message', '.tipMessage',
  ];

  for (const sel of tipSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (el.dataset._apexProcessed) return;
      el.dataset._apexProcessed = 'true';
      const match = el.textContent.match(/(\w+)\s+tipped\s+(\d+)/i);
      if (match) registerTip(match[1], parseInt(match[2]));
    });
  }

  // User list scraping
  const userSelectors = [
    '[data-testid="username-label"]', '.username',
    '.user-list-item', '.chat-username',
  ];

  for (const sel of userSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const name = el.textContent?.trim();
      if (name && !fanMap.has(name)) {
        fanMap.set(name, { total: 0, tier: 4, lastSeen: Date.now() });
      }
    });
  }
}

// ─── Broadcast Updates to Main Process ──────────────────
function broadcastUpdate() {
  const fans = [...fanMap.entries()]
    .map(([username, data]) => ({ username, ...data }))
    .sort((a, b) => b.total - a.total)
    .slice(0, 100);

  ipcRenderer.send('cam:live-update', {
    platform: currentPlatform,
    viewers,
    tips: pendingTips.splice(0), // drain queue
    fans,
  });
}

// ─── Polling Loop ───────────────────────────────────────
setInterval(() => {
  scrapeDOM();
  broadcastUpdate();
}, 3000);

// ─── URL Change Detection ───────────────────────────────
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    ipcRenderer.send('cam:url-changed', lastUrl);
  }
}, 1000);

console.log('[Apex Revenue] Cam preload injected ⚡');
