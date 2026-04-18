import React, { useState, useEffect, useRef, useMemo } from 'react';

export default function RightPanel({
  activeTab, liveData, streamStatus, platform, user,
  aiPrompt, onDismissPrompt, onAuthClick,
}) {
  const [sessionTimer, setSessionTimer] = useState(0);
  const timerRef = useRef(null);

  // Session timer
  useEffect(() => {
    if (liveData?.startTime) {
      timerRef.current = setInterval(() => {
        setSessionTimer(Math.floor((Date.now() - liveData.startTime) / 1000));
      }, 1000);
    }
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [liveData?.startTime]);

  const formatTime = (sec) => {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = sec % 60;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  const whaleTiers = useMemo(() => window.electronAPI?.getWhaleTiers() ?? [], []);

  return (
    <div
      className="flex-col"
      style={{
        width: 'var(--panel-w)', minWidth: 280,
        background: 'var(--bg-secondary)',
        borderLeft: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Panel Header */}
      <div className="section-header">
        <span>
          {activeTab === 'obs' ? '🎬 Scene Properties' : activeTab === 'live' ? '📊 Live Analytics' : activeTab === 'fans' ? '👥 Fan Leaderboard' : activeTab === 'ai' ? '🤖 AI Prompt Engine' : '🔗 Toy Sync'}
        </span>
      </div>

      <div className="flex-col flex-1" style={{ overflow: 'auto', padding: 8 }}>
        {activeTab === 'obs' && <OBSProperties />}
        {activeTab === 'ai' && <AIPanel user={user} onAuthClick={onAuthClick} liveData={liveData} aiPrompt={aiPrompt} onDismissPrompt={onDismissPrompt} />}
        {activeTab === 'sync' && <SyncPanel />}
        {activeTab === 'live' && (
          <LivePanel
            liveData={liveData}
            sessionTimer={sessionTimer}
            formatTime={formatTime}
            platform={platform}
            user={user}
            aiPrompt={aiPrompt}
            onDismissPrompt={onDismissPrompt}
            onAuthClick={onAuthClick}
            whaleTiers={whaleTiers}
          />
        )}
        {activeTab === 'fans' && <FansPanel liveData={liveData} whaleTiers={whaleTiers} />}
      </div>

      {/* Footer */}
      <div
        className="flex items-center justify-between"
        style={{
          padding: '6px 8px', borderTop: '1px solid var(--border)',
          fontSize: 10, color: 'var(--text-dim)',
        }}
      >
        <span>{user ? user.email : 'Not signed in'}</span>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); if (!user) onAuthClick(); }}
          style={{ color: 'var(--accent)', textDecoration: 'none', fontSize: 10 }}
        >
          {user ? '' : 'Upgrade ⚡'}
        </a>
      </div>
    </div>
  );
}

// ─── OBS Properties Sub-panel ───────────────────────────
function OBSProperties() {
  const [settings, setSettings] = useState(null);
  const [audioInputs, setAudioInputs] = useState([]);
  const [dshowAudio, setDshowAudio] = useState([]);
  const [savedToast, setSavedToast] = useState(false);
  // Auto-detect preview state. `detected` holds the {recommendations,
  // specs, encoderLabels} bundle from the main process. `selectedFields`
  // is the Set of keys the user has checked for application. Null
  // detected = panel not open.
  const [detected, setDetected] = useState(null);
  const [selectedFields, setSelectedFields] = useState(new Set());
  const [detecting, setDetecting] = useState(false);
  const debounceRef = useRef(null);
  const toastRef = useRef(null);

  useEffect(() => {
    window.electronAPI.store.get('obsSettings').then(setSettings);

    // Get browser-level audio input devices
    if (navigator.mediaDevices?.enumerateDevices) {
      navigator.mediaDevices.enumerateDevices().then((devices) => {
        setAudioInputs(devices.filter((d) => d.kind === 'audioinput'));
      }).catch(() => {});
    }

    // Get dshow device names from FFmpeg (used for actual streaming)
    window.electronAPI.sources.getDshowDevices().then((devs) => {
      if (devs?.audio?.length) setDshowAudio(devs.audio);
    }).catch(() => {});

    // When FFmpeg finishes installing mid-session, main bumps the encoder
    // from the libx264 fallback to whatever hardware encoder just became
    // available. Re-load settings so the UI mirrors the change.
    window.electronAPI.obsSettings.onAutoRefreshed(() => {
      window.electronAPI.store.get('obsSettings').then(setSettings);
    });

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (toastRef.current) clearTimeout(toastRef.current);
    };
  }, []);

  if (!settings) return <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>Loading...</div>;

  // Persist to electron-store and flash the "Saved" indicator
  const persist = (updated) => {
    window.electronAPI.store.set('obsSettings', updated);
    setSavedToast(true);
    if (toastRef.current) clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setSavedToast(false), 1800);
  };

  // Immediate save — used by selects and toggles
  const update = (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    persist(updated);
  };

  // Debounced save — used by text and number inputs to avoid saving mid-keystroke
  const updateText = (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => persist(updated), 600);
  };

  // ─── Auto-detect handlers ───────────────────────────────
  // Opens the preview panel with fresh recommendations from the main
  // process. Does NOT save anything — the user still has to click Apply.
  const handleOpenAutoDetect = async () => {
    setDetecting(true);
    try {
      const result = await window.electronAPI.obsSettings.detect();
      setDetected(result);
      // Default-check fields whose detected value actually differs from
      // what's currently saved. If nothing differs we still let the user
      // see the detected values but nothing is pre-checked.
      const diffs = new Set();
      for (const [key, recVal] of Object.entries(result.recommendations || {})) {
        if (key === 'outputPath' && settings.outputPath) continue; // respect user's recording path
        if (!objectsEqual(recVal, settings[key])) diffs.add(key);
      }
      setSelectedFields(diffs);
    } catch (err) {
      console.error('[Apex] Auto-detect failed:', err);
      alert('Auto-detect failed. See dev console for details.');
    } finally {
      setDetecting(false);
    }
  };

  // Apply the user-selected subset of recommendations. The main process
  // writes to electron-store AND stamps _encoderUserSelectedAt if
  // videoEncoder was in the fields list — that stamp protects the choice
  // from the post-FFmpeg-install encoder refresh.
  const handleApplyDetected = async () => {
    const fields = Array.from(selectedFields);
    if (fields.length === 0) {
      setDetected(null);
      return;
    }
    const merged = await window.electronAPI.obsSettings.applyDetected(fields);
    setSettings(merged);
    setDetected(null);
    setSelectedFields(new Set());
    setSavedToast(true);
    if (toastRef.current) clearTimeout(toastRef.current);
    toastRef.current = setTimeout(() => setSavedToast(false), 1800);
  };

  const toggleField = (key) => {
    setSelectedFields((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="flex-col gap-3">
      {/* Auto-save indicator */}
      <div style={{
        height: 20, display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
        paddingRight: 2, marginBottom: -4,
      }}>
        <span style={{
          fontSize: 9, fontWeight: 500, letterSpacing: '0.5px',
          color: 'var(--success, #2DD4A0)',
          opacity: savedToast ? 1 : 0,
          transition: 'opacity 0.25s ease',
          display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 5l2 2 4-4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
          SAVED
        </span>
      </div>

      {/* Output Settings */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>OUTPUT</div>
        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Stream URL</label>
        <input
          className="input" style={{ width: '100%', marginBottom: 6 }}
          value={settings.streamUrl} onChange={(e) => updateText('streamUrl', e.target.value)}
        />
        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Stream Key</label>
        <input
          className="input" style={{ width: '100%', marginBottom: 6 }}
          type="password" value={settings.streamKey} onChange={(e) => updateText('streamKey', e.target.value)}
        />
      </div>

      {/* Video Settings */}
      <div>
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)' }}>VIDEO</div>
          <button
            className="btn btn-sm"
            onClick={handleOpenAutoDetect}
            disabled={detecting || !!detected}
            style={{ fontSize: 9, padding: '2px 8px', gap: 4 }}
            title="Detect recommended video settings based on your computer"
          >
            {detecting ? '⏳ Detecting...' : '⚡ Auto-detect'}
          </button>
        </div>

        {/* Auto-detect preview panel — shown after Auto-detect is clicked */}
        {detected && (
          <AutoDetectPanel
            detected={detected}
            currentSettings={settings}
            selectedFields={selectedFields}
            onToggleField={toggleField}
            onApply={handleApplyDetected}
            onCancel={() => { setDetected(null); setSelectedFields(new Set()); }}
          />
        )}

        <div className="flex gap-2" style={{ marginBottom: 4 }}>
          <div className="flex-1">
            <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Resolution</label>
            <select
              className="input" style={{ width: '100%' }}
              value={`${settings.resolution.width}x${settings.resolution.height}`}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number);
                update('resolution', { width: w, height: h });
              }}
            >
              <option value="1920x1080">1920x1080</option>
              <option value="1280x720">1280x720</option>
              <option value="854x480">854x480</option>
              <option value="640x360">640x360</option>
            </select>
          </div>
          <div className="flex-1">
            <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>FPS</label>
            <select
              className="input" style={{ width: '100%' }}
              value={settings.fps} onChange={(e) => update('fps', parseInt(e.target.value))}
            >
              <option value="30">30</option>
              <option value="60">60</option>
              <option value="24">24</option>
            </select>
          </div>
        </div>

        <div className="flex gap-2">
          <div className="flex-1">
            <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Bitrate (kbps)</label>
            <input
              className="input" type="number" style={{ width: '100%' }}
              value={settings.videoBitrate}
              onChange={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v)) updateText('videoBitrate', v);
                else setSettings((s) => ({ ...s, videoBitrate: e.target.value }));
              }}
              onBlur={(e) => {
                const v = parseInt(e.target.value);
                if (!isNaN(v)) updateText('videoBitrate', v);
              }}
            />
          </div>
          <div className="flex-1">
            <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Encoder</label>
            <select
              className="input" style={{ width: '100%' }}
              value={settings.videoEncoder} onChange={(e) => update('videoEncoder', e.target.value)}
            >
              <option value="libx264">x264 (CPU)</option>
              <option value="h264_nvenc">NVENC (NVIDIA)</option>
              <option value="h264_amf">AMF (AMD)</option>
              <option value="h264_qsv">QuickSync (Intel)</option>
            </select>
          </div>
        </div>
      </div>

      {/* Encoder Preset */}
      <div>
        <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Encoder Preset</label>
        <select
          className="input" style={{ width: '100%' }}
          value={settings.preset} onChange={(e) => update('preset', e.target.value)}
        >
          <option value="ultrafast">Ultrafast (lowest CPU)</option>
          <option value="superfast">Superfast</option>
          <option value="veryfast">Very Fast</option>
          <option value="faster">Faster</option>
          <option value="fast">Fast</option>
          <option value="medium">Medium</option>
          <option value="slow">Slow (best quality)</option>
        </select>
      </div>

      {/* Audio */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>AUDIO</div>

        <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Audio Device</label>
        {dshowAudio.length > 0 ? (
          <select
            className="input" style={{ width: '100%', marginBottom: 4 }}
            value={settings.audioDevice || ''}
            onChange={(e) => update('audioDevice', e.target.value)}
          >
            <option value="">None (silent audio)</option>
            {dshowAudio.map((d) => (
              <option key={d.name} value={d.name}>{d.name}</option>
            ))}
          </select>
        ) : audioInputs.length > 0 ? (
          <select
            className="input" style={{ width: '100%', marginBottom: 4 }}
            value={settings.audioDevice || ''}
            onChange={(e) => update('audioDevice', e.target.value)}
          >
            <option value="">None (silent audio)</option>
            {audioInputs.map((d) => (
              <option key={d.deviceId} value={d.label}>{d.label || 'Microphone'}</option>
            ))}
          </select>
        ) : (
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 4 }}>
            No audio devices detected
          </div>
        )}

        <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Audio Bitrate (kbps)</label>
        <select
          className="input" style={{ width: '100%' }}
          value={settings.audioBitrate} onChange={(e) => update('audioBitrate', parseInt(e.target.value))}
        >
          <option value="96">96</option>
          <option value="128">128</option>
          <option value="160">160</option>
          <option value="192">192</option>
          <option value="256">256</option>
          <option value="320">320</option>
        </select>
      </div>

      {/* Recording Path */}
      <div>
        <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Recording Path</label>
        <input
          className="input" style={{ width: '100%' }}
          value={settings.outputPath} onChange={(e) => updateText('outputPath', e.target.value)}
        />
      </div>

      {/* RTMP Presets */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>QUICK PRESETS</div>
        {[
          { name: 'Chaturbate', url: 'rtmp://global.live.mmcdn.com/live-origin' },
          { name: 'Stripchat', url: 'rtmp://rtmp.stripchat.com/live' },
          { name: 'CamSoda', url: 'rtmp://live.camsoda.com/live' },
          { name: 'BongaCams', url: 'rtmp://publish.bongacams.com/live' },
          { name: 'Twitch', url: 'rtmp://live.twitch.tv/app' },
          { name: 'YouTube', url: 'rtmp://a.rtmp.youtube.com/live2' },
        ].map((preset) => (
          <div
            key={preset.name}
            className="list-item"
            onClick={() => update('streamUrl', preset.url)}
            style={{ fontSize: 10 }}
          >
            {preset.name}
            {settings.streamUrl === preset.url && <span style={{ color: 'var(--success)', marginLeft: 'auto' }}>✓</span>}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Live Analytics Sub-panel ───────────────────────────
function LivePanel({ liveData, sessionTimer, formatTime, platform, user, aiPrompt, onDismissPrompt, onAuthClick, whaleTiers }) {
  if (!user) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Sign in to track live analytics</div>
        <button className="btn btn-accent" onClick={onAuthClick}>Sign In</button>
      </div>
    );
  }

  const d = liveData || {};

  return (
    <div className="flex-col gap-3">
      {/* AI Prompt Banner */}
      {aiPrompt && (
        <div style={{
          padding: 8, background: 'var(--accent-dim)', borderRadius: 6,
          border: '1px solid var(--accent)', fontSize: 11,
        }}>
          <div className="flex items-center justify-between" style={{ marginBottom: 4 }}>
            <span className="badge badge-accent">{aiPrompt.trigger}</span>
            <button className="btn btn-sm btn-icon" onClick={onDismissPrompt} style={{ fontSize: 10 }}>✕</button>
          </div>
          <div style={{ color: 'var(--text-primary)' }}>{aiPrompt.prompt}</div>
        </div>
      )}

      {/* Stats Grid */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6,
      }}>
        <StatCard label="Tokens/Hour" value={d.tokensPerHour || 0} icon="💰" color="var(--accent)" />
        <StatCard label="Viewers" value={d.viewers || 0} icon="👁️" color="var(--success)" />
        <StatCard label="Conversion" value={`${d.conversionRate || 0}%`} icon="📈" color="var(--warning)" />
        <StatCard label="Session" value={formatTime(sessionTimer)} icon="⏱️" color="var(--text-secondary)" />
      </div>

      {/* Session Summary */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>SESSION SUMMARY</div>
        <div style={{
          display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4, fontSize: 10,
        }}>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Total Tokens</div>
            <div style={{ fontWeight: 600 }}>{d.totalTokens || 0}</div>
          </div>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Peak Viewers</div>
            <div style={{ fontWeight: 600 }}>{d.peakViewers || 0}</div>
          </div>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Avg Tip</div>
            <div style={{ fontWeight: 600 }}>{d.averageTip || 0}</div>
          </div>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Largest Tip</div>
            <div style={{ fontWeight: 600 }}>{d.largestTip || 0}</div>
          </div>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Unique Tippers</div>
            <div style={{ fontWeight: 600 }}>{d.uniqueTippers || 0}</div>
          </div>
          <div style={{ padding: 4, background: 'var(--bg-tertiary)', borderRadius: 3 }}>
            <div style={{ color: 'var(--text-dim)' }}>Platform</div>
            <div style={{ fontWeight: 600, textTransform: 'capitalize' }}>{d.platform || '—'}</div>
          </div>
        </div>
      </div>

      {/* Whale Tracker */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>🐋 WHALE TRACKER</div>
        {(!d.whales || d.whales.length === 0) ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', padding: 8 }}>
            No whales detected yet
          </div>
        ) : (
          d.whales.slice(0, 5).map((whale, i) => {
            const tier = getTier(whale.total, whaleTiers);
            return (
              <div key={i} className="list-item" style={{ fontSize: 11 }}>
                <span>{tier.emoji}</span>
                <span className="name truncate">{whale.username}</span>
                <span style={{ color: tier.color, fontWeight: 600 }}>{whale.total} tk</span>
              </div>
            );
          })
        )}
      </div>

      {/* Recent Tips */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>💎 RECENT TIPS</div>
        {(!d.recentTips || d.recentTips.length === 0) ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', padding: 8 }}>
            Waiting for tips...
          </div>
        ) : (
          d.recentTips.slice(0, 10).map((tip, i) => (
            <div key={i} className="list-item" style={{ fontSize: 10 }}>
              <span className="name truncate">{tip.username}</span>
              <span style={{ color: 'var(--accent)', fontWeight: 600 }}>{tip.amount} tk</span>
              <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>
                {new Date(tip.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ─── Fans Sub-panel ─────────────────────────────────────
function FansPanel({ liveData, whaleTiers }) {
  const fans = liveData?.fans || [];

  return (
    <div className="flex-col">
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>FAN LEADERBOARD</div>
      {fans.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', textAlign: 'center', padding: 16 }}>
          No fans detected yet. Open a cam site to start tracking.
        </div>
      ) : (
        fans.slice(0, 50).map((fan, i) => {
          const tier = getTier(fan.total, whaleTiers);
          return (
            <div key={i} className="list-item" style={{ fontSize: 11 }}>
              <span style={{ width: 18, textAlign: 'center', color: 'var(--text-dim)', fontSize: 9 }}>#{i + 1}</span>
              <span>{tier.emoji}</span>
              <span className="name truncate">{fan.username}</span>
              <span style={{ color: tier.color, fontWeight: 600, fontSize: 10 }}>{fan.total} tk</span>
            </div>
          );
        })
      )}
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────
function StatCard({ label, value, icon, color }) {
  return (
    <div style={{
      padding: 8, background: 'var(--bg-tertiary)', borderRadius: 6,
      textAlign: 'center',
    }}>
      <div style={{ fontSize: 14 }}>{icon}</div>
      <div style={{ fontSize: 16, fontWeight: 700, color, marginTop: 2 }}>{value}</div>
      <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{label}</div>
    </div>
  );
}

function getTier(total, tiers) {
  if (total >= tiers.TIER_1.min) return tiers.TIER_1;
  if (total >= tiers.TIER_2.min) return tiers.TIER_2;
  if (total >= tiers.TIER_3.min) return tiers.TIER_3;
  return tiers.TIER_4;
}

// ─── AI Prompt Engine Panel ──────────────────────────────
function AIPanel({ user, onAuthClick, liveData, aiPrompt, onDismissPrompt }) {
  const [history, setHistory] = useState([]);
  const [firing, setFiring] = useState(null);
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [promptMode, setPromptMode] = useState('bedrock');

  useEffect(() => {
    window.electronAPI.store.get('awsVoiceEnabled').then((v) => setVoiceEnabled(v ?? true));
    window.electronAPI.store.get('awsPromptMode').then((m) => setPromptMode(m ?? 'bedrock'));
  }, []);

  // Add incoming prompts to history
  useEffect(() => {
    if (aiPrompt?.prompt) {
      setHistory((prev) => [
        { trigger: aiPrompt.trigger, prompt: aiPrompt.prompt, ts: Date.now() },
        ...prev.slice(0, 19),
      ]);
    }
  }, [aiPrompt]);

  const fire = async (trigger) => {
    setFiring(trigger);
    const ctx = liveData ? {
      viewers: liveData.viewers,
      tipsToday: liveData.tipsToday,
      topFan: liveData.fans?.[0]?.username,
    } : {};
    try {
      await window.electronAPI.aws.bedrockPrompt(trigger, ctx);
    } catch {}
    setFiring(null);
  };

  const toggleVoice = (val) => {
    setVoiceEnabled(val);
    window.electronAPI.store.set('awsVoiceEnabled', val);
  };

  const TRIGGERS = [
    { key: 'deadAir',      label: 'Dead Air',          icon: '😶', desc: 'Silence on stream — prompt viewers to tip or interact' },
    { key: 'whaleTip',     label: 'Whale Tip',          icon: '🐋', desc: 'Big tipper just tipped — acknowledge and reward them' },
    { key: 'hvReturnee',   label: 'HV Returnee',        icon: '🔁', desc: 'High-value fan returned — welcome them back personally' },
    { key: 'lowTippers',   label: 'Low Energy',         icon: '📉', desc: 'Tip rate dropping — re-engage the room with a push' },
    { key: 'goalClose',    label: 'Goal Close',         icon: '🎯', desc: 'Near the tip goal — rally viewers to push you over' },
    { key: 'anchor',       label: 'Anchor Fan',         icon: '⚓', desc: 'Top fan present — spotlight them to drive more tips' },
    { key: 'tipAskPrice',  label: 'Token Tip Ask Price', icon: '💰', desc: 'Suggest the ideal token amount to ask for right now based on session stats' },
  ];

  if (!user) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>Sign in to use AI prompts</div>
        <button className="btn btn-accent" onClick={onAuthClick}>Sign In</button>
      </div>
    );
  }

  return (
    <div className="flex-col gap-3">

      {/* Current prompt */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>CURRENT PROMPT</div>
        {aiPrompt?.prompt ? (
          <div style={{
            background: 'var(--bg-tertiary)', border: '1px solid var(--accent)', borderRadius: 6,
            padding: '8px 10px', fontSize: 11, color: 'var(--text-primary)', lineHeight: 1.5,
            position: 'relative',
          }}>
            <span style={{ fontSize: 9, color: 'var(--accent)', fontWeight: 600, display: 'block', marginBottom: 4, textTransform: 'uppercase' }}>
              {aiPrompt.trigger}
            </span>
            {aiPrompt.prompt}
            <button
              onClick={onDismissPrompt}
              style={{ position: 'absolute', top: 4, right: 6, background: 'none', border: 'none', color: 'var(--text-dim)', cursor: 'pointer', fontSize: 12 }}
            >✕</button>
          </div>
        ) : (
          <div style={{ fontSize: 11, color: 'var(--text-dim)', padding: '6px 0' }}>
            No active prompt — fire a trigger below.
          </div>
        )}
      </div>

      {/* Manual triggers */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>FIRE TRIGGER</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
          {TRIGGERS.map(({ key, label, icon, desc }) => (
            <button
              key={key}
              className="btn btn-sm"
              onClick={() => fire(key)}
              disabled={!!firing}
              style={{
                fontSize: 10, flexDirection: 'column', alignItems: 'flex-start',
                gap: 2, padding: '6px 8px', height: 'auto',
                opacity: firing && firing !== key ? 0.5 : 1,
              }}
            >
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
                <span>{icon}</span>
                {firing === key ? '...' : label}
              </span>
              <span style={{ fontSize: 8, color: 'var(--text-dim)', fontWeight: 400, lineHeight: 1.4, textAlign: 'left', whiteSpace: 'normal' }}>
                {desc}
              </span>
            </button>
          ))}
        </div>
      </div>

      {/* Settings */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>SETTINGS</div>
        <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
          <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>Polly Voice Read-Aloud</span>
          <button
            className={`btn btn-sm ${voiceEnabled ? 'btn-accent' : ''}`}
            style={{ fontSize: 9, padding: '2px 8px' }}
            onClick={() => toggleVoice(!voiceEnabled)}
          >
            {voiceEnabled ? 'ON' : 'OFF'}
          </button>
        </div>
        <div>
          <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>Prompt Engine</label>
          <select
            className="input" style={{ width: '100%', fontSize: 10 }}
            value={promptMode}
            onChange={(e) => { setPromptMode(e.target.value); window.electronAPI.store.set('awsPromptMode', e.target.value); }}
          >
            <option value="bedrock">AWS Bedrock (Claude Haiku)</option>
            <option value="local">Rule-based (offline)</option>
          </select>
        </div>
      </div>

      {/* Prompt history */}
      {history.length > 0 && (
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>HISTORY</div>
          <div className="flex-col" style={{ gap: 4, maxHeight: 180, overflow: 'auto' }}>
            {history.map((h) => (
              <div key={h.ts} style={{
                background: 'var(--bg-tertiary)', borderRadius: 4, padding: '5px 8px',
                fontSize: 10, color: 'var(--text-secondary)', lineHeight: 1.5,
                borderLeft: '2px solid var(--accent)',
              }}>
                <span style={{ fontSize: 8, color: 'var(--accent)', fontWeight: 600, textTransform: 'uppercase', marginRight: 4 }}>{h.trigger}</span>
                {h.prompt}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Toy Sync Panel ──────────────────────────────────────
const PLATFORMS = [
  {
    id: 'lovense',
    name: 'Lovense',
    icon: '💜',
    desc: 'Connect via Lovense Connect app (local API)',
    docsUrl: 'https://developer.lovense.com/',
    fields: [{ key: 'apiToken', label: 'Lovense API Token', type: 'password', placeholder: 'From Lovense Connect → Settings' }],
  },
  {
    id: 'buttplug',
    name: 'Buttplug.io / Intiface',
    icon: '🔌',
    desc: 'Connect via Intiface Central websocket bridge',
    docsUrl: 'https://intiface.com/',
    fields: [{ key: 'wsUrl', label: 'Intiface Websocket URL', type: 'text', placeholder: 'ws://localhost:12345' }],
  },
  {
    id: 'ohmibod',
    name: 'OhMiBod',
    icon: '🎵',
    desc: 'Connect via OhMiBod Network API key',
    docsUrl: 'https://www.ohmibod.com/network/',
    fields: [{ key: 'apiKey', label: 'OhMiBod Network API Key', type: 'password', placeholder: 'From OhMiBod Network dashboard' }],
  },
  {
    id: 'kiiroo',
    name: 'Kiiroo / FeelConnect',
    icon: '⚡',
    desc: 'Connect via Kiiroo FeelConnect websocket',
    docsUrl: 'https://kiiroo.com/',
    fields: [{ key: 'wsUrl', label: 'FeelConnect Websocket URL', type: 'text', placeholder: 'ws://localhost:6969' }],
  },
];

// 5 renamed tiers with editable token thresholds
const DEFAULT_TIP_TIERS = [
  { label: 'Tease',     tokens: 1,   intensity: 15,  duration: 2,  color: '#38bdf8', icon: '😊' },
  { label: 'Feel It',   tokens: 10,  intensity: 35,  duration: 4,  color: '#a78bfa', icon: '💜' },
  { label: 'Intense',   tokens: 25,  intensity: 60,  duration: 6,  color: '#f59e0b', icon: '🔥' },
  { label: 'Wild',      tokens: 50,  intensity: 80,  duration: 10, color: '#f97316', icon: '⚡' },
  { label: 'MAX POWER', tokens: 100, intensity: 100, duration: 15, color: '#ef4444', icon: '🚀' },
];

// Named patterns — steps are defined in main.js; here we track token trigger + intensity scale
const DEFAULT_PATTERNS = [
  { id: 'fireworks',     label: 'Fireworks',       icon: '🎆', tokens: 50,  intensity: 100, enabled: true,  color: '#fbbf24' },
  { id: 'earthquake',    label: 'Earthquake',      icon: '🌋', tokens: 75,  intensity: 100, enabled: true,  color: '#dc2626' },
  { id: 'wave',          label: 'Wave',            icon: '🌊', tokens: 25,  intensity: 80,  enabled: true,  color: '#0ea5e9' },
  { id: 'pulse',         label: 'Pulse',           icon: '💓', tokens: 15,  intensity: 75,  enabled: true,  color: '#ec4899' },
  { id: 'maxvibe',       label: 'Maxvibe',         icon: '⚡', tokens: 100, intensity: 100, enabled: true,  color: '#ef4444' },
  { id: 'stopthequiver', label: 'Stop The Quiver', icon: '✋', tokens: 0,   intensity: 0,   enabled: false, color: '#6b7280' },
];

function SyncPanel() {
  const api = window.electronAPI;
  const [connections, setConnections]   = useState({});
  const [tiers, setTiers]               = useState(DEFAULT_TIP_TIERS);
  const [patterns, setPatterns]         = useState(DEFAULT_PATTERNS);
  const [syncEnabled, setSyncEnabled]   = useState(false);
  const [testPlatform, setTestPlatform] = useState(null);
  const [firingPattern, setFiringPattern] = useState(null);
  const [expandedPlatform, setExpandedPlatform] = useState(null);
  const [activeSection, setActiveSection] = useState('tiers'); // 'tiers' | 'patterns'

  useEffect(() => {
    api.store.get('toySyncConfig').then((cfg) => {
      if (cfg) {
        setConnections(cfg.connections || {});
        setTiers(cfg.tiers?.length ? cfg.tiers : DEFAULT_TIP_TIERS);
        setPatterns(cfg.patterns?.length ? cfg.patterns : DEFAULT_PATTERNS);
        setSyncEnabled(cfg.enabled || false);
      }
    });
  }, []);

  // Save full config to store + sync tiers/patterns to backend
  const save = (opts = {}) => {
    const newConns    = opts.connections ?? connections;
    const newTiers    = opts.tiers       ?? tiers;
    const newPatterns = opts.patterns    ?? patterns;
    const newEnabled  = opts.enabled     ?? syncEnabled;

    const cfg = { connections: newConns, tiers: newTiers, patterns: newPatterns, enabled: newEnabled };
    api.store.set('toySyncConfig', cfg);

    // Also push to backend tip-map so auto-fire works immediately
    api.sync.saveTipMap({
      enabled: newEnabled,
      tiers: newTiers.map((t) => ({ label: t.label, minTokens: t.tokens, intensity: t.intensity, duration: t.duration })),
      patterns: newPatterns.map((p) => ({ id: p.id, label: p.label, tokens: p.tokens, intensity: p.intensity, enabled: p.enabled })),
    }).catch(() => {});
  };

  const togglePlatform = (id, enabled) => {
    const c = { ...connections, [id]: { ...(connections[id] || {}), enabled } };
    setConnections(c);
    save({ connections: c });
  };

  const setField = (id, key, val) => {
    const c = { ...connections, [id]: { ...(connections[id] || {}), [key]: val } };
    setConnections(c);
    save({ connections: c });
  };

  const testVibrate = (id) => {
    setTestPlatform(id);
    setTimeout(() => setTestPlatform(null), 2500);
    api.sync.vibrate(50, 2).catch(() => {});
  };

  // Tiers
  const updateTier = (idx, field, raw) => {
    const num = Math.max(0, parseInt(raw) || 0);
    const clamped = field === 'tokens' ? num
      : field === 'intensity' ? Math.min(100, num)
      : Math.min(120, Math.max(1, num));
    const updated = tiers.map((t, i) => i === idx ? { ...t, [field]: clamped } : t);
    setTiers(updated);
    save({ tiers: updated });
  };

  // Patterns
  const updatePattern = (idx, field, raw) => {
    let val = raw;
    if (field === 'tokens')    val = Math.max(0, parseInt(raw) || 0);
    if (field === 'intensity') val = Math.min(100, Math.max(0, parseInt(raw) || 0));
    if (field === 'enabled')   val = raw; // boolean
    const updated = patterns.map((p, i) => i === idx ? { ...p, [field]: val } : p);
    setPatterns(updated);
    save({ patterns: updated });
  };

  const firePattern = async (pattern, idx) => {
    setFiringPattern(idx);
    try { await api.sync.firePattern(pattern.id, pattern.intensity); } catch {}
    setTimeout(() => setFiringPattern(null), 500);
  };

  const anyEnabled = Object.values(connections).some((c) => c.enabled);

  return (
    <div className="flex-col gap-3">

      {/* ── Master toggle ─────────────────────────────────── */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 10px',
        background: syncEnabled ? 'rgba(139,92,246,0.12)' : 'var(--bg-tertiary)',
        border: `1px solid ${syncEnabled ? 'rgba(139,92,246,0.4)' : 'var(--border)'}`,
        borderRadius: 8,
      }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: syncEnabled ? '#a78bfa' : 'var(--text-secondary)' }}>
            Tip-to-Toy Sync {syncEnabled ? '● ACTIVE' : '○ OFF'}
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 2 }}>
            Auto-vibrate connected toys on incoming tips
          </div>
        </div>
        <button
          className={`btn btn-sm ${syncEnabled ? 'btn-accent' : ''}`}
          style={{ fontSize: 9, padding: '3px 12px', background: syncEnabled ? '#7c3aed' : undefined }}
          onClick={() => { const e = !syncEnabled; setSyncEnabled(e); save({ enabled: e }); }}
        >
          {syncEnabled ? 'ON' : 'OFF'}
        </button>
      </div>

      {/* ── Platform connections ───────────────────────────── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>PLATFORMS</div>
        <div className="flex-col" style={{ gap: 4 }}>
          {PLATFORMS.map((p) => {
            const conn       = connections[p.id] || {};
            const isExpanded = expandedPlatform === p.id;
            const isTesting  = testPlatform === p.id;
            return (
              <div key={p.id} style={{
                background: 'var(--bg-tertiary)', borderRadius: 7, overflow: 'hidden',
                border: `1px solid ${conn.enabled ? 'rgba(139,92,246,0.35)' : 'var(--border)'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px' }}>
                  <span style={{ fontSize: 14 }}>{p.icon}</span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 11, fontWeight: 600 }}>{p.name}</div>
                    <div style={{ fontSize: 8, color: 'var(--text-dim)', marginTop: 1 }}>{p.desc}</div>
                  </div>
                  {conn.enabled && (
                    <button className="btn btn-sm"
                      onClick={() => testVibrate(p.id)}
                      style={{ fontSize: 8, padding: '2px 6px', color: isTesting ? '#4ade80' : undefined }}
                    >
                      {isTesting ? '✓' : '⚡ Test'}
                    </button>
                  )}
                  <button className="btn btn-sm"
                    onClick={() => setExpandedPlatform(isExpanded ? null : p.id)}
                    style={{ fontSize: 9, padding: '2px 6px' }}
                  >
                    {isExpanded ? '▲' : '▼'}
                  </button>
                  <button
                    className={`btn btn-sm ${conn.enabled ? 'btn-accent' : ''}`}
                    style={{ fontSize: 9, padding: '2px 8px', background: conn.enabled ? '#7c3aed' : undefined }}
                    onClick={() => togglePlatform(p.id, !conn.enabled)}
                  >
                    {conn.enabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                {isExpanded && (
                  <div style={{ padding: '0 10px 10px', borderTop: '1px solid var(--border)' }}>
                    {p.fields.map(({ key, label, type, placeholder }) => (
                      <div key={key} style={{ marginTop: 8 }}>
                        <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>{label}</label>
                        <input className="input" type={type} style={{ width: '100%', marginTop: 2 }}
                          placeholder={placeholder} value={conn[key] || ''}
                          onChange={(e) => setField(p.id, key, e.target.value)} />
                      </div>
                    ))}
                    <a href={p.docsUrl} target="_blank" rel="noreferrer"
                      style={{ fontSize: 8, color: 'var(--accent)', textDecoration: 'none', display: 'block', marginTop: 6 }}>
                      ↗ Setup docs
                    </a>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* ── Section tabs ──────────────────────────────────── */}
      <div style={{ display: 'flex', gap: 4 }}>
        {[['tiers', '🎚️ Tiers'], ['patterns', '🎛️ Patterns']].map(([key, label]) => (
          <button key={key}
            onClick={() => setActiveSection(key)}
            style={{
              flex: 1, padding: '5px 0', fontSize: 10, fontWeight: 600,
              background: activeSection === key ? 'rgba(139,92,246,0.18)' : 'var(--bg-tertiary)',
              border: `1px solid ${activeSection === key ? 'rgba(139,92,246,0.5)' : 'var(--border)'}`,
              color: activeSection === key ? '#a78bfa' : 'var(--text-secondary)',
              borderRadius: 6, cursor: 'pointer',
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {/* ── Tip Tiers ────────────────────────────────────── */}
      {activeSection === 'tiers' && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>
            Set token threshold, intensity (0–100%) and duration per tier. Tiers fire when a tip ≥ token amount and no pattern matches.
          </div>
          <div className="flex-col" style={{ gap: 5 }}>
            {tiers.map((tier, idx) => (
              <div key={tier.label} style={{
                background: 'var(--bg-tertiary)',
                border: `1px solid var(--border)`,
                borderLeft: `3px solid ${tier.color}`,
                borderRadius: 6, padding: '8px 10px',
              }}>
                {/* Tier header */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                    <span style={{ fontSize: 13 }}>{tier.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: tier.color }}>{tier.label}</span>
                  </div>
                  {/* Intensity mini-bar */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{
                      width: 50, height: 4, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden',
                    }}>
                      <div style={{ width: `${tier.intensity}%`, height: '100%', background: tier.color, borderRadius: 2 }} />
                    </div>
                    <span style={{ fontSize: 9, color: tier.color, fontWeight: 600 }}>{tier.intensity}%</span>
                  </div>
                </div>

                {/* 3-field row */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 5 }}>
                  <TierField label="Tokens ≥" value={tier.tokens} min={0} max={9999}
                    onChange={(v) => updateTier(idx, 'tokens', v)} suffix="tk" />
                  <TierField label="Intensity" value={tier.intensity} min={0} max={100}
                    onChange={(v) => updateTier(idx, 'intensity', v)} suffix="%" />
                  <TierField label="Duration" value={tier.duration} min={1} max={120}
                    onChange={(v) => updateTier(idx, 'duration', v)} suffix="s" />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Custom Patterns ──────────────────────────────── */}
      {activeSection === 'patterns' && (
        <div>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8 }}>
            Patterns override tiers when a tip exactly matches the token amount. Set tokens to 0 to disable auto-fire (manual-only).
          </div>
          <div className="flex-col" style={{ gap: 5 }}>
            {patterns.map((p, idx) => {
              const isFiring = firingPattern === idx;
              const isStop   = p.id === 'stopthequiver';
              return (
                <div key={p.id} style={{
                  background: 'var(--bg-tertiary)',
                  border: `1px solid ${p.enabled ? p.color + '55' : 'var(--border)'}`,
                  borderLeft: `3px solid ${p.color}`,
                  borderRadius: 6, padding: '8px 10px',
                  opacity: p.enabled || isStop ? 1 : 0.55,
                }}>
                  {/* Pattern header */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 16 }}>{p.icon}</span>
                      <div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: p.color }}>{p.label}</div>
                        <div style={{ fontSize: 8, color: 'var(--text-dim)', marginTop: 1 }}>
                          {isStop ? 'Stops all vibration immediately' : 'Custom vibration sequence'}
                        </div>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
                      {/* Fire / Stop button */}
                      <button
                        onClick={() => firePattern(p, idx)}
                        style={{
                          padding: '3px 9px', fontSize: 9, fontWeight: 700, borderRadius: 4,
                          background: isFiring ? p.color : 'transparent',
                          border: `1px solid ${p.color}`,
                          color: isFiring ? '#fff' : p.color,
                          cursor: 'pointer', transition: 'all 0.15s',
                        }}
                      >
                        {isStop ? '✋ Stop' : isFiring ? '●' : '▶ Fire'}
                      </button>
                      {/* Enable toggle (not for stop-the-quiver) */}
                      {!isStop && (
                        <button
                          onClick={() => updatePattern(idx, 'enabled', !p.enabled)}
                          style={{
                            padding: '3px 7px', fontSize: 9, borderRadius: 4, cursor: 'pointer',
                            background: p.enabled ? '#7c3aed' : 'transparent',
                            border: `1px solid ${p.enabled ? '#7c3aed' : 'var(--border)'}`,
                            color: p.enabled ? '#fff' : 'var(--text-dim)',
                          }}
                        >
                          {p.enabled ? 'ON' : 'OFF'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Token + Intensity fields */}
                  {!isStop && (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 5 }}>
                      <TierField label="Trigger (exact tk)" value={p.tokens} min={0} max={9999}
                        onChange={(v) => updatePattern(idx, 'tokens', v)} suffix="tk"
                        dimLabel={p.tokens === 0 ? 'manual only' : undefined} />
                      <TierField label="Intensity" value={p.intensity} min={0} max={100}
                        onChange={(v) => updatePattern(idx, 'intensity', v)} suffix="%" />
                    </div>
                  )}

                  {/* Intensity bar for non-stop patterns */}
                  {!isStop && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ width: '100%', height: 3, background: 'var(--bg-secondary)', borderRadius: 2, overflow: 'hidden' }}>
                        <div style={{ width: `${p.intensity}%`, height: '100%', background: p.color, borderRadius: 2, transition: 'width 0.2s' }} />
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Status bar ───────────────────────────────────── */}
      {syncEnabled && !anyEnabled && (
        <div style={{ fontSize: 9, color: '#fbbf24', padding: '6px 10px', background: 'rgba(251,191,36,0.08)', borderRadius: 6, border: '1px solid rgba(251,191,36,0.2)' }}>
          ⚠ Sync is ON but no platforms are enabled above.
        </div>
      )}
      {syncEnabled && anyEnabled && (
        <div style={{ fontSize: 9, color: '#4ade80', padding: '6px 10px', background: 'rgba(74,222,128,0.08)', borderRadius: 6, border: '1px solid rgba(74,222,128,0.2)' }}>
          ✓ Sync active — incoming tips trigger connected toys automatically.
        </div>
      )}
    </div>
  );
}

// ── Shared small number field for tier / pattern editing ──
function TierField({ label, value, min, max, onChange, suffix, dimLabel }) {
  return (
    <div>
      <label style={{ fontSize: 8, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>
        {label}
        {dimLabel && <span style={{ color: '#ef4444', marginLeft: 4 }}>{dimLabel}</span>}
      </label>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <input
          className="input" type="number" min={min} max={max}
          style={{ flex: 1, padding: '2px 4px', fontSize: 10 }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <span style={{ fontSize: 8, color: 'var(--text-dim)', whiteSpace: 'nowrap' }}>{suffix}</span>
      </div>
    </div>
  );
}

// ─── Auto-detect Preview Panel ───────────────────────────
// Shown inline in the OBS VIDEO section when the user clicks Auto-detect.
// Displays what was detected about their machine, lists each recommendation
// alongside the current value, and lets them check off which fields to
// apply. Fields where detected == current are shown as "✓ already set"
// and are disabled. Apply writes to electron-store via main; user edits
// made after applying are preserved on future app starts.
function AutoDetectPanel({ detected, currentSettings, selectedFields, onToggleField, onApply, onCancel }) {
  const { recommendations, specs, encoderLabels } = detected;
  // Fields the user can choose to apply. Intentionally omits streamUrl,
  // streamKey, audioDevice, outputPath — those are personal/platform
  // choices, not hardware-derived.
  const applicableFields = [
    { key: 'videoEncoder', label: 'Video Encoder', render: (v) => encoderLabels?.[v] || v },
    { key: 'videoBitrate', label: 'Video Bitrate', render: (v) => `${v} kbps` },
    { key: 'resolution',   label: 'Resolution',    render: (v) => `${v.width}×${v.height}` },
    { key: 'fps',          label: 'Frame Rate',    render: (v) => `${v} fps` },
    { key: 'preset',       label: 'Encoder Preset',render: (v) => v },
    { key: 'audioBitrate', label: 'Audio Bitrate', render: (v) => `${v} kbps` },
  ];

  const numSelected = selectedFields.size;

  return (
    <div style={{
      background: 'var(--bg-tertiary)',
      border: '1px solid var(--accent, #7c5cfc)',
      borderRadius: 6,
      padding: 10,
      marginBottom: 10,
      fontSize: 11,
    }}>
      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--accent, #7c5cfc)', marginBottom: 6 }}>
        ⚡ DETECTED
      </div>

      {/* Specs line */}
      <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.5 }}>
        {specs.cpuModel && <div>{specs.cpuModel} · {specs.cpuCores} cores · {specs.totalRamGb} GB RAM</div>}
        <div>
          Encoders available:{' '}
          {specs.detectedEncoders?.length
            ? specs.detectedEncoders.map((e) => encoderLabels?.[e] || e).join(', ')
            : <span style={{ color: 'var(--warning, #ffa502)' }}>FFmpeg not installed yet — detection limited</span>
          }
        </div>
      </div>

      {/* Per-field checklist */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 10 }}>
        {applicableFields.map(({ key, label, render }) => {
          const recVal = recommendations[key];
          const curVal = currentSettings[key];
          const sameAsCurrent = objectsEqual(recVal, curVal);
          const isChecked = selectedFields.has(key);
          return (
            <label
              key={key}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '3px 6px', borderRadius: 3,
                background: isChecked ? 'rgba(124,92,252,0.08)' : 'transparent',
                opacity: sameAsCurrent ? 0.55 : 1,
                cursor: sameAsCurrent ? 'default' : 'pointer',
                fontSize: 10,
              }}
            >
              <input
                type="checkbox"
                checked={isChecked}
                disabled={sameAsCurrent}
                onChange={() => onToggleField(key)}
                style={{ margin: 0, cursor: sameAsCurrent ? 'default' : 'pointer' }}
              />
              <span style={{ flex: 1, color: 'var(--text-secondary)' }}>{label}</span>
              <span style={{ fontFamily: 'monospace', color: 'var(--text-dim)', fontSize: 9 }}>
                {curVal !== undefined ? render(curVal) : '—'}
              </span>
              <span style={{ color: 'var(--text-dim)', fontSize: 9 }}>→</span>
              <span style={{
                fontFamily: 'monospace',
                color: sameAsCurrent ? 'var(--text-dim)' : 'var(--accent, #7c5cfc)',
                fontSize: 9,
                fontWeight: 600,
              }}>
                {render(recVal)}{sameAsCurrent && ' ✓'}
              </span>
            </label>
          );
        })}
      </div>

      {/* Actions */}
      <div className="flex gap-2 justify-between items-center">
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>
          {numSelected === 0
            ? 'Nothing to apply — all recommendations match your current settings.'
            : `${numSelected} field${numSelected === 1 ? '' : 's'} will be overwritten.`
          }
        </span>
        <div className="flex gap-1">
          <button className="btn btn-sm" onClick={onCancel} style={{ fontSize: 10 }}>
            Cancel
          </button>
          <button
            className="btn btn-sm btn-accent"
            onClick={onApply}
            disabled={numSelected === 0}
            style={{ fontSize: 10 }}
          >
            Apply {numSelected > 0 ? `(${numSelected})` : ''}
          </button>
        </div>
      </div>
    </div>
  );
}

// Deep-equals helper for comparing recommendation values vs current
// settings. Handles primitives and plain objects (resolution: {w, h}).
// Not a general-purpose deep equals — only needs to match what
// autoconfig.js produces.
function objectsEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return a === b;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) if (a[k] !== b[k]) return false;
  return true;
}
