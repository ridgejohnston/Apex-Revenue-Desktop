/**
 * Apex Revenue — Signal Engine
 *
 * Main-process orchestrator. Subscribes to 'cam:live-update' from preload-cam.js,
 * runs detectSignals → buildPrompts → scorePrompts, and emits ranked prompts
 * back to the renderer via the 'signal-engine:update' IPC channel.
 *
 * Maintains:
 *   - viewerHistory    (sliding window, pruned in detectSignals)
 *   - shownAt          ({ [tag]: lastTimestamp } for cooldown factor)
 *   - thirtyDayHistory (cached from cloud, refreshed on login)
 *   - thresholds       (from performer_signal_thresholds, cloud-synced)
 */

const { ipcMain } = require('electron');
const Store = require('electron-store');
const { detectSignals } = require('../shared/signals');
const { buildPrompts } = require('../shared/prompt-builder');
const { scorePrompts } = require('../shared/prompt-scoring');

// Same store as main.js — fan/signal profiling only after in-app ownership verification.
let policyStore = null;
function isPlatformOwnershipVerified() {
  try {
    if (!policyStore) {
      policyStore = new Store({
        name: 'apex-revenue-v2',
        encryptionKey: 'apex-revenue-v2-enc-key-2025',
      });
    }
    return !!policyStore.get('platformOwnershipVerified');
  } catch {
    return false;
  }
}

class SignalEngine {
  constructor() {
    this.viewerHistory = [];
    this.shownAt = {};                 // { tag: lastShownTs }
    this.thirtyDayHistory = {};        // { username: { total } }
    this.thresholds = {
      whaleMin: 200,
      bigTipperMin: 50,
      tipperMin: 10,
    };
    this.physicalFatigueFactor = 0;    // Phase 2 wires this to user settings
    this.mainWindow = null;
    this.lastEmitAt = 0;
    this.emitThrottleMs = 2000;        // coalesce updates to at most 1 / 2s
  }

  attach(mainWindow) {
    this.mainWindow = mainWindow;

    ipcMain.on('cam:live-update', (_event, snapshot) => {
      this.handleLiveUpdate(snapshot);
    });

    ipcMain.handle('signal-engine:set-thresholds', (_e, thresholds) => {
      this.thresholds = { ...this.thresholds, ...thresholds };
      return this.thresholds;
    });

    ipcMain.handle('signal-engine:set-history', (_e, thirtyDayHistory) => {
      this.thirtyDayHistory = thirtyDayHistory || {};
    });

    ipcMain.handle('signal-engine:set-fatigue', (_e, value) => {
      this.physicalFatigueFactor = Math.max(0, Math.min(1, Number(value) || 0));
    });

    ipcMain.handle('signal-engine:mark-shown', (_e, tag) => {
      if (tag) this.shownAt[tag] = Date.now();
    });
  }

  handleLiveUpdate(snapshot) {
    if (!snapshot) return;
    if (!isPlatformOwnershipVerified()) return;

    // detectSignals mutates viewerHistory (append + prune).
    const sig = detectSignals(
      snapshot,
      this.thresholds,
      this.viewerHistory,
      this.thirtyDayHistory,
    );

    const candidates = buildPrompts(sig);

    const scored = scorePrompts(candidates, this.shownAt, {
      now: Date.now(),
      physicalFatigueFactor: this.physicalFatigueFactor,
    });

    // Top 4 — matches extension's allTop4 behavior.
    const topPrompts = scored.slice(0, 4);

    const now = Date.now();
    if (now - this.lastEmitAt < this.emitThrottleMs) return;
    this.lastEmitAt = now;

    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('signal-engine:update', {
        phase: sig.phase,
        signals: sig.signals,
        prompts: topPrompts,
        at: now,
      });
    }
  }
}

module.exports = new SignalEngine();
