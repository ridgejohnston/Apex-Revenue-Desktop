/**
 * Apex Revenue — Preload (BrowserView / Cam Site)
 *
 * Responsibilities:
 *   1. WebSocket interception for tips (Chaturbate, Stripchat, generic fallback)
 *   2. DOM polling (3s) for viewer count, chat-based tip fallback, user list
 *   3. [NEW in v3.2.0] Private Message observation via MutationObserver,
 *      scoped per-platform, emits 'cam:pm-received' to main process
 *
 * Observation only. Nothing in this file writes to the platform chat input.
 * Enforcement lives in main/browser-view-guard.js.
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
let fanMap = new Map();
let pmObserver = null;
let seenPMKeys = new Set();  // dedupe PMs within session
const PM_DEDUPE_CAP = 5000;  // prune periodically

// ─── WebSocket Interception ─────────────────────────────
const OriginalWebSocket = window.WebSocket;
window.WebSocket = function (url, protocols) {
  const ws = protocols ? new OriginalWebSocket(url, protocols) : new OriginalWebSocket(url);
  ws.addEventListener('message', (event) => {
    try {
      parseTipFromWS(event.data);
    } catch {}
  });
  return ws;
};
Object.keys(OriginalWebSocket).forEach((key) => {
  window.WebSocket[key] = OriginalWebSocket[key];
});
window.WebSocket.prototype = OriginalWebSocket.prototype;

function parseTipFromWS(data) {
  if (typeof data !== 'string') return;
  const cbMatch = data.match(/"method":"onTip".*?"from_username":"(\w+)".*?"amount":(\d+)/);
  if (cbMatch) { registerTip(cbMatch[1], parseInt(cbMatch[2])); return; }
  const scMatch = data.match(/"type":"tip".*?"username":"(\w+)".*?"amount":(\d+)/);
  if (scMatch) { registerTip(scMatch[1], parseInt(scMatch[2])); return; }
  const genericMatch = data.match(/tip.*?(\w+).*?(\d+)\s*(?:tokens?|tk)/i);
  if (genericMatch) registerTip(genericMatch[1], parseInt(genericMatch[2]));
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
    if (platform) {
      ipcRenderer.send('cam:platform-detected', platform);
      installPMObserver();  // re-install per platform on navigation
    }
  }

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

  const tipSelectors = ['.tip-amount', '.tipmessage', '[data-tip]', '.tip_message', '.tipMessage'];
  for (const sel of tipSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      if (el.dataset._apexProcessed) return;
      el.dataset._apexProcessed = 'true';
      const match = el.textContent.match(/(\w+)\s+tipped\s+(\d+)/i);
      if (match) registerTip(match[1], parseInt(match[2]));
    });
  }

  const userSelectors = ['[data-testid="username-label"]', '.username', '.user-list-item', '.chat-username'];
  for (const sel of userSelectors) {
    document.querySelectorAll(sel).forEach((el) => {
      const name = el.textContent?.trim();
      if (name && !fanMap.has(name)) {
        fanMap.set(name, { total: 0, tier: 4, lastSeen: Date.now() });
      }
    });
  }
}

// ─── Private Message Observation (v3.2.0 NEW) ───────────
//
// Each platform exposes PMs in different containers. We install a MutationObserver
// scoped to the PM container, extract normalized messages on added nodes, and
// forward them to main via 'cam:pm-received' IPC.
//
// Selectors are best-effort and based on platform inspection as of 2026-04.
// The main process tracks adapter health and surfaces a yellow dot in the sidebar
// if PMs stop flowing for a platform that should have active threads.

const PM_CONFIG = {
  chaturbate: {
    rootSelectors: [
      '[data-testid="private-message-panel"]',
      '.private-messages',
      '[class*="PrivateMessage"]',
    ],
    parseNode: parseChaturbatePM,
  },
  stripchat: {
    rootSelectors: ['.pm-window', '[class*="PrivateMessage"]', '[data-test-id="pm-panel"]'],
    parseNode: parseStripchatPM,
  },
  myfreecams: {
    rootSelectors: ['#pm_window', '.pm-container', '.private-message-list'],
    parseNode: parseMFCPM,
  },
  xtease: {
    rootSelectors: ['.pm-area', '.private-messages-container'],
    parseNode: parseXteasePM,
  },
};

function installPMObserver() {
  if (pmObserver) { pmObserver.disconnect(); pmObserver = null; }
  const cfg = PM_CONFIG[currentPlatform];
  if (!cfg) return;

  const tryFind = (retries) => {
    let root = null;
    for (const sel of cfg.rootSelectors) {
      root = document.querySelector(sel);
      if (root) break;
    }
    if (!root) {
      if (retries > 0) setTimeout(() => tryFind(retries - 1), 2000);
      else console.log('[Apex Revenue] PM root not found for', currentPlatform);
      return;
    }

    // Backfill: scan existing messages in the root once.
    scanExistingPMs(root, cfg.parseNode);

    pmObserver = new MutationObserver((mutations) => {
      for (const m of mutations) {
        m.addedNodes.forEach((n) => {
          if (n.nodeType !== 1) return;
          handlePMNode(n, cfg.parseNode);
        });
      }
    });
    pmObserver.observe(root, { childList: true, subtree: true });
    console.log('[Apex Revenue] PM observer active on', currentPlatform);
  };
  tryFind(10);  // retry for ~20s
}

function scanExistingPMs(root, parse) {
  // Scan all direct-message-looking descendants that exist at install time.
  const candidates = root.querySelectorAll(
    '[class*="message"], [class*="Message"], [data-testid*="message"], li, div'
  );
  candidates.forEach((n) => handlePMNode(n, parse));
}

function handlePMNode(node, parse) {
  try {
    const msg = parse(node);
    if (!msg) return;
    const key = msg.platform + '|' + msg.senderHandle + '|' + msg.body + '|' + msg.tsUtc;
    if (seenPMKeys.has(key)) return;
    seenPMKeys.add(key);
    if (seenPMKeys.size > PM_DEDUPE_CAP) {
      // prune oldest half — Sets don't order by insertion easily; rebuild
      const arr = [...seenPMKeys].slice(-Math.floor(PM_DEDUPE_CAP / 2));
      seenPMKeys = new Set(arr);
    }
    ipcRenderer.send('cam:pm-received', msg);
  } catch {}
}

// ─── Per-platform PM parsers ──────────────────────────────────────
//
// Each returns either null (node not a message) or a normalized message:
//   { platform, senderHandle, body, tsUtc, direction }
// direction: 'in' = received by performer, 'out' = sent by performer via platform UI.

function parseChaturbatePM(node) {
  // Chaturbate PM node often has [data-testid="pm-message"] or .pm-message
  const msgEl = node.matches && node.matches('[data-testid="pm-message"], .pm-message')
    ? node
    : node.querySelector && node.querySelector('[data-testid="pm-message"], .pm-message');
  if (!msgEl) return null;

  const senderEl = msgEl.querySelector('[data-testid="pm-sender"], .pm-sender, .username');
  const bodyEl   = msgEl.querySelector('[data-testid="pm-body"], .pm-body, .message-text');
  const sender = senderEl ? senderEl.textContent.trim() : null;
  const body   = bodyEl ? bodyEl.textContent.trim() : (msgEl.textContent || '').trim();
  if (!sender || !body) return null;

  // 'out' if sender matches current performer username (broadcaster)
  const isSelf = msgEl.classList.contains('self') || msgEl.classList.contains('sent-by-me');
  return {
    platform: 'chaturbate',
    senderHandle: sender,
    body,
    tsUtc: Date.now(),
    direction: isSelf ? 'out' : 'in',
  };
}

function parseStripchatPM(node) {
  const msgEl = node.matches && node.matches('.pm-message, [class*="PMMessage"]')
    ? node
    : node.querySelector && node.querySelector('.pm-message, [class*="PMMessage"]');
  if (!msgEl) return null;

  const senderEl = msgEl.querySelector('.pm-sender, [class*="sender"]');
  const bodyEl   = msgEl.querySelector('.pm-text, [class*="text"], [class*="body"]');
  const sender = senderEl ? senderEl.textContent.trim() : null;
  const body   = bodyEl ? bodyEl.textContent.trim() : (msgEl.textContent || '').trim();
  if (!sender || !body) return null;

  const isSelf = msgEl.classList.contains('own') || msgEl.classList.contains('self');
  return {
    platform: 'stripchat',
    senderHandle: sender,
    body,
    tsUtc: Date.now(),
    direction: isSelf ? 'out' : 'in',
  };
}

function parseMFCPM(node) {
  // MFC's PM DOM is older / framed — look for .pmmessage or nested .pm_msg
  const msgEl = node.matches && node.matches('.pmmessage, .pm_msg')
    ? node
    : node.querySelector && node.querySelector('.pmmessage, .pm_msg');
  if (!msgEl) return null;

  const senderEl = msgEl.querySelector('.pm_from, .pmfrom, .username');
  const bodyEl   = msgEl.querySelector('.pm_text, .pmtext, .body');
  const sender = senderEl ? senderEl.textContent.trim() : null;
  const body   = bodyEl ? bodyEl.textContent.trim() : (msgEl.textContent || '').trim();
  if (!sender || !body) return null;

  const isSelf = msgEl.classList.contains('pm_self') || msgEl.classList.contains('self');
  return {
    platform: 'myfreecams',
    senderHandle: sender,
    body,
    tsUtc: Date.now(),
    direction: isSelf ? 'out' : 'in',
  };
}

function parseXteasePM(node) {
  const msgEl = node.matches && node.matches('.pm-message, .private-message')
    ? node
    : node.querySelector && node.querySelector('.pm-message, .private-message');
  if (!msgEl) return null;

  const senderEl = msgEl.querySelector('.sender, .username, .from');
  const bodyEl   = msgEl.querySelector('.body, .content, .text');
  const sender = senderEl ? senderEl.textContent.trim() : null;
  const body   = bodyEl ? bodyEl.textContent.trim() : (msgEl.textContent || '').trim();
  if (!sender || !body) return null;

  const isSelf = msgEl.classList.contains('self') || msgEl.classList.contains('mine');
  return {
    platform: 'xtease',
    senderHandle: sender,
    body,
    tsUtc: Date.now(),
    direction: isSelf ? 'out' : 'in',
  };
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
    tips: pendingTips.splice(0),
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
    // Reinstall PM observer on SPA navigation
    setTimeout(installPMObserver, 1500);
  }
}, 1000);

console.log('[Apex Revenue] Cam preload injected ⚡ (v3.2.0 — PM observation)');
