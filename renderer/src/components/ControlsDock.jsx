import React, { useState, useEffect } from 'react';

const api = window.electronAPI;

export default function ControlsDock({
  streamStatus, onStartStream, onStopStream,
  onStartRecord, onStopRecord, onToggleVirtualCam,
  onSettingsClick, activeTab, onTabChange,
}) {
  const [audioDevices, setAudioDevices] = useState([]);
  const [audioLevels, setAudioLevels] = useState({});
  const [transition, setTransition] = useState('fade');
  const [transitionDuration, setTransitionDuration] = useState(300);

  // Poll audio levels
  useEffect(() => {
    const interval = setInterval(async () => {
      try {
        const devices = await api.audio.getDevices();
        setAudioDevices(devices);
        const levels = await api.audio.getLevels();
        setAudioLevels(levels);
      } catch {}
    }, 200);
    return () => clearInterval(interval);
  }, []);

  const dbToPercent = (db) => {
    if (db <= -60) return 0;
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  };

  return (
    <div
      className="flex-col"
      style={{
        height: 'var(--controls-h)', minHeight: 200,
        background: 'var(--bg-secondary)',
        borderTop: '1px solid var(--border)',
      }}
    >
      {/* Tab Bar */}
      <div className="flex items-center" style={{ height: 28, borderBottom: '1px solid var(--border)', padding: '0 4px' }}>
        {['obs', 'live', 'fans', 'ai', 'coach', 'sync', 'beauty'].map((tab) => (
          <button
            key={tab}
            className={`btn btn-sm ${activeTab === tab ? 'btn-accent' : ''}`}
            style={{ borderRadius: 0, fontSize: 10, textTransform: 'uppercase' }}
            onClick={() => onTabChange(tab)}
          >
            {tab === 'obs' ? '🎬 OBS' : tab === 'live' ? '📊 Live' : tab === 'fans' ? '👥 Fans' : tab === 'ai' ? '🤖 AI' : tab === 'coach' ? '💬 Coach' : tab === 'sync' ? '🔗 Sync' : '✨ Filters'}
          </button>
        ))}
        <div className="flex-1" />
      </div>

      {/* Controls Content */}
      <div className="flex flex-1" style={{ overflow: 'hidden' }}>
        {/* Audio Mixer */}
        <div className="flex-col" style={{ width: 300, borderRight: '1px solid var(--border)', overflow: 'auto' }}>
          <div className="section-header"><span>Audio Mixer</span></div>
          <div className="flex-1" style={{ padding: 8, overflow: 'auto' }}>
            {audioDevices.map((device) => (
              <div key={device.id} style={{ marginBottom: 12 }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>
                    {device.type === 'output' ? '🔊' : '🎤'} {device.name}
                  </span>
                  <button
                    className="btn btn-sm btn-icon"
                    onClick={() => api.audio.setMuted(device.id, !device.muted)}
                    style={{ opacity: device.muted ? 0.3 : 1 }}
                  >
                    {device.muted ? '🔇' : (device.type === 'output' ? '🔊' : '🎤')}
                  </button>
                </div>
                {/* Level meter */}
                <div className="flex gap-1" style={{ marginBottom: 4 }}>
                  <div className="audio-meter flex-1">
                    <div
                      className="audio-meter-fill"
                      style={{ width: `${dbToPercent(audioLevels[device.id]?.left || -60)}%` }}
                    />
                  </div>
                  <div className="audio-meter flex-1">
                    <div
                      className="audio-meter-fill"
                      style={{ width: `${dbToPercent(audioLevels[device.id]?.right || -60)}%` }}
                    />
                  </div>
                </div>
                {/* Volume slider */}
                <input
                  type="range"
                  className="volume-slider"
                  min="0" max="100"
                  value={Math.round(device.volume * 100)}
                  onChange={(e) => api.audio.setVolume(device.id, parseInt(e.target.value) / 100)}
                />
              </div>
            ))}
          </div>
        </div>

        {/* Transitions */}
        <div className="flex-col" style={{ width: 160, borderRight: '1px solid var(--border)' }}>
          <div className="section-header"><span>Transitions</span></div>
          <div style={{ padding: 8 }}>
            {['cut', 'fade', 'slide', 'swipe', 'stinger'].map((t) => (
              <div
                key={t}
                className={`list-item ${transition === t ? 'active' : ''}`}
                onClick={() => setTransition(t)}
                style={{ fontSize: 11 }}
              >
                {t === 'cut' ? '⚡' : t === 'fade' ? '🌗' : t === 'slide' ? '➡️' : t === 'swipe' ? '🔄' : '🎬'}{' '}
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </div>
            ))}
            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Duration (ms)</label>
              <input
                type="number"
                className="input"
                value={transitionDuration}
                onChange={(e) => setTransitionDuration(parseInt(e.target.value) || 300)}
                style={{ width: '100%', marginTop: 2 }}
              />
            </div>
          </div>
        </div>

        {/* Stream Controls */}
        <div className="flex-col flex-1">
          <div className="section-header"><span>Controls</span></div>
          <div style={{ padding: 12 }} className="flex-col gap-2">
            {/* Stream */}
            <div className="flex gap-2">
              {streamStatus.streaming ? (
                <button className="btn btn-danger flex-1" onClick={onStopStream}>
                  ⏹️ Stop Streaming
                </button>
              ) : (
                <button className="btn btn-accent flex-1" onClick={onStartStream}>
                  📡 Start Streaming
                </button>
              )}
            </div>

            {/* Record */}
            <div className="flex gap-2">
              {streamStatus.recording ? (
                <button className="btn btn-danger flex-1" onClick={onStopRecord}>
                  ⏹️ Stop Recording
                </button>
              ) : (
                <button className="btn flex-1" onClick={onStartRecord}>
                  ⏺️ Start Recording
                </button>
              )}
            </div>

            {/* Virtual Cam */}
            <button
              className={`btn ${streamStatus.virtualCam ? 'btn-accent' : ''}`}
              onClick={onToggleVirtualCam}
            >
              📸 Virtual Camera {streamStatus.virtualCam ? 'ON' : 'OFF'}
            </button>

            {/* Settings */}
            <button className="btn" onClick={onSettingsClick}>
              ⚙️ Settings
            </button>

            {/* Stream Stats */}
            {streamStatus.streaming && (
              <div style={{ marginTop: 8, padding: 8, background: 'var(--bg-tertiary)', borderRadius: 4 }}>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', marginBottom: 4 }}>Stream Stats</div>
                <div className="flex justify-between" style={{ fontSize: 11 }}>
                  <span>FPS: {streamStatus.fps || 0}</span>
                  <span>Bitrate: {streamStatus.bitrate || 0} kbps</span>
                </div>
                <div className="flex justify-between" style={{ fontSize: 11, marginTop: 2 }}>
                  <span>Dropped: {streamStatus.droppedFrames || 0}</span>
                  <span>CPU: {streamStatus.cpuUsage || 0}%</span>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
