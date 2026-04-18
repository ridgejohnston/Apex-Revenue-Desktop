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
  const [aiPrompt, setAiPrompt] = useState(null);
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

      // Check auth
      const session = await api.aws.getSession();
      if (session) setUser(session);

      // Get stream status
      const status = await api.stream.getStatus();
      setStreamStatus(status);

      // Check FFmpeg
      const ffmpeg = await api.ffmpeg.check();
      setFfmpegStatus(ffmpeg);
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
    let stream = null;
    try {
      if (type === 'webcam') {
        const constraints = {
          video: properties.deviceId
            ? { deviceId: { exact: properties.deviceId }, width: 1920, height: 1080 }
            : { width: 1920, height: 1080 },
          audio: false,
        };
        stream = await navigator.mediaDevices.getUserMedia(constraints);

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
    }

    if (stream) {
      sourceStreamsRef.current[id] = stream;
      setSourceStreams((prev) => ({ ...prev, [id]: stream }));
    }
  }, []);

  // Stop capture and release device when a source is removed
  const deactivateSource = useCallback((sourceId) => {
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

        // Ask main to spawn FFmpeg listening on stdin BEFORE we start
        // the MediaRecorder. If we start the recorder first, the
        // first chunk or two might arrive before FFmpeg is ready and
        // get dropped — Matroska parsers are unforgiving about
        // missing EBML headers.
        await api.stream.startPipe(settings);

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
        recorder.ondataavailable = async (e) => {
          if (!e.data || e.data.size === 0) return;
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
        };
        recorder.onstop = () => {
          console.log('[Apex] MediaRecorder stopped');
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
      alert('Stream failed to start: ' + (e.message || e));
    }
  }, [ffmpegStatus, scenes, activeSceneId]);

  const handleStopStream = useCallback(async () => {
    // If we're pipe-streaming a webcam, stop the recorder first so
    // stdin receives a clean EOF after the last chunk flushes. Then
    // tell main to end the FFmpeg process. Order matters: stopping
    // FFmpeg first would leave the recorder trying to write to a
    // closed pipe, spamming EPIPE errors.
    const recorder = webcamRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      try { recorder.stop(); } catch {}
      webcamRecorderRef.current = null;
      await api.stream.stopPipe();
      return;
    }
    await api.stream.stop();
  }, []);

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
  const handleSignIn = useCallback(async (email, password) => {
    const result = await api.aws.signIn(email, password);
    if (result.success) {
      setUser({ email: result.email });
      setShowAuth(false);
    }
    return result;
  }, []);

  const handleSignOut = useCallback(async () => {
    await api.aws.signOut();
    setUser(null);
  }, []);

  // ─── Derived State ────────────────────────────────────
  const activeScene = scenes.find((s) => s.id === activeSceneId) || scenes[0];

  // ─── Render ───────────────────────────────────────────
  return (
    <div className="flex-col" style={{ width: '100%', height: '100%' }}>
      {/* Hidden audio player for Polly */}
      <audio ref={audioRef} style={{ display: 'none' }} />

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
        />
      </div>

      {/* Modals */}
      {showAuth && (
        <AuthModal onSignIn={handleSignIn} onClose={() => setShowAuth(false)} />
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
