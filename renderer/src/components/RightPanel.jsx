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
          {activeTab === 'obs' ? '🎬 Scene Properties' : activeTab === 'live' ? '📊 Live Analytics' : '👥 Fan Leaderboard'}
        </span>
      </div>

      <div className="flex-col flex-1" style={{ overflow: 'auto', padding: 8 }}>
        {activeTab === 'obs' && <OBSProperties />}
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

  useEffect(() => {
    window.electronAPI.store.get('obsSettings').then(setSettings);
  }, []);

  if (!settings) return <div style={{ padding: 12, color: 'var(--text-dim)', fontSize: 11 }}>Loading...</div>;

  const update = (key, value) => {
    const updated = { ...settings, [key]: value };
    setSettings(updated);
    window.electronAPI.store.set('obsSettings', updated);
  };

  return (
    <div className="flex-col gap-3">
      {/* Output Settings */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>OUTPUT</div>
        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Stream URL</label>
        <input
          className="input" style={{ width: '100%', marginBottom: 6 }}
          value={settings.streamUrl} onChange={(e) => update('streamUrl', e.target.value)}
        />
        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Stream Key</label>
        <input
          className="input" style={{ width: '100%', marginBottom: 6 }}
          type="password" value={settings.streamKey} onChange={(e) => update('streamKey', e.target.value)}
        />
      </div>

      {/* Video Settings */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>VIDEO</div>
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
              value={settings.videoBitrate} onChange={(e) => update('videoBitrate', parseInt(e.target.value))}
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
          value={settings.outputPath} onChange={(e) => update('outputPath', e.target.value)}
        />
      </div>

      {/* RTMP Presets */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>QUICK PRESETS</div>
        {[
          { name: 'Chaturbate', url: 'rtmp://live.chaturbate.com/live-origin' },
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
