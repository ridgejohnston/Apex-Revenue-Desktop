import React, { useState, useEffect, useCallback, useRef } from 'react';
import Titlebar from './components/Titlebar';
import Sidebar from './components/Sidebar';
import PreviewCanvas from './components/PreviewCanvas';
import ControlsDock from './components/ControlsDock';
import RightPanel from './components/RightPanel';
import AuthModal from './components/AuthModal';
import SettingsModal from './components/SettingsModal';
import AddSourceModal from './components/AddSourceModal';

const api = window.electronAPI;

// ─── Error Boundary ────────────────────────────────────────
export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
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
            maxWidth: 600, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
          }}>
            {this.state.error?.message}
            {'\n\n'}
            {this.state.error?.stack}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20, padding: '8px 20px', background: '#6366f1', color: '#fff',
              border: 'none', borderRadius: 4, cursor: 'pointer', fontSize: 12,
            }}
          >
            Reload App
          </button>
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

  const handleAddSource = useCallback(async (sourceConfig) => {
    if (!activeSceneId) return;
    const source = await api.sources.add(activeSceneId, sourceConfig);
    setShowAddSource(false);
    if (!source) return;

    // Auto-activate immediately after adding
    activateSource(source);

    // v3.3.6: if the newly added source is a video-capture type, sync
    // obsSettings so Start Stream picks it up immediately. Mirrors the
    // logic in handleToggleSourceVisible so both entry points converge
    // on the same settings state.
    const VIDEO_CAPTURE_TYPES = new Set([
      'webcam', 'screen_capture', 'window_capture', 'game_capture',
    ]);
    if (VIDEO_CAPTURE_TYPES.has(source.type)) {
      const current = (await api.store.get('obsSettings')) || {};
      const patch = source.type === 'webcam'
        ? {
            videoSource: 'webcam',
            webcamDevice: source.properties?.deviceLabel || source.properties?.deviceName || '',
          }
        : { videoSource: 'screen' };
      await api.store.set('obsSettings', { ...current, ...patch });
    }
  }, [activeSceneId, activateSource]);

  const handleRemoveSource = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    deactivateSource(sourceId);
    await api.sources.remove(activeSceneId, sourceId);
  }, [activeSceneId, deactivateSource]);

  const handleToggleSourceVisible = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    const scene = scenes.find((s) => s.id === activeSceneId);
    if (!scene) return;
    const target = (scene.sources || []).find((s) => s.id === sourceId);
    if (!target) {
      await api.sources.toggleVisible(activeSceneId, sourceId);
      return;
    }

    // v3.3.6: video-capture sources are mutually exclusive. FFmpeg's
    // input pipeline can only read one -i video source at a time, so
    // the sidebar ON toggle behaves as a radio for this category.
    // Toggling a video source ON automatically turns OFF every other
    // video source in the scene. Non-video sources (overlays, audio,
    // text, browser, alerts) keep their independent ON/OFF behavior.
    const VIDEO_CAPTURE_TYPES = new Set([
      'webcam', 'screen_capture', 'window_capture', 'game_capture',
    ]);
    const isVideoCapture = VIDEO_CAPTURE_TYPES.has(target.type);
    const goingVisible = !target.visible;

    if (isVideoCapture && goingVisible) {
      // Turn off every OTHER video-capture source that's currently on.
      // Run these in parallel — scene-manager debounces its writes so
      // the batch is safe.
      const others = (scene.sources || []).filter(
        (s) => s.id !== sourceId && s.visible && VIDEO_CAPTURE_TYPES.has(s.type)
      );
      await Promise.all(others.map((s) => api.sources.toggleVisible(activeSceneId, s.id)));
    }

    // Toggle the target source itself
    await api.sources.toggleVisible(activeSceneId, sourceId);

    // Sync obsSettings.videoSource / webcamDevice to match what the
    // stream engine will actually capture from. The stream engine reads
    // obsSettings directly at startStream time, so these fields need to
    // be up-to-date the moment the user hits Start Stream.
    if (isVideoCapture) {
      const current = (await api.store.get('obsSettings')) || {};
      let patch;
      if (goingVisible) {
        if (target.type === 'webcam') {
          patch = {
            videoSource: 'webcam',
            // AddSourceModal saves the dshow-compatible label as
            // properties.deviceLabel; prefer it over deviceId (which is
            // a getUserMedia hash that FFmpeg can't resolve).
            webcamDevice: target.properties?.deviceLabel || target.properties?.deviceName || '',
          };
        } else {
          // screen_capture, window_capture, game_capture — all route
          // through gdigrab for now. window/game capture specialization
          // is a future enhancement; today they fall back to full desktop.
          patch = { videoSource: 'screen' };
        }
      } else {
        // User turned OFF the currently-active video source. Fall back
        // to 'screen' as the safe default so Start Stream doesn't fail
        // with an empty/invalid config.
        patch = { videoSource: 'screen' };
      }
      await api.store.set('obsSettings', { ...current, ...patch });
    }
  }, [activeSceneId, scenes]);

  const handleToggleSourceLock = useCallback(async (sourceId) => {
    if (!activeSceneId) return;
    await api.sources.toggleLock(activeSceneId, sourceId);
  }, [activeSceneId]);

  // ─── Stream / Record ──────────────────────────────────
  const handleStartStream = useCallback(async () => {
    if (ffmpegStatus && !ffmpegStatus.installed) {
      alert('FFmpeg is required for streaming. Please install it using the banner at the top.');
      return;
    }
    try {
      // Pass current obsSettings so stream-engine gets the config
      const settings = await api.store.get('obsSettings');
      await api.stream.start(settings);
    }
    catch (e) { console.error('Stream start error:', e); }
  }, [ffmpegStatus]);

  const handleStopStream = useCallback(async () => {
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
    </div>
  );
}
