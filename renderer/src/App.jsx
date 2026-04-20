import React, { useState, useEffect, useCallback, useRef } from 'react';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import PreviewCanvas from './components/PreviewCanvas';
import ControlsDock from './components/ControlsDock';
import RightPanel from './components/RightPanel';
import AuthModal from './components/AuthModal';
import SettingsModal from './components/SettingsModal';
import AddSourceModal from './components/AddSourceModal';
import DebugPanel from './components/DebugPanel';
import BeautyPanel from './components/BeautyPanel';
import { BeautyFilter } from './filters/beauty-filter';
const { BEAUTY_DEFAULTS, BEAUTY_STORE_KEY, clampConfig: clampBeauty, isBeautyUnlocked } = require('../../shared/beauty-config');

const api = window.electronAPI;

// ─── Error Boundary ────────────────────────────────────────
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null, info: null, copied: false };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  // Log the caught error into the central error log. Fires when a
  // render-phase error propagates up; network/async/event-handler
  // errors are handled by the window-level listeners in index.jsx.
  componentDidCatch(error, info) {
    this.setState({ info });
    try {
      window.electronAPI?.errors?.log('fatal', 'react.boundary', error?.message || String(error), {
        stack: error?.stack,
        componentStack: info?.componentStack,
      });
    } catch {}
  }
  handleCopy = async () => {
    try {
      // Prefer the main-side handler (it grabs the full log, not just
      // this one error). Falls back to navigator.clipboard if IPC
      // isn't available for some reason.
      if (window.electronAPI?.errors?.copyToClipboard) {
        await window.electronAPI.errors.copyToClipboard();
      } else {
        const txt = `${this.state.error?.message}\n\n${this.state.error?.stack}`;
        await navigator.clipboard.writeText(txt);
      }
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {}
  };
  render() {
    if (this.state.error) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#0a0a0f', color: '#e0e0e0', padding: 32, fontFamily: 'monospace',
        }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚡</div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#f87171', marginBottom: 8 }}>Apex Revenue encountered an error</div>
          <div style={{
            fontSize: 11, color: '#9ca3af', background: '#1a1a2e', padding: 16, borderRadius: 6,
            maxWidth: 600, maxHeight: 300, overflow: 'auto', whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 20 }}>
            <button
              onClick={this.handleCopy}
              style={{
                padding: '8px 20px', background: '#334155', color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              {this.state.copied ? '✓ Copied' : '📋 Copy Error Log'}
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: '8px 20px', background: '#6366f1', color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
              }}
            >
              Reload App
            </button>
          </div>
          <div style={{ fontSize: 10, color: '#6b7280', marginTop: 12 }}>
            Paste the copied log to your developer for troubleshooting.
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

export default function App() {
  // ─── App State ─────────────────────────────────────────
  const [scenes, setScenes] = useState([]);
  const [activeSceneId, setActiveSceneId] = useState(null);
  const [liveData, setLiveData] = useState(null);
  const [streamStatus, setStreamStatus] = useState({ streaming: false, recording: false, virtualCam: false });
  const [platform, setPlatform] = useState(null);
  const [user, setUser] = useState(null);
  const [subscription, setSubscription] = useState(null);  // { plan, billingSource, expiresAt, offline, softExpired, graceRemainingMs, ... }
  const [adminTierToggle, setAdminTierToggle] = useState(null); // 'free' | 'platinum' | null
  const [showSoftExpireBanner, setShowSoftExpireBanner] = useState(false);
  const [expiryWarning, setExpiryWarning] = useState(null); // { hours, expiresAt } | null
  const [aiPrompt, setAiPrompt] = useState(null);

  // Beauty filter — config (persisted) + live filter instances keyed by sourceId
  const [beautyConfig, setBeautyConfig] = useState(BEAUTY_DEFAULTS);
  const beautyConfigRef = useRef(BEAUTY_DEFAULTS);
  const beautyFiltersRef = useRef({});   // sourceId → BeautyFilter
  // Set of source IDs currently being activated (between the initial
  // guard check and the final sourceStreamsRef write). Prevents a race
  // where two concurrent activateSource() calls for the same source
  // both pass the existingStream check BEFORE either one has populated
  // the ref — which was v3.4.37's confirmed root cause of duplicate
  // BeautyFilter instances showing up with distinct _instanceIds in
  // errors.log, even though the v3.4.34 guard was in place.
  const pendingActivationsRef = useRef(new Set());
  useEffect(() => { beautyConfigRef.current = beautyConfig; }, [beautyConfig]);

  // MediaPipe WASM + model install state. Background effects in the
  // filter only work once the engine is installed; the InstallPrompt
  // in BeautyPanel drives api.mediapipe.install() and shows progress.
  const [mediapipeStatus, setMediapipeStatus] = useState({ installed: false });
  const [mediapipeProgress, setMediapipeProgress] = useState(null);
  const mediapipeInstalledRef = useRef(false);
  useEffect(() => { mediapipeInstalledRef.current = !!mediapipeStatus.installed; }, [mediapipeStatus.installed]);
  const [showAuth, setShowAuth] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [activeTab, setActiveTab] = useState('obs'); // 'obs' | 'live' | 'fans' | 'ai'
  const [sidebarMode, setSidebarMode] = useState('scenes'); // 'scenes' | 'platforms'
  const [updateStatus, setUpdateStatus] = useState(null);
  const [ffmpegStatus, setFfmpegStatus] = useState(null); // null | { installed, path }
  const [ffmpegInstalling, setFfmpegInstalling] = useState(false);
  const [ffmpegProgress, setFfmpegProgress] = useState(0);
  const audioRef = useRef(null);

  // ─── Initialize ────────────────────────────────────────
  useEffect(() => {
    (async () => {
      // Load scenes
      const allScenes = await api.scenes.getAll();
      setScenes(allScenes);
      const active = await api.scenes.getActive();
      if (active) setActiveSceneId(active.id);

      // Re-establish source capture streams. Scenes persist to disk
      // (scene-manager), but their getUserMedia / getDisplayMedia
      // handles don't — those are Web APIs that live in memory and
      // only exist for the current renderer process. On app restart,
      // the sidebar shows every source with its saved visible state,
      // but without this reactivation loop there's no stream backing
      // any of them: preview canvas is empty, Start Stream on a
      // webcam source silently fails the preflight, virtual cam
      // output freezes on the last frame.
      //
      // activateSource is a useCallback with [] deps so its identity
      // is stable; calling it here (declared below) is safe even
      // though React would normally want it in the deps array. It
      // handles webcam, screen_capture, window_capture, game_capture,
      // audio_input, and audio_output, with its own try/catch — if
      // a device is busy or missing, it logs a warning and moves on
      // rather than throwing.
      //
      // Only visible sources get activated. Hidden ones stay dormant
      // until the user toggles them on, matching the pre-restart
      // behavior of an uninterrupted session.
      for (const scene of allScenes) {
        for (const source of scene.sources || []) {
          if (source.visible) {
            activateSource(source);
          }
        }
      }

      // Check auth — Hosted UI session (falls back to legacy aws.getSession for back-compat)
      const session = await (api.auth?.getSession ? api.auth.getSession() : api.aws.getSession());
      if (session) {
        setUser(session);
        // Pull the cached subscription immediately — paints the tier badge without waiting for network
        const sub = await api.subscription?.get?.({ force: false });
        if (sub) setSubscription(sub);
        // Then kick off a fresh check in the background
        api.subscription?.refresh?.().then((fresh) => fresh && setSubscription(fresh)).catch(() => {});
        // Hydrate admin toggle
        if (session.isAdmin && api.admin?.getTierToggle) {
          const t = await api.admin.getTierToggle();
          setAdminTierToggle(t);
        }
      }

      // Get stream status
      const status = await api.stream.getStatus();
      setStreamStatus(status);

      // Check FFmpeg
      const ffmpeg = await api.ffmpeg.check();
      setFfmpegStatus(ffmpeg);

      // Hydrate beauty filter config (persisted across launches)
      try {
        const saved = await api.store?.get?.(BEAUTY_STORE_KEY);
        if (saved) setBeautyConfig(clampBeauty(saved));
      } catch {}

      // Hydrate MediaPipe install status + subscribe to install progress
      try {
        const st = await api.mediapipe?.status?.();
        if (st) setMediapipeStatus(st);
      } catch {}
    })();

    // FFmpeg events
    api.ffmpeg.onProgress((p) => setFfmpegProgress(p.percent || 0));
    api.ffmpeg.onInstalled((result) => {
      setFfmpegInstalling(false);
      setFfmpegProgress(0);
      if (result.success) {
        setFfmpegStatus({ installed: true, path: result.path });
      }
    });

    // Event listeners
    api.scenes.onUpdated((data) => {
      setScenes(data.scenes);
      setActiveSceneId(data.activeId);
    });

    api.onLiveUpdate((data) => setLiveData(data));
    api.stream.onStatus((status) => {
      setStreamStatus(prev => {
        // If stream just stopped unexpectedly (was streaming, now isn't) and there's an error
        if (prev.streaming && !status.streaming && status.errorReason) {
          // CRITICAL: stop the MediaRecorder too. Without this, the
          // recorder keeps emitting 250ms Matroska clusters into IPC
          // long after FFmpeg has exited — and when the user clicks
          // Start Stream again, those stale chunks race the new
          // recorder's EBML header into the new FFmpeg's stdin,
          // causing "Invalid data found when processing input".
          stopWebcamRecorder();

          // Small delay so the "LIVE" badge has time to flip before the alert
          setTimeout(() => {
            alert(`Stream stopped unexpectedly:\n\n${status.errorReason}\n\nCheck your Stream URL, Stream Key, and that your audio device is connected.`);
          }, 300);
        }
        return status;
      });
    });
    api.cam.onPlatformDetected((p) => setPlatform(p));
    api.aws.onAiPrompt((data) => setAiPrompt(data));
    api.aws.onPollyAudio((base64) => {
      if (audioRef.current) {
        audioRef.current.src = `data:audio/mp3;base64,${base64}`;
        audioRef.current.play().catch(() => {});
      }
    });

    api.updates.onStatus((status) => setUpdateStatus(status));

    // ─── Subscription + admin-toggle events ─────────────
    api.subscription?.onUpdated?.((sub) => {
      setSubscription(sub);
      if (sub.softExpired) setShowSoftExpireBanner(true);
    });
    api.subscription?.onSoftExpired?.(() => setShowSoftExpireBanner(true));
    api.subscription?.onExpiryWarning?.((w) => setExpiryWarning(w));
    api.admin?.onTierToggleChanged?.((d) => setAdminTierToggle(d.tier));
    api.auth?.onSignedOutRemote?.(() => {
      setUser(null);
      setSubscription(null);
      setAdminTierToggle(null);
    });
  }, []);

  // Global keyboard shortcut: Ctrl+Shift+D (Cmd+Shift+D on macOS)
  // opens the debug panel. Separate from per-component key handlers
  // so it works regardless of which element has focus.
  useEffect(() => {
    const handler = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault();
        setShowDebug(true);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, []);

  // ─── Scene Actions ─────────────────────────────────────
  const handleCreateScene = useCallback(async () => {
    await api.scenes.create(`Scene ${scenes.length + 1}`);
  }, [scenes.length]);

  const handleDeleteScene = useCallback(async (id) => {
    await api.scenes.remove(id);
  }, []);

  const handleSelectScene = useCallback(async (id) => {
    await api.scenes.setActive(id);
  }, []);

  const handleRenameScene = useCallback(async (id, name) => {
    await api.scenes.rename(id, name);
  }, []);

  // ─── Source Actions ────────────────────────────────────
  const sourceStreamsRef = useRef({});   // sourceId → MediaStream (live, not React state)
  const [sourceStreams, setSourceStreams] = useState({}); // mirrors ref for re-renders

  // Start live capture for a source immediately after it is added
  const activateSource = useCallback(async (source) => {
    const { id, type, properties } = source;

    // RACE-PROOF GUARD (v3.4.38): synchronously claim this source-id
    // in a pending-activations set BEFORE any await. This closes the
    // window between the existingStream check and the ref write, which
    // v3.4.37's instrumented errors.log proved was producing duplicate
    // BeautyFilter instances (both at 19.5 fps with 51ms rafGap during
    // streaming, causing the stream-kick cascade).
    //
    // Why the previous guard wasn't sufficient:
    //   1. activateSource(src) fires
    //   2. Checks sourceStreamsRef.current[id] — empty (first time)
    //   3. await navigator.mediaDevices.getUserMedia(...)
    //   4. activateSource(src) fires AGAIN (e.g. from effectivePlan
    //      bounce, scene re-render, or mount effect re-run)
    //   5. Checks sourceStreamsRef.current[id] — STILL empty because
    //      step 3 hasn't resolved yet
    //   6. Also starts getUserMedia — now two in flight
    //   7. Both resolve; both construct BeautyFilters; both install
    //      their own render loops; second write to beautyFiltersRef
    //      orphans the first WITHOUT destroying its rAF callback
    //   8. Forever after, TWO 1080p WebGL render pipelines compete
    //      for the same GPU on every rAF tick
    //
    // Fix: synchronously mark source-id as pending before the await,
    // and remove the mark in a finally block. Any call that sees the
    // id already pending returns immediately as a no-op.
    if (pendingActivationsRef.current.has(id)) {
      return;
    }

    // GUARD: if this source is already active (stream held in the
    // ref AND any associated BeautyFilter still alive), bail out.
    // This catches the non-racy case where activateSource is called
    // cleanly for an already-active source (e.g. after all awaits
    // from a previous activation have resolved).
    //
    // Double-invocation can happen via:
    //   • The mount useEffect firing activateSource for every visible
    //     source after scenes.onUpdated re-fires mid-session
    //   • The effectivePlan-change useEffect bouncing webcam sources
    //     when the user's tier changes
    //   • handleAddSource calling activateSource directly when a new
    //     source is added, while the mount loop also catches it later
    //   • React StrictMode's double-mount in dev
    //
    // The guard is structural: we can always recover a stale entry
    // via deactivateSource first, but we don't get to silently
    // accumulate duplicate pipelines.
    const existingStream = sourceStreamsRef.current[id];
    if (existingStream) {
      const existingFilter = beautyFiltersRef.current[id];
      const filterHealthy = !existingFilter || !existingFilter._destroyed;
      const tracks = existingStream.getTracks ? existingStream.getTracks() : [];
      const anyLive = tracks.some((t) => t.readyState === 'live');
      if (anyLive && filterHealthy) {
        // Already active — no-op
        return;
      }
      // Stale entry — clean up before re-activating
      try { tracks.forEach((t) => t.stop()); } catch {}
      delete sourceStreamsRef.current[id];
      if (existingFilter) {
        try { existingFilter.destroy(); } catch {}
        delete beautyFiltersRef.current[id];
      }
    }

    // Claim the activation synchronously. Must happen AFTER the
    // stale-entry cleanup above (so deactivate/reactivate cycles
    // within a single call work) but BEFORE any await in the body
    // below. Cleared in the finally block regardless of success.
    pendingActivationsRef.current.add(id);

    let stream = null;
    try {
      if (type === 'webcam') {
        // Request BOTH video and audio from the browser. The built-in
        // audio track travels alongside video through MediaRecorder and
        // into FFmpeg's Matroska pipe — no separate dshow audio input
        // needed, no silent-lavfi fallback. This was critical to fix:
        // cam platforms (Chaturbate, Stripchat) kick streams that arrive
        // with no real audio content within 1-2 seconds of connection.
        // Apex was previously falling through to anullsrc silent audio
        // for anyone who hadn't manually configured a dshow mic in
        // Settings, producing immediate platform kicks.
        //
        // echoCancellation + noiseSuppression + autoGainControl are the
        // standard browser audio DSP flags — enable them so the mic
        // sounds reasonable without requiring the user to configure
        // anything.
        // Webcam capture resolution: 1080p. Do not sacrifice preview
        // or output quality for framerate — when GPU throughput on
        // integrated graphics can't sustain 1080p bilateral blur at
        // 30 fps, the right fix is to reduce shader work for the
        // blur PASSES (which produce intentionally-softened output
        // anyway) rather than downsample the whole capture pipeline.
        // See _resizeTo in beauty-filter.js for the half-res-blur
        // framebuffer decoupling that preserves 1080p composite.
        const videoConstraints = properties.deviceId
          ? { deviceId: { exact: properties.deviceId }, width: 1920, height: 1080 }
          : { width: 1920, height: 1080 };
        const audioConstraints = {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: audioConstraints,
          });
        } catch (audioErr) {
          // Mic missing, permission denied, or device in use — retry
          // without audio. Stream will still run but with silent output;
          // the pre-flight warning in handleStartStream will alert the
          // user before they hit Start Stream.
          console.warn('[Apex] Mic capture failed, retrying webcam video-only:', audioErr?.message || audioErr);
          stream = await navigator.mediaDevices.getUserMedia({
            video: videoConstraints,
            audio: false,
          });
        }

        // Beauty Filter: wrap the raw webcam stream in a WebGL2 bilateral
        // filter before anything else sees it. Preview canvas, stream
        // output (FFmpeg), and virtual camera all consume the same
        // beautified stream — one processing pass, no pipeline forks.
        //
        // Gating: only active when the user's effective tier includes
        // `beautyFilter` (admin bypass / beta / paid Platinum). We read
        // the current plan from a ref so this callback can stay stable.
        if (effectivePlanRef.current && isBeautyUnlocked(effectivePlanRef.current)) {
          try {
            const filter = new BeautyFilter(
              stream,
              {
                ...beautyConfigRef.current,
                mediapipeInstalled: mediapipeInstalledRef.current,
              },
              {
                // Auto-Beauty writeback. The engine ticks every ~2s and
                // sends partial config deltas (e.g. { warmth: 12,
                // brightness: 15 }) when it decides the current frame
                // deserves an adjustment. We merge with the current
                // config — which beautyConfigRef always holds — then
                // route through the same handler a manual slider edit
                // would use, so persistence + live-update + UI
                // re-render all happen for free via the existing path.
                onAutoBeautyUpdate: (updates) => {
                  handleBeautyChange({ ...beautyConfigRef.current, ...updates });
                },
              }
            );
            const filteredStream = filter.getStream();
            if (filteredStream !== stream) {
              beautyFiltersRef.current[id] = filter;
              stream = filteredStream;
            }
          } catch (e) {
            console.warn('[Apex] Beauty filter init failed, using raw stream:', e?.message);
          }
        }

      } else if (type === 'screen_capture' || type === 'window_capture' || type === 'game_capture') {
        // Electron: use desktopCapturer source id via chromeMediaSource constraint
        const chromeSourceId = properties.sourceId
          ? await api.sources.getDesktopStreamId(properties.sourceId)
          : null;

        if (chromeSourceId) {
          stream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
              mandatory: {
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: chromeSourceId,
              },
            },
          });
        } else {
          // Fallback: let the user pick via getDisplayMedia
          stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        }

      } else if (type === 'audio_input') {
        const constraints = {
          audio: properties.deviceId
            ? { deviceId: { exact: properties.deviceId } }
            : true,
          video: false,
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);

      } else if (type === 'audio_output') {
        // Audio output monitoring — capture desktop audio via getDisplayMedia
        stream = await navigator.mediaDevices.getDisplayMedia({ video: false, audio: true });
      }
    } catch (err) {
      console.warn(`[Apex] activateSource(${type}) failed:`, err.message);
    } finally {
      // Release the synchronous claim. Must happen regardless of
      // success or failure — otherwise a getUserMedia denial would
      // leave the id permanently "pending" and block all future
      // activation attempts for that source.
      pendingActivationsRef.current.delete(id);
    }

    if (stream) {
      sourceStreamsRef.current[id] = stream;
      setSourceStreams((prev) => ({ ...prev, [id]: stream }));
    }
  }, []);

  // Stop capture and release device when a source is removed
  const deactivateSource = useCallback((sourceId) => {
    // Tear down the beauty filter (if any) BEFORE stopping the track,
    // so the filter's internal video element can unbind cleanly.
    const filter = beautyFiltersRef.current[sourceId];
    if (filter) {
      try { filter.destroy(); } catch {}
      delete beautyFiltersRef.current[sourceId];
    }
    const stream = sourceStreamsRef.current[sourceId];
    if (stream) {
      stream.getTracks().forEach((t) => t.stop());
      delete sourceStreamsRef.current[sourceId];
      setSourceStreams((prev) => {
        const next = { ...prev };
        delete next[sourceId];
        return next;
      });
    }
  }, []);

  // Keep a ref mirror of scenes so the webcam release/restore hook
  // below can see the latest source list. Without this, the window-
  // exposed functions would close over whatever scenes value was in
  // scope at mount and miss any sources added during the session.
  const scenesRef = useRef([]);
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);

  // v3.3.24: the webcam release/restore handshake (v3.3.19) has been
  // removed. It existed to free the DirectShow camera pin so FFmpeg's
  // direct dshow input could grab frames — but that fight is now
  // obsolete because webcam streaming goes through the MediaRecorder
  // pipe path (handleStartStream below). The renderer owns the camera
  // permanently, preview keeps rendering during a live stream, and
  // FFmpeg reads WebM from stdin instead of dshow.

  const handleAddSource = useCallback(async (sourceConfig) => {
    if (!activeSceneId) return;
    const source = await api.sources.add(activeSceneId, sourceConfig);
    setShowAddSource(false);
    if (!source) return;

    // Auto-activate immediately after adding
    activateSource(source);

    // If the newly added source is a video-capture type, do two things:
    //   1. Cross-category exclusion: turn off any visible sources in the
    //      OPPOSITE video category, since FFmpeg can only stream one
    //      category at a time. Sources in the SAME category as the new
    //      one stay visible.
    //   2. Sync obsSettings so Start Stream picks it up immediately.
    //      The new source is appended to the list, so existing earlier
    //      sources in the same category will still be "first visible"
    //      and drive the stream — respect that unless the new source is
    //      the only one visible in its category.
    const newSourceCategory = getVideoCategory(source.type);
    if (newSourceCategory) {
      const scene = scenes.find((s) => s.id === activeSceneId);
      const sources = scene?.sources || [];

      // Turn off everything in the other video category
      const otherCategoryVisible = sources.filter(
        (s) =>
          s.visible &&
          s.id !== source.id &&
          getVideoCategory(s.type) &&
          getVideoCategory(s.type) !== newSourceCategory
      );
      await Promise.all(
        otherCategoryVisible.map((s) => api.sources.toggleVisible(activeSceneId, s.id))
      );

      // Sync obsSettings. If there were no earlier visible sources in
      // this category, the new source becomes the stream input;
      // otherwise, the first already-visible source in the category
      // remains the stream input (don't disrupt a live setup).
      const visibleInCategory = sources.filter(
        (s) => s.visible && getVideoCategory(s.type) === newSourceCategory
      );
      const streamSource = visibleInCategory.length > 0 ? visibleInCategory[0] : source;
      const current = (await api.store.get('obsSettings')) || {};
      const patch =
        streamSource.type === 'webcam'
          ? {
              videoSource: 'webcam',
              webcamDevice:
                streamSource.properties?.deviceLabel ||
                streamSource.properties?.deviceName ||
                '',
            }
          : { videoSource: 'screen' };
      await api.store.set('obsSettings', { ...current, ...patch });
    }
  }, [activeSceneId, activateSource, scenes]);

  const handleRemoveSource = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    deactivateSource(sourceId);
    await api.sources.remove(activeSceneId, sourceId);
  }, [activeSceneId, deactivateSource]);

  // v3.3.8: Video capture sources group into TWO mutually-exclusive
  // categories — 'webcam' and 'screen'. Multiple sources can live
  // within the same category (e.g. two webcams, or a screen_capture
  // + a window_capture). The stream engine's FFmpeg pipeline still
  // reads only one -i video input at a time, so when multiple
  // sources in the active category are visible, the engine picks the
  // first visible one (by list order) to actually stream.
  //
  // Right-panel Screen/Webcam buttons aggregate everything in their
  // category — see handleToggleCategory below.
  const VIDEO_CATEGORY_MAP = {
    // Live capture (aggregated: any of the 3 screen-types → 'screen')
    webcam: 'webcam',
    screen_capture: 'screen',
    window_capture: 'screen',
    game_capture: 'screen',

    // Media sources (each is its own category — distinct button in the
    // right panel's Stream Source section). Labels here must match the
    // category strings the right-panel buttons dispatch with.
    video_url: 'video_url',
    media: 'media',
    image_url: 'image_url',
    image: 'image',
    image_slideshow: 'slideshow',
  };
  const getVideoCategory = (sourceType) => VIDEO_CATEGORY_MAP[sourceType] || null;

  // Build the obsSettings patch that matches what the stream engine
  // would feed FFmpeg given a target visible-sources array. The engine
  // picks the first visible video source for its single FFmpeg input,
  // so the store must agree on which source that is.
  //
  // Keyed off the first-visible source's type. Each type contributes
  // its own property fields (webcamDevice, mediaPath, videoUrl, etc.)
  // that stream-engine.js reads in its per-type _build*Input methods.
  const computeStreamPatchFromSources = (sourcesAfterToggle) => {
    const firstVisibleVideo = sourcesAfterToggle.find(
      (s) => s.visible && getVideoCategory(s.type)
    );
    if (!firstVisibleVideo) {
      return { videoSource: 'screen' }; // safe default
    }
    return buildPatchForSource(firstVisibleVideo);
  };

  // Pure function: given a scene source, return the obsSettings patch
  // that configures the stream engine to feed from it. Factored out
  // so handleToggleCategory and computeStreamPatchFromSources share
  // one definition.
  const buildPatchForSource = (source) => {
    const p = source.properties || {};
    switch (source.type) {
      case 'webcam':
        return {
          videoSource: 'webcam',
          webcamDevice: p.deviceLabel || p.deviceName || '',
        };
      case 'screen_capture':
      case 'window_capture':
      case 'game_capture':
        return { videoSource: 'screen' };
      case 'media':
        return { videoSource: 'media', mediaPath: p.path || '' };
      case 'video_url':
        return { videoSource: 'video_url', videoUrl: p.url || '' };
      case 'image':
        return { videoSource: 'image', imagePath: p.path || '' };
      case 'image_url':
        return { videoSource: 'image_url', imageUrl: p.url || '' };
      case 'image_slideshow':
        return {
          videoSource: 'slideshow',
          slideshowFolder: p.folderPath || '',
          slideshowInterval: parseInt(p.interval, 10) || 5,
        };
      default:
        return { videoSource: 'screen' };
    }
  };

  const handleToggleSourceVisible = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    const scene = scenes.find((s) => s.id === activeSceneId);
    if (!scene) return;
    const target = (scene.sources || []).find((s) => s.id === sourceId);
    if (!target) {
      await api.sources.toggleVisible(activeSceneId, sourceId);
      return;
    }

    const targetCategory = getVideoCategory(target.type);
    const goingVisible = !target.visible;

    // Cross-category exclusion only. Turning ON a Webcam source turns
    // OFF everything in the Screen category, and vice versa. Within
    // the same category, multiple sources can be visible at once and
    // we don't cascade anything.
    if (targetCategory && goingVisible) {
      const others = (scene.sources || []).filter(
        (s) =>
          s.id !== sourceId &&
          s.visible &&
          getVideoCategory(s.type) &&
          getVideoCategory(s.type) !== targetCategory
      );
      await Promise.all(
        others.map((s) => api.sources.toggleVisible(activeSceneId, s.id))
      );
    }

    // Toggle the target source itself
    await api.sources.toggleVisible(activeSceneId, sourceId);

    // Sync obsSettings to whatever the stream engine should consume.
    // We compute the post-toggle scene state locally since React state
    // won't have updated yet when this function resolves.
    if (targetCategory) {
      const sourcesAfter = (scene.sources || []).map((s) => {
        if (s.id === sourceId) return { ...s, visible: goingVisible };
        if (
          goingVisible &&
          s.visible &&
          getVideoCategory(s.type) &&
          getVideoCategory(s.type) !== targetCategory
        ) {
          return { ...s, visible: false };
        }
        return s;
      });
      const current = (await api.store.get('obsSettings')) || {};
      const patch = computeStreamPatchFromSources(sourcesAfter);
      await api.store.set('obsSettings', { ...current, ...patch });
    }
  }, [activeSceneId, scenes]);

  // Right-panel Screen/Webcam buttons call this. Toggles an entire
  // video category at once:
  //   • If any sources of the category are visible → turn ALL of them OFF
  //     (the whole category goes dark).
  //   • Otherwise → turn ALL sources in this category ON, and turn OFF
  //     every source in the OTHER video category (cross-category
  //     exclusion). Sources that were already OFF in this category
  //     become visible together.
  // After the toggle, obsSettings.videoSource/webcamDevice are patched
  // to whatever the stream engine should stream (first visible source
  // in the newly-active category).
  const handleToggleCategory = useCallback(async (category) => {
    if (!activeSceneId) return;
    const scene = scenes.find((s) => s.id === activeSceneId);
    if (!scene) return;
    const sources = scene.sources || [];

    const inCategory = sources.filter((s) => getVideoCategory(s.type) === category);
    if (inCategory.length === 0) return; // nothing to toggle

    const anyVisible = inCategory.some((s) => s.visible);

    if (anyVisible) {
      // Turn the whole category off
      await Promise.all(
        inCategory
          .filter((s) => s.visible)
          .map((s) => api.sources.toggleVisible(activeSceneId, s.id))
      );
      const current = (await api.store.get('obsSettings')) || {};
      await api.store.set('obsSettings', { ...current, videoSource: 'screen' });
    } else {
      // Turn OFF every visible source in the OTHER category
      const otherCategoryVisible = sources.filter(
        (s) =>
          s.visible &&
          getVideoCategory(s.type) &&
          getVideoCategory(s.type) !== category
      );
      await Promise.all(
        otherCategoryVisible.map((s) => api.sources.toggleVisible(activeSceneId, s.id))
      );
      // Turn ON every source in THIS category that isn't already on
      await Promise.all(
        inCategory
          .filter((s) => !s.visible)
          .map((s) => api.sources.toggleVisible(activeSceneId, s.id))
      );

      // Stream from the first source in this category (list order).
      const first = inCategory[0];
      const current = (await api.store.get('obsSettings')) || {};
      const patch = buildPatchForSource(first);
      await api.store.set('obsSettings', { ...current, ...patch });
    }
  }, [activeSceneId, scenes]);

  const handleToggleSourceLock = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    await api.sources.toggleLock(activeSceneId, sourceId);
  }, [activeSceneId]);

  // Ref to the active MediaRecorder for webcam pipe-streaming. Held
  // in a ref (not state) so stop handlers and cleanup effects can
  // access it without stale closures.
  const webcamRecorderRef = useRef(null);

  // Stop and clear the active webcam MediaRecorder if any. Idempotent
  // and exception-safe. Called from three places:
  //
  //   1. Normal user-initiated stop (handleStopStream)
  //   2. Defensive pre-start cleanup (handleStartStream guard)
  //   3. Unexpected FFmpeg exit (api.stream.onStatus watcher)
  //
  // The third case is the critical one. When FFmpeg dies mid-stream
  // (e.g. RTMP error -138, encoder crash, stream-key rejection), the
  // renderer's MediaRecorder has no way to know — it keeps emitting
  // 250ms Matroska clusters into IPC that go nowhere. When the user
  // then clicks Start Stream again, those chunks race the NEW
  // recorder's EBML header into the NEW FFmpeg's stdin, and the
  // Matroska demuxer bails with "Invalid data found when processing
  // input" because only the very first chunk after MediaRecorder.start()
  // contains the header — every subsequent chunk is cluster-only.
  //
  // Stopping the recorder here prevents that race and produces a
  // clean EOF on the closed pipe.
  const stopWebcamRecorder = useCallback(() => {
    const r = webcamRecorderRef.current;
    webcamRecorderRef.current = null;
    if (!r) return;
    try {
      if (r.state !== 'inactive') r.stop();
    } catch (e) {
      console.warn('[Apex] stopWebcamRecorder: recorder.stop() threw:', e?.message || e);
    }
  }, []);

  // Pick the best MediaRecorder mime type the browser supports. H.264
  // in a matroska container is ideal because the browser's hardware
  // encoder produces it directly — FFmpeg can accept it without
  // having to decode VP8/VP9 first. Chromium (and therefore Electron)
  // has supported this since ~Chrome 52. Fallback chain covers older
  // or non-accelerated builds.
  const pickWebmMimeType = () => {
    const candidates = [
      'video/x-matroska;codecs=avc1',
      'video/x-matroska;codecs=h264',
      'video/webm;codecs=h264',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    for (const t of candidates) {
      if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
        return t;
      }
    }
    return 'video/webm'; // last-resort default
  };

  // ─── Stream / Record ──────────────────────────────────
  const handleStartStream = useCallback(async () => {
    if (ffmpegStatus && !ffmpegStatus.installed) {
      alert('FFmpeg is required for streaming. Please install it using the banner at the top.');
      return;
    }

    // Defensive: if a previous stream attempt left a MediaRecorder
    // running (e.g. the prior FFmpeg died on an RTMP error and the
    // renderer's recorder was never stopped), kill it NOW before
    // spawning a new one. Otherwise the old recorder's mid-cluster
    // chunks race the new recorder's EBML header into FFmpeg's stdin
    // and the Matroska demuxer fails with "Invalid data found when
    // processing input".
    stopWebcamRecorder();

    try {
      const settings = await api.store.get('obsSettings');

      // WEBCAM: use the MediaRecorder pipe path so the renderer keeps
      // the camera handle. Preview canvas keeps rendering during the
      // stream, which lets the user zoom/pan/tilt via canvas
      // transforms (the single camera consumer is the browser).
      //
      // Web research references:
      //   • mux.com/blog/the-state-of-going-live-from-a-browser
      //   • github.com/fbsamples/Canvas-Streaming-Example
      // Both document the MediaRecorder → stdin → FFmpeg pattern
      // used here.
      if (settings.videoSource === 'webcam') {
        // Find the active webcam source and its live MediaStream.
        const scene = scenes.find((s) => s.id === activeSceneId);
        const webcamSource = (scene?.sources || []).find(
          (s) => s.type === 'webcam' && s.visible
        );
        if (!webcamSource) {
          alert('No visible webcam source in the active scene. Add one from the Sources panel or toggle it on.');
          return;
        }
        const stream = sourceStreamsRef.current[webcamSource.id];
        if (!stream) {
          alert('The webcam source has no active video stream yet. Wait a moment for the preview to load and try again.');
          return;
        }

        // Does this stream actually carry audio? Determines whether
        // FFmpeg will map audio from the Matroska pipe (input 0) or
        // fall back to silent lavfi. Warn the user loudly if we're
        // about to stream silent audio — cam platforms kick silent
        // streams within 1-2 seconds, and the user deserves a heads
        // up before we start. Letting them cancel here is a much
        // better UX than watching the stream get killed by Chaturbate.
        const hasAudio = stream.getAudioTracks().length > 0;
        if (!hasAudio) {
          const proceed = confirm(
            'No microphone detected on your webcam stream.\n\n' +
            'Streaming services like Chaturbate typically disconnect streams within 1–2 seconds ' +
            'if they receive no audio. Your stream will likely be kicked shortly after it starts.\n\n' +
            'To fix: make sure a microphone is plugged in and granted permission to this app ' +
            '(Windows Settings > Privacy & security > Microphone), then remove and re-add the ' +
            'webcam source in Apex.\n\n' +
            'Continue streaming silent anyway?'
          );
          if (!proceed) return;
        }

        // Ask main to spawn FFmpeg listening on stdin BEFORE we start
        // the MediaRecorder. If we start the recorder first, the
        // first chunk or two might arrive before FFmpeg is ready and
        // get dropped — Matroska parsers are unforgiving about
        // missing EBML headers.
        //
        // Pass pipeHasAudio through settings so the stream engine
        // knows whether to map input 0's audio track or use the
        // silent-lavfi fallback. (Setting a transient field on the
        // settings object avoids changing the IPC shape.)
        await api.stream.startPipe({ ...settings, _pipeHasAudio: hasAudio });

        const mimeType = pickWebmMimeType();
        console.log('[Apex] Starting webcam pipe-stream, mimeType:', mimeType);

        const recorderOpts = {
          mimeType,
          videoBitsPerSecond: (settings.videoBitrate || 3500) * 1000,
        };
        if (settings.audioBitrate) {
          recorderOpts.audioBitsPerSecond = settings.audioBitrate * 1000;
        }

        const recorder = new MediaRecorder(stream, recorderOpts);

        // ── MediaRecorder output diagnostic ──
        //
        // Distinguishes between two failure modes we can't tell apart
        // from the stream-pipe log alone:
        //
        //   A. captureStream(30) under-delivering — Chromium's dirty
        //      tracking skips emissions when canvas output looks similar
        //      frame-to-frame, so MediaRecorder's input is sparse.
        //   B. MediaRecorder's internal encoder dropping frames under
        //      CPU pressure, so canvas IS delivering 30 fps but the
        //      encoder is only producing ~5 fps of encoded output.
        //
        // v3.4.38's test showed 20 video frames over 3.71s of MediaRecorder
        // content despite a render loop confirmed at 30+ fps. Need to
        // know WHICH side of MediaRecorder is dropping.
        //
        // What this logs to errors.log (every 5 seconds while recording):
        //   • chunks per second (should be ~4 at 250ms timeslice)
        //   • bytes per chunk (size proves encoder is producing output)
        //   • avgChunkGap (should be ~250ms)
        //   • effectiveBitrate (compare to target videoBitrate)
        //   • videoTrack.getSettings() snapshot — what Chromium thinks
        //     the canvas-captured track's frame rate is
        //
        // Interpretation guide:
        //   chunks~4/s + small bytes → captureStream under-delivered
        //                              (fewer frames to encode)
        //   chunks~4/s + normal bytes but still 5fps in FFmpeg → pipe
        //                              I/O or demux issue
        //   chunks<4/s → MediaRecorder's encoder stalled
        //   effectiveBitrate << target → encoder or capture loss
        //
        // The diagnostic has zero effect on stream behavior — pure
        // measurement. Can be removed once the hypothesis is confirmed.
        const mrStats = {
          startedAt: performance.now(),
          windowStart: performance.now(),
          lastChunkAt: null,
          chunkCount: 0,
          chunkBytes: 0,
          chunkGapSum: 0,
          chunkGapCount: 0,
          windowChunkCount: 0,
          windowChunkBytes: 0,
          windowGapSum: 0,
          windowGapCount: 0,
        };

        // Snapshot the video track settings as MediaRecorder sees it.
        // Chromium reports the track's current frameRate here — if it
        // says 30 but MediaRecorder produces 5 fps, the capture-to-
        // encoder hop is dropping. If it says 5, the track itself is
        // underdelivering from the canvas.
        try {
          const videoTracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
          const vSettings   = videoTracks[0]?.getSettings?.() || {};
          window.electronAPI?.errors?.log?.(
            'info', 'media-recorder',
            `MediaRecorder starting: videoTrack frameRate=${vSettings.frameRate ?? '?'}, ` +
            `size=${vSettings.width ?? '?'}x${vSettings.height ?? '?'}, ` +
            `mimeType=${recorderOpts.mimeType}, ` +
            `videoBitsPerSecond=${recorderOpts.videoBitsPerSecond ?? 'default'}`,
            {
              videoTrackSettings: vSettings,
              audioTracks: stream.getAudioTracks?.().length ?? 0,
              videoTracks: videoTracks.length,
              mimeType:          recorderOpts.mimeType,
              videoBitsPerSecond: recorderOpts.videoBitsPerSecond ?? null,
              audioBitsPerSecond: recorderOpts.audioBitsPerSecond ?? null,
              timeslice:         250,
            }
          );
        } catch {}

        recorder.ondataavailable = async (e) => {
          if (!e.data || e.data.size === 0) return;
          // Update diagnostic stats before the IPC send so we measure
          // what MediaRecorder actually produced, not what got through
          // after IPC roundtrip.
          const nowTs = performance.now();
          if (mrStats.lastChunkAt !== null) {
            const gap = nowTs - mrStats.lastChunkAt;
            mrStats.chunkGapSum    += gap;
            mrStats.chunkGapCount  += 1;
            mrStats.windowGapSum   += gap;
            mrStats.windowGapCount += 1;
          }
          mrStats.lastChunkAt        = nowTs;
          mrStats.chunkCount        += 1;
          mrStats.chunkBytes        += e.data.size;
          mrStats.windowChunkCount  += 1;
          mrStats.windowChunkBytes  += e.data.size;

          // Window report every 5s — mirrors beauty-filter cadence
          const windowMs = nowTs - mrStats.windowStart;
          if (windowMs >= 5000) {
            const chunksPerSec        = (mrStats.windowChunkCount * 1000) / windowMs;
            const avgChunkBytes       = mrStats.windowChunkBytes / Math.max(1, mrStats.windowChunkCount);
            const avgChunkGapMs       = mrStats.windowGapCount > 0
              ? mrStats.windowGapSum / mrStats.windowGapCount
              : 0;
            // Effective bitrate in kbps based on the window's throughput.
            // Combines video + audio since MediaRecorder muxes both.
            const effBitrateKbps      = (mrStats.windowChunkBytes * 8) / windowMs;
            try {
              window.electronAPI?.errors?.log?.(
                'info', 'media-recorder',
                `MediaRecorder output: ${chunksPerSec.toFixed(2)} chunks/s, ` +
                `avgChunk=${(avgChunkBytes / 1024).toFixed(1)}KB, ` +
                `avgGap=${avgChunkGapMs.toFixed(0)}ms, ` +
                `effBitrate=${effBitrateKbps.toFixed(0)}kbps`,
                {
                  chunksPerSec:   Number(chunksPerSec.toFixed(2)),
                  avgChunkBytes:  Math.round(avgChunkBytes),
                  avgChunkGapMs:  Math.round(avgChunkGapMs),
                  effBitrateKbps: Math.round(effBitrateKbps),
                  windowChunks:   mrStats.windowChunkCount,
                  windowBytes:    mrStats.windowChunkBytes,
                  windowMs:       Math.round(windowMs),
                }
              );
            } catch {}
            mrStats.windowStart      = nowTs;
            mrStats.windowChunkCount = 0;
            mrStats.windowChunkBytes = 0;
            mrStats.windowGapSum     = 0;
            mrStats.windowGapCount   = 0;
          }

          try {
            const buf = await e.data.arrayBuffer();
            // Electron structured clone supports ArrayBuffer over IPC.
            // .send (fire-and-forget) instead of .invoke avoids an ACK
            // roundtrip per chunk at ~4 Hz.
            api.stream.sendWebmChunk(buf);
          } catch (err) {
            console.warn('[Apex] chunk send failed:', err.message);
          }
        };
        recorder.onerror = (e) => {
          console.error('[Apex] MediaRecorder error:', e.error?.message || e);
          try {
            window.electronAPI?.errors?.log?.(
              'error', 'media-recorder',
              `MediaRecorder error: ${e.error?.message || String(e)}`,
              { errorName: e.error?.name ?? null }
            );
          } catch {}
        };
        recorder.onstop = () => {
          console.log('[Apex] MediaRecorder stopped');
          // Final tally: total chunks + bytes + duration. Lets us
          // cross-check against the FFmpeg stream-pipe log's
          // "video:X KB audio:Y KB" numbers to confirm all chunks
          // made it through IPC to FFmpeg's stdin.
          try {
            const totalMs  = performance.now() - mrStats.startedAt;
            const avgCps   = (mrStats.chunkCount * 1000) / Math.max(1, totalMs);
            const avgBytes = mrStats.chunkBytes / Math.max(1, mrStats.chunkCount);
            const avgGap   = mrStats.chunkGapCount > 0
              ? mrStats.chunkGapSum / mrStats.chunkGapCount
              : 0;
            window.electronAPI?.errors?.log?.(
              'info', 'media-recorder',
              `MediaRecorder final: ${mrStats.chunkCount} chunks, ` +
              `${(mrStats.chunkBytes / 1024).toFixed(1)}KB total, ` +
              `${avgCps.toFixed(2)} chunks/s, avgGap=${avgGap.toFixed(0)}ms, ` +
              `ran ${(totalMs / 1000).toFixed(1)}s`,
              {
                totalChunks:   mrStats.chunkCount,
                totalBytes:    mrStats.chunkBytes,
                totalMs:       Math.round(totalMs),
                avgChunksPerSec: Number(avgCps.toFixed(2)),
                avgChunkBytes:   Math.round(avgBytes),
                avgChunkGapMs:   Math.round(avgGap),
              }
            );
          } catch {}
        };

        // 250ms timeslice — ~4 chunks/sec. Low enough latency for
        // live chat interaction, high enough that each chunk is a
        // reasonable container unit (not thousands of 1ms fragments).
        recorder.start(250);
        webcamRecorderRef.current = recorder;
        return;
      }

      // NON-WEBCAM sources: existing stream-engine path. Screen/window/
      // game capture uses gdigrab. Media/image/URL/slideshow uses
      // FFmpeg's built-in decoders. None of these have exclusive-pin
      // contention with the renderer's preview.
      await api.stream.start(settings);
    } catch (e) {
      console.error('Stream start error:', e);
      // If we got partway through setting up a pipe-stream recorder
      // before something threw, clean it up. Otherwise an orphan
      // recorder would keep emitting chunks into a closed pipe.
      stopWebcamRecorder();
      alert('Stream failed to start: ' + (e.message || e));
    }
  }, [ffmpegStatus, scenes, activeSceneId, stopWebcamRecorder]);

  const handleStopStream = useCallback(async () => {
    // If we're pipe-streaming a webcam, stop the recorder first so
    // stdin receives a clean EOF after the last chunk flushes. Then
    // tell main to end the FFmpeg process. Order matters: stopping
    // FFmpeg first would leave the recorder trying to write to a
    // closed pipe, spamming EPIPE errors.
    const hadRecorder = !!webcamRecorderRef.current;
    stopWebcamRecorder();
    if (hadRecorder) {
      await api.stream.stopPipe();
      return;
    }
    await api.stream.stop();
  }, [stopWebcamRecorder]);

  const handleStartRecord = useCallback(async () => {
    if (ffmpegStatus && !ffmpegStatus.installed) {
      alert('FFmpeg is required for recording. Please install it using the banner at the top.');
      return;
    }
    try {
      const settings = await api.store.get('obsSettings');
      await api.record.start(settings);
    }
    catch (e) { console.error('Record start error:', e); }
  }, [ffmpegStatus]);

  const handleStopRecord = useCallback(async () => {
    await api.record.stop();
  }, []);

  const handleToggleVirtualCam = useCallback(async () => {
    if (streamStatus.virtualCam) await api.virtualCam.stop();
    else await api.virtualCam.start();
  }, [streamStatus.virtualCam]);

  // ─── FFmpeg Install ───────────────────────────────────
  const handleInstallFFmpeg = useCallback(async () => {
    setFfmpegInstalling(true);
    setFfmpegProgress(0);
    await api.ffmpeg.install();
  }, []);

  // ─── Auth ─────────────────────────────────────────────
  // Hosted UI flow: the AuthModal triggers api.auth.hostedUiSignIn() itself;
  // once it resolves, we just pull the session in and stash it in state.
  const handleAuthStarted = useCallback(async () => {
    const session = await api.auth.getSession();
    if (session) {
      setUser(session);
      const sub = await api.subscription?.refresh?.();
      if (sub) setSubscription(sub);
      if (session.isAdmin) {
        const t = await api.admin.getTierToggle();
        setAdminTierToggle(t);
      }
      setShowAuth(false);
    }
  }, []);

  const handleSignOut = useCallback(async () => {
    await api.auth.signOut();
    setUser(null);
    setSubscription(null);
    setAdminTierToggle(null);
    setShowSoftExpireBanner(false);
    setExpiryWarning(null);
  }, []);

  const handleAdminToggleChange = useCallback(async (tier) => {
    const res = await api.admin.setTierToggle(tier);
    if (res?.ok) setAdminTierToggle(res.tier);
  }, []);

  // ─── Derived: effective plan ──────────────────────────
  // Admin toggle wins, then subscription plan. Non-admins never see the toggle.
  // Valid admin toggles are the same set as paid plan names + free —
  // agency (Tier 3) is the organization-level plan, platinum (Tier 2)
  // is the individual paid plan, free is the ungated baseline.
  const ADMIN_TOGGLE_VALUES = ['free', 'platinum', 'agency'];
  const adminOverrideActive =
    user?.isAdmin && ADMIN_TOGGLE_VALUES.includes(adminTierToggle);
  const effectivePlan = adminOverrideActive
    ? adminTierToggle
    : (subscription?.plan || 'free');
  const effectiveBillingSource = adminOverrideActive
    ? 'admin-toggle'
    : (subscription?.billingSource || 'unknown');

  // Ref mirror of effectivePlan so callbacks (activateSource) can read
  // the latest tier without being re-created on every subscription update.
  const effectivePlanRef = useRef(effectivePlan);
  useEffect(() => { effectivePlanRef.current = effectivePlan; }, [effectivePlan]);

  // ─── Beauty filter handlers ───────────────────────────
  const handleBeautyChange = useCallback((next) => {
    const clamped = clampBeauty(next);
    setBeautyConfig(clamped);
    // Persist to electron-store so settings survive restarts
    api.store?.set?.(BEAUTY_STORE_KEY, clamped);
    // Live-update all active filter instances — no reload / reactivate.
    // We also re-send the current install flag on every update so the
    // filter's lazy-segmenter gate sees it when the user flips bgMode on.
    const update = { ...clamped, mediapipeInstalled: mediapipeInstalledRef.current };
    for (const filter of Object.values(beautyFiltersRef.current)) {
      try { filter.update(update); } catch {}
    }
  }, []);

  // ─── MediaPipe install handlers ───────────────────────
  // Subscribe to main-process progress events once on mount; the
  // teardown returned by the bridge keeps React StrictMode happy.
  useEffect(() => {
    if (!api.mediapipe?.onProgress) return;
    const off = api.mediapipe.onProgress((p) => setMediapipeProgress(p));
    return () => { try { off?.(); } catch {} };
  }, []);

  const handleInstallMediapipe = useCallback(async () => {
    setMediapipeProgress({ phase: 'manifest', bytesDownloaded: 0, totalBytes: 0 });
    try {
      const result = await api.mediapipe?.install?.();
      if (result?.ok) {
        setMediapipeStatus(result.status);
        setMediapipeProgress(null);
        // Nudge every live filter: install just completed, so the lazy
        // segmenter gate should now open on the next update.
        for (const filter of Object.values(beautyFiltersRef.current)) {
          try { filter.update({ mediapipeInstalled: true }); } catch {}
        }
      } else {
        setMediapipeProgress({ phase: 'error', message: result?.error || 'install failed' });
      }
    } catch (err) {
      setMediapipeProgress({ phase: 'error', message: err?.message || String(err) });
    }
  }, []);

  const handleUninstallMediapipe = useCallback(async () => {
    try {
      await api.mediapipe?.uninstall?.();
      setMediapipeStatus({ installed: false });
      setMediapipeProgress(null);
      // Flip bg mode off in current config since the engine is gone
      const next = clampBeauty({ ...beautyConfigRef.current, bgMode: 0 });
      setBeautyConfig(next);
      api.store?.set?.(BEAUTY_STORE_KEY, next);
      for (const filter of Object.values(beautyFiltersRef.current)) {
        try { filter.update({ ...next, mediapipeInstalled: false }); } catch {}
      }
    } catch (err) {
      console.warn('[Apex] Mediapipe uninstall failed:', err?.message);
    }
  }, []);

  // When the tier changes such that beauty filter access changes state
  // (admin flips toggle, subscription downgrades, etc.), reactivate
  // currently-visible webcam sources so they pick up or drop the filter.
  const lastBeautyAccessRef = useRef(null);
  useEffect(() => {
    const now = isBeautyUnlocked(effectivePlan);
    if (lastBeautyAccessRef.current === null) {
      lastBeautyAccessRef.current = now;
      return;
    }
    if (lastBeautyAccessRef.current !== now) {
      lastBeautyAccessRef.current = now;
      // Reactivate webcam sources only — no need to bounce screen captures
      for (const scene of scenesRef.current || []) {
        for (const source of scene.sources || []) {
          if (source.type === 'webcam' && source.visible) {
            deactivateSource(source.id);
            activateSource(source);
          }
        }
      }
    }
  }, [effectivePlan, activateSource, deactivateSource]);

  // ─── Derived State ────────────────────────────────────
  const activeScene = scenes.find((s) => s.id === activeSceneId) || scenes[0];

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="flex-col" style={{ width: '100%', height: '100%' }}>
      {/* Hidden audio player for Polly */}
      <audio ref={audioRef} style={{ display: 'none' }} />

      {/* Soft-expire banner — appears when Platinum has lapsed and the 3-day
          offline grace has expired, OR when the backend explicitly reports a
          cancelled/ended subscription. Prompts re-subscription. */}
      {user && showSoftExpireBanner && (
        <div style={{
          background: '#451a03', borderBottom: '1px solid #f97316',
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 11, color: '#fed7aa', flexShrink: 0,
        }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={{ flex: 1 }}>
            <strong style={{ color: '#fff' }}>Platinum access ended.</strong>{' '}
            Your subscription has expired and the 3-day grace period has passed. Premium features are now disabled.
          </span>
          <button
            onClick={() => window.open('https://apexrevenue.works/billing', '_blank')}
            style={{
              padding: '4px 12px', background: '#f97316', color: '#fff',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11, fontWeight: 600,
            }}
          >
            Resubscribe
          </button>
          <button
            onClick={() => setShowSoftExpireBanner(false)}
            style={{
              padding: '4px 10px', background: 'transparent', color: '#fed7aa',
              border: '1px solid #f97316', borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Expiry warning — fires at T-72h and T-24h before subscription end.
          Different from soft-expire: this is pre-expiry, Platinum still active. */}
      {user && expiryWarning && !showSoftExpireBanner && (
        <div style={{
          background: expiryWarning.hours <= 24 ? '#422006' : '#1e3a8a',
          borderBottom: `1px solid ${expiryWarning.hours <= 24 ? '#f59e0b' : '#3b82f6'}`,
          padding: '8px 12px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 11, color: expiryWarning.hours <= 24 ? '#fde68a' : '#bfdbfe', flexShrink: 0,
        }}>
          <span style={{ fontSize: 14 }}>{expiryWarning.hours <= 24 ? '🔔' : '⏰'}</span>
          <span style={{ flex: 1 }}>
            <strong style={{ color: '#fff' }}>
              Platinum expires in {expiryWarning.hours <= 24 ? '24 hours' : '3 days'}.
            </strong>{' '}
            Renew now to keep AI prompts, whale alerts, and cloud sync active past{' '}
            {new Date(expiryWarning.expiresAt).toLocaleDateString()}.
          </span>
          <button
            onClick={() => window.open('https://apexrevenue.works/billing', '_blank')}
            style={{
              padding: '4px 12px',
              background: expiryWarning.hours <= 24 ? '#f59e0b' : '#3b82f6',
              color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
              fontSize: 11, fontWeight: 600,
            }}
          >
            Manage Billing
          </button>
          <button
            onClick={() => setExpiryWarning(null)}
            style={{
              padding: '4px 10px', background: 'transparent',
              color: expiryWarning.hours <= 24 ? '#fde68a' : '#bfdbfe',
              border: `1px solid ${expiryWarning.hours <= 24 ? '#f59e0b' : '#3b82f6'}`,
              borderRadius: 4, cursor: 'pointer', fontSize: 11,
            }}
          >
            Dismiss
          </button>
        </div>
      )}

      {/* FFmpeg Install Banner */}
      {ffmpegStatus && !ffmpegStatus.installed && (
        <div style={{
          background: '#1e1b4b', borderBottom: '1px solid #4f46e5',
          padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 10,
          fontSize: 11, color: '#c7d2fe', flexShrink: 0,
        }}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={{ flex: 1 }}>
            <strong style={{ color: '#fff' }}>FFmpeg not installed</strong> — required for streaming &amp; recording.
          </span>
          {ffmpegInstalling ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{
                width: 120, height: 6, background: '#312e81', borderRadius: 3, overflow: 'hidden',
              }}>
                <div style={{
                  width: `${ffmpegProgress}%`, height: '100%',
                  background: '#6366f1', transition: 'width 0.3s',
                }} />
              </div>
              <span style={{ color: '#a5b4fc', fontSize: 10 }}>{ffmpegProgress}%</span>
            </div>
          ) : (
            <button
              onClick={handleInstallFFmpeg}
              style={{
                padding: '4px 12px', background: '#6366f1', color: '#fff',
                border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 11,
                fontWeight: 600,
              }}
            >
              Install FFmpeg
            </button>
          )}
        </div>
      )}

      {/* Titlebar */}
      <Titlebar
        user={user}
        streamStatus={streamStatus}
        platform={platform}
        updateStatus={updateStatus}
        onAuthClick={() => setShowAuth(true)}
        onSettingsClick={() => setShowSettings(true)}
        onSignOut={handleSignOut}
        onS3Backup={() => api.aws.s3Backup()}
        effectivePlan={effectivePlan}
        billingSource={effectiveBillingSource}
        adminToggle={adminTierToggle}
        onAdminToggleChange={handleAdminToggleChange}
        subscriptionOffline={subscription?.offline}
        graceRemainingMs={subscription?.graceRemainingMs}
      />

      {/* Main content area */}
      <div className="flex flex-1" style={{ overflow: 'hidden' }}>
        {/* Left Sidebar */}
        <Sidebar
          mode={sidebarMode}
          onModeChange={setSidebarMode}
          scenes={scenes}
          activeSceneId={activeSceneId}
          activeScene={activeScene}
          onSelectScene={handleSelectScene}
          onCreateScene={handleCreateScene}
          onDeleteScene={handleDeleteScene}
          onRenameScene={handleRenameScene}
          onAddSource={() => setShowAddSource(true)}
          onRemoveSource={handleRemoveSource}
          onToggleSourceVisible={handleToggleSourceVisible}
          onToggleSourceLock={handleToggleSourceLock}
          onNavigate={(url) => api.cam.navigate(url)}
        />

        {/* Center: Preview + Controls */}
        <div className="flex-col flex-1" style={{ overflow: 'hidden' }}>
          <PreviewCanvas
            scene={activeScene}
            streamStatus={streamStatus}
            sourceStreams={sourceStreams}
          />
          <ControlsDock
            streamStatus={streamStatus}
            onStartStream={handleStartStream}
            onStopStream={handleStopStream}
            onStartRecord={handleStartRecord}
            onStopRecord={handleStopRecord}
            onToggleVirtualCam={handleToggleVirtualCam}
            onSettingsClick={() => setShowSettings(true)}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
        </div>

        {/* Right Panel */}
        <RightPanel
          activeTab={activeTab}
          liveData={liveData}
          streamStatus={streamStatus}
          platform={platform}
          user={user}
          aiPrompt={aiPrompt}
          onDismissPrompt={() => setAiPrompt(null)}
          onAuthClick={() => setShowAuth(true)}
          activeScene={activeScene}
          onToggleSourceVisible={handleToggleSourceVisible}
          onToggleCategory={handleToggleCategory}
          beautyConfig={beautyConfig}
          onBeautyChange={handleBeautyChange}
          beautyUnlocked={isBeautyUnlocked(effectivePlan)}
          effectivePlan={effectivePlan}
          mediapipeStatus={mediapipeStatus}
          mediapipeProgress={mediapipeProgress}
          onInstallMediapipe={handleInstallMediapipe}
          onUninstallMediapipe={handleUninstallMediapipe}
        />
      </div>

      {/* Modals */}
      {showAuth && (
        <AuthModal onAuthStarted={handleAuthStarted} onClose={() => setShowAuth(false)} />
      )}
      {showSettings && (
        <SettingsModal onClose={() => setShowSettings(false)} />
      )}
      {showAddSource && (
        <AddSourceModal onAdd={handleAddSource} onClose={() => setShowAddSource(false)} />
      )}
      {showDebug && (
        <DebugPanel onClose={() => setShowDebug(false)} />
      )}
      {/*
        Floating Debug button — bottom-right, always accessible. The
        primary workflow when something breaks: click the bug, hit
        "Copy to Clipboard", paste into the dev chat. Small enough to
        not intrude on normal use; red-tinted so it's easy to find
        in a panic.
        Also openable via Ctrl+Shift+D — the keyboard shortcut is
        wired in the useEffect below.
      */}
      <button
        onClick={() => setShowDebug(true)}
        title="Debug & Error Log (Ctrl+Shift+D)"
        style={{
          position: 'fixed',
          bottom: 16,
          right: 16,
          width: 36,
          height: 36,
          borderRadius: '50%',
          background: 'rgba(220, 38, 38, 0.85)',
          color: '#fff',
          border: '1px solid rgba(255,255,255,0.15)',
          boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
          cursor: 'pointer',
          fontSize: 16,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 900,
          padding: 0,
          lineHeight: 1,
          transition: 'transform 0.15s, background 0.15s',
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.background = 'rgba(220, 38, 38, 1)';
          e.currentTarget.style.transform = 'scale(1.08)';
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.background = 'rgba(220, 38, 38, 0.85)';
          e.currentTarget.style.transform = 'scale(1)';
        }}
      >
        🐛
      </button>
    </div>
  );
}
