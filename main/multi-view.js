/**
 * Tip-triggered Multi-View:
 *  • Legacy: temporarily show one alternate webcam (visibility) so the
 *    single stream follows the first visible camera.
 *  • Multi-output: main broadcast stays on the primary webcam (pipe); up to
 *    eight extra FFmpeg outputs (slots 0–7) send other cameras to separate
 *    RTMP ingests when tips meet each slot’s token threshold.
 */

let storeRef = null;
let sceneManager = null;
let getMainWindow = null;
let streamEngineRef = null;
let rotateIndex = 0;
let restoreTimer = null;
let savedSnapshot = null;
/** @type {Array<ReturnType<typeof setTimeout> | null>} */
const slotTimers = new Array(8).fill(null);

function init({ store, sceneManager: sm, getMainWindow: gw, streamEngine }) {
  storeRef = store;
  sceneManager = sm;
  getMainWindow = gw;
  streamEngineRef = streamEngine || null;
}

function normalizeMultiOutputs(raw) {
  const def = () => ({
    sourceId: null,
    triggerTokens: 25,
    durationSeconds: 8,
    streamUrl: '',
    streamKey: '',
  });
  const a = Array.isArray(raw) ? raw.slice(0, 8) : [];
  while (a.length < 8) a.push(def());
  return a.map((x) => ({ ...def(), ...x }));
}

function firstVisibleWebcam(scene) {
  if (!scene?.sources) return null;
  for (const s of scene.sources) {
    if (s.type === 'webcam' && s.visible) return s;
  }
  return null;
}

function webcamPatch(source) {
  const p = source.properties || {};
  return {
    videoSource: 'webcam',
    webcamDevice: p.deviceLabel || p.deviceName || '',
  };
}

/**
 * Sync obsSettings so the stream engine uses the correct video input.
 * When multiOutputEnabled is on, always bind to the primary webcam — not
 * "first visible" — so the main ingest never switches when tips fire.
 */
function applyPrimaryStreamFromScene() {
  const scene = sceneManager.getActive();
  const current = storeRef.get('obsSettings') || {};
  const cfg = storeRef.get('multiViewSettings') || {};

  if (cfg.multiOutputEnabled && cfg.defaultWebcamSourceId) {
    const primary = scene?.sources?.find(
      (s) => s.id === cfg.defaultWebcamSourceId && s.type === 'webcam',
    );
    if (primary) {
      storeRef.set('obsSettings', { ...current, ...webcamPatch(primary) });
      const win = getMainWindow && getMainWindow();
      if (win && !win.isDestroyed()) {
        win.webContents.send('obs-settings:auto-refreshed', { source: 'multi-view-primary' });
      }
      return;
    }
  }

  const cam = firstVisibleWebcam(scene);
  if (!cam) return;
  storeRef.set('obsSettings', { ...current, ...webcamPatch(cam) });
  const win = getMainWindow && getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('obs-settings:auto-refreshed', { source: 'multi-view' });
  }
}

function collectWebcamVisibility(scene) {
  const map = {};
  for (const s of scene.sources || []) {
    if (s.type === 'webcam') map[s.id] = s.visible;
  }
  return map;
}

function restoreFromSnapshot(sceneId, snap) {
  if (!snap) return;
  const scene = sceneManager.getAll().find((sc) => sc.id === sceneId);
  if (!scene) return;
  for (const s of scene.sources || []) {
    if (s.type === 'webcam' && Object.prototype.hasOwnProperty.call(snap, s.id)) {
      sceneManager.updateSource(sceneId, s.id, { visible: snap[s.id] });
    }
  }
  applyPrimaryStreamFromScene();
}

function legacyTipSwitch(scene, cfg) {
  const defaultId = cfg.defaultWebcamSourceId;
  const altIds = (cfg.alternateSourceIds || []).filter(Boolean);
  if (!defaultId || altIds.length === 0) return;

  const defSrc = scene.sources.find((s) => s.id === defaultId && s.type === 'webcam');
  if (!defSrc) return;
  const validAlts = altIds
    .map((id) => scene.sources.find((s) => s.id === id && s.type === 'webcam'))
    .filter(Boolean);
  if (validAlts.length === 0) return;

  if (restoreTimer) {
    clearTimeout(restoreTimer);
    restoreTimer = null;
  }

  if (savedSnapshot) {
    restoreFromSnapshot(scene.id, savedSnapshot);
    savedSnapshot = null;
  }

  const target = validAlts[rotateIndex % validAlts.length];
  rotateIndex += 1;

  savedSnapshot = collectWebcamVisibility(scene);

  for (const s of scene.sources) {
    if (s.type !== 'webcam') continue;
    if (s.id === target.id) {
      sceneManager.updateSource(scene.id, s.id, { visible: true });
    } else {
      sceneManager.updateSource(scene.id, s.id, { visible: false });
    }
  }

  applyPrimaryStreamFromScene();

  const holdMs = Math.max(1000, (Number(cfg.holdSeconds) || 8) * 1000);
  restoreTimer = setTimeout(() => {
    restoreTimer = null;
    if (savedSnapshot) {
      restoreFromSnapshot(scene.id, savedSnapshot);
      savedSnapshot = null;
    }
  }, holdMs);
}

function multiOutputTipStream(scene, cfg, tips) {
  const se = streamEngineRef;
  if (!se || typeof se.startAlternateRtmpStream !== 'function') return;

  const multiOutputs = normalizeMultiOutputs(cfg.multiOutputs);
  const obs = storeRef.get('obsSettings') || {};

  for (const tip of tips || []) {
    const amt = Number(tip.amount) || 0;
    if (amt < 1) continue;

    for (let i = 0; i < 8; i++) {
      const slot = multiOutputs[i] || {};
      const thresh = Number(slot.triggerTokens);
      if (!Number.isFinite(thresh) || thresh < 1) continue;
      if (amt < thresh) continue;

      const url = String(slot.streamUrl || '').trim();
      const key = String(slot.streamKey || '').trim();
      const sourceId = slot.sourceId || null;
      if (!sourceId || !url || !key) continue;

      const src = scene.sources.find((s) => s.id === sourceId && s.type === 'webcam');
      if (!src) continue;
      const p = src.properties || {};
      const webcamDevice = p.deviceLabel || p.deviceName || '';
      if (!webcamDevice) continue;

      const durationSec = Math.max(1, Math.min(600, Number(slot.durationSeconds) || 8));
      const holdMs = durationSec * 1000;

      if (slotTimers[i]) {
        clearTimeout(slotTimers[i]);
        slotTimers[i] = null;
      }
      se.stopAlternateRtmpStreamSlot(i);

      se.startAlternateRtmpStream(i, {
        webcamDevice,
        streamUrl: url,
        streamKey: key,
        videoBitrate: obs.videoBitrate,
        audioBitrate: obs.audioBitrate,
        fps: obs.fps,
        resolution: obs.resolution,
        videoEncoder: obs.videoEncoder,
      }).catch((e) => {
        console.warn(`[multi-view] Multi-output slot ${i + 1} failed:`, e.message);
      });

      slotTimers[i] = setTimeout(() => {
        slotTimers[i] = null;
        if (se && typeof se.stopAlternateRtmpStreamSlot === 'function') {
          se.stopAlternateRtmpStreamSlot(i);
        }
      }, holdMs);
    }
  }
}

/**
 * @param {Array<{ username: string, amount: number }>} tips
 */
function onTipsReceived(tips) {
  const cfg = storeRef.get('multiViewSettings') || {};
  if (!cfg.enabled) return;

  const scene = sceneManager.getActive();
  if (!scene) return;

  if (cfg.multiOutputEnabled) {
    const anyTip = (tips || []).some((t) => (Number(t.amount) || 0) >= 1);
    if (!anyTip) return;
    multiOutputTipStream(scene, cfg, tips);
    return;
  }

  const min = Number(cfg.tipThresholdTokens) || 1;
  const any = (tips || []).some((t) => (t.amount || 0) >= min);
  if (!any) return;

  legacyTipSwitch(scene, cfg);
}

module.exports = {
  init,
  onTipsReceived,
  applyPrimaryStreamFromScene,
  normalizeMultiOutputs,
};
