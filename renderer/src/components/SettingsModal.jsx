import React, { useState, useEffect } from 'react';

const api = window.electronAPI;

export default function SettingsModal({ onClose }) {
  const [settings, setSettings] = useState({
    awsVoiceEnabled: true,
    awsBackupEnabled: true,
    awsMetricsEnabled: true,
    awsFirehoseEnabled: true,
    awsIotEnabled: false,
    awsPromptMode: 'bedrock',
    virtualCamEnabled: false,
  });
  const [tab, setTab] = useState('general');
  const [appVersion, setAppVersion] = useState('...');
  const [updateCheck, setUpdateCheck] = useState({ state: 'idle' });
  const [chaturbatePresetNotice, setChaturbatePresetNotice] = useState('');
  // state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

  // ─── AI Services Account (Settings → AWS/AI tab) ─────────
  // Shows the model's Apex account sign-in status and — when signed in
  // to a paid tier — confirms AI services are live. This is NOT a
  // BYOK AWS credential form: under the Apex-hosted architecture,
  // Bedrock calls are paid by Apex and routed through an Apex-owned
  // endpoint using the user's Cognito ID token as authorization. The
  // user never enters AWS Access Keys.
  const [aiSession, setAiSession] = useState(null);    // { email, ... } | null
  const [aiPlan, setAiPlan] = useState(null);          // 'free' | 'platinum' | 'agency' | null
  const [aiBusy, setAiBusy] = useState(false);         // true during sign-in / sign-out

  useEffect(() => {
    (async () => {
      const keys = Object.keys(settings);
      const loaded = {};
      for (const k of keys) {
        loaded[k] = await api.store.get(k) ?? settings[k];
      }
      setSettings(loaded);
      const v = await api.getVersion();
      setAppVersion(v);

      // Load the current Apex session + subscription tier for the AI
      // Services Account section. Both calls are cheap (cached in
      // electron-store) and tolerate being called with no sign-in.
      try {
        const session = await api.auth.getSession?.();
        setAiSession(session || null);
      } catch { setAiSession(null); }
      try {
        const sub = await api.subscription?.get?.();
        setAiPlan(sub?.plan || 'free');
      } catch { setAiPlan(null); }
    })();

    // Mirror the global update status into our local state while modal is open
    api.updates.onStatus((status) => {
      setUpdateCheck(status);
    });

    // If another window or a remote revoke fires sign-out, reflect it here.
    const unbind = api.auth?.onSignedOutRemote?.(() => {
      setAiSession(null);
      setAiPlan('free');
    });
    return () => { try { unbind?.(); } catch {} };
  }, []);

  // ─── AI Services Account handlers ─────────────────────
  const handleAiSignIn = async () => {
    setAiBusy(true);
    try {
      await api.auth.hostedUiSignIn();
      // The Hosted UI flow completes in an external browser then
      // round-trips back via a deep link. When the main process
      // finishes processing the callback it updates the session in
      // electron-store. We poll for up to 60s so the UI reflects
      // sign-in completion without requiring a manual refresh.
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const session = await api.auth.getSession?.();
        if (session) {
          setAiSession(session);
          try {
            const sub = await api.subscription?.get?.();
            setAiPlan(sub?.plan || 'free');
          } catch { setAiPlan('free'); }
          break;
        }
      }
    } catch (err) {
      console.warn('Hosted UI sign-in failed:', err);
    } finally {
      setAiBusy(false);
    }
  };

  const handleAiSignOut = async () => {
    setAiBusy(true);
    try {
      await api.auth.signOut();
      setAiSession(null);
      setAiPlan('free');
    } catch (err) {
      console.warn('Sign-out failed:', err);
    } finally {
      setAiBusy(false);
    }
  };

  const toggle = async (key) => {
    const newVal = !settings[key];
    setSettings((prev) => ({ ...prev, [key]: newVal }));
    await api.store.set(key, newVal);
  };

  // Chaturbate RTMP + conservative video targets to reduce disconnects
  // (1080p30, software OpenH264, moderate bitrate). Does not overwrite stream key.
  const applyChaturbateSafePreset = async () => {
    setChaturbatePresetNotice('');
    try {
      const cur = (await api.store.get('obsSettings')) || {};
      const patch = {
        streamUrl: 'rtmp://global.live.mmcdn.com/live-origin',
        resolution: { width: 1920, height: 1080 },
        fps: 30,
        videoBitrate: 4500,
        videoEncoder: 'libopenh264',
        preset: 'veryfast',
        audioBitrate: 128,
      };
      await api.store.set('obsSettings', { ...cur, ...patch });
      setChaturbatePresetNotice(
        'Chaturbate-safe preset applied: 1080p30, 4500 kbps video, OpenH264. Your stream key was not changed.',
      );
    } catch {
      setChaturbatePresetNotice('Could not apply preset. Try again or edit values in Scene Properties.');
    }
  };

  const handleCheckUpdates = async () => {
    setUpdateCheck({ state: 'checking' });
    try {
      await api.updates.check();
      // Result comes back via the onStatus listener above;
      // if nothing fires within 6s, assume up-to-date
      setTimeout(() => {
        setUpdateCheck((prev) =>
          prev.state === 'checking' ? { state: 'up-to-date' } : prev
        );
      }, 6000);
    } catch {
      setUpdateCheck({ state: 'error', message: 'Could not reach update server' });
    }
  };

  const tabs = [
    { id: 'general', label: 'General' },
    { id: 'aws', label: 'AWS / AI' },
    { id: 'streaming', label: 'Streaming' },
    { id: 'hotkeys', label: 'Hotkeys' },
  ];

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 500, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-title">⚙️ Settings</div>

        {/* Tab bar */}
        <div className="flex" style={{ borderBottom: '1px solid var(--border)', marginBottom: 12 }}>
          {tabs.map((t) => (
            <button
              key={t.id}
              className={`btn btn-sm ${tab === t.id ? 'btn-accent' : ''}`}
              style={{ borderRadius: 0, fontSize: 10 }}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ overflow: 'auto', flex: 1 }}>
          {tab === 'general' && (
            <div className="flex-col gap-3">
              <SettingRow label="Minimize to system tray on close" value={true} readOnly />
              <SettingRow label="Start with Windows" value={false} readOnly />
              <SettingRow label="Check for updates automatically" value={true} readOnly />

              {/* ── Updates ─────────────────────────────── */}
              <div style={{
                marginTop: 8, padding: '10px 12px',
                background: 'var(--bg-elevated, #111)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}>
                <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)' }}>
                      Apex Revenue Desktop
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
                      Version {appVersion}
                    </div>
                  </div>

                  <button
                    className="btn btn-sm"
                    onClick={handleCheckUpdates}
                    disabled={updateCheck.state === 'checking' || updateCheck.state === 'downloading'}
                    style={{ fontSize: 10, minWidth: 120 }}
                  >
                    {updateCheck.state === 'checking'   ? '⏳ Checking...'   :
                     updateCheck.state === 'downloading' ? `⬇ ${updateCheck.percent ?? 0}%` :
                     '↻ Check for Updates'}
                  </button>
                </div>

                {/* Status feedback */}
                {updateCheck.state === 'up-to-date' && (
                  <div style={{ fontSize: 10, color: 'var(--success, #2DD4A0)' }}>
                    ✓ You're on the latest version.
                  </div>
                )}
                {updateCheck.state === 'available' && (
                  <div style={{ fontSize: 10, color: '#60a5fa' }}>
                    ↓ v{updateCheck.version} available — downloading automatically…
                  </div>
                )}
                {updateCheck.state === 'downloading' && (
                  <div style={{ fontSize: 10, color: '#fbbf24' }}>
                    ⬇ Downloading v{updateCheck.version}… {updateCheck.percent ?? 0}%
                  </div>
                )}
                {updateCheck.state === 'ready' && (
                  <div className="flex items-center justify-between" style={{ marginTop: 4 }}>
                    <span style={{ fontSize: 10, color: '#4ade80' }}>
                      ✓ v{updateCheck.version} ready to install
                    </span>
                    <button
                      className="btn btn-sm btn-accent"
                      style={{ fontSize: 10 }}
                      onClick={() => api.updates.install()}
                    >
                      ↻ Restart & Update
                    </button>
                  </div>
                )}
                {updateCheck.state === 'error' && (
                  <div style={{ fontSize: 10, color: 'var(--live-red, #e8001a)' }}>
                    ✕ {updateCheck.message || 'Update check failed'}
                  </div>
                )}
              </div>
            </div>
          )}

          {tab === 'aws' && (
            <div className="flex-col gap-3">
              {/* ── AI Services Account ──────────────────────
                  User-facing sign-in for Apex-hosted AI services.
                  Bedrock-powered features (AI Coach, AI Filters,
                  AI Prompts) are paid by Apex as part of the
                  Platinum/Agency subscription — users sign in
                  with their Apex account, not with AWS keys. */}
              <div style={{
                padding: '12px 14px',
                background: 'var(--bg-elevated, #111)',
                border: '1px solid var(--border)',
                borderRadius: 6,
                marginBottom: 4,
              }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, letterSpacing: 0.5, textTransform: 'uppercase' }}>
                  AI Services Account
                </div>

                {aiSession ? (
                  <>
                    {/* Signed-in state */}
                    <div className="flex items-center justify-between" style={{ marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: 'var(--text, #f5f5f5)' }}>
                        {aiSession.email || 'Signed in'}
                      </div>
                      <AiPlanBadge plan={aiPlan} />
                    </div>

                    <div style={{ fontSize: 10, color: 'var(--text-dim, #9ca3af)', marginBottom: 10, lineHeight: 1.5 }}>
                      {aiPlan === 'agency' && (
                        <>✓ All AI services active — AI Coach, AI Filters, AI Prompts. Inference is covered by your Agency subscription.</>
                      )}
                      {aiPlan === 'platinum' && (
                        <>✓ AI Filters and AI Prompts active. Upgrade to Agency to unlock AI Coach.</>
                      )}
                      {(aiPlan === 'free' || !aiPlan) && (
                        <>Free tier — AI services are locked. Upgrade to Platinum or Agency to enable Bedrock-powered features.</>
                      )}
                    </div>

                    <button
                      className="btn btn-sm"
                      onClick={handleAiSignOut}
                      disabled={aiBusy}
                      style={{ fontSize: 10 }}
                    >
                      {aiBusy ? '...' : 'Sign Out'}
                    </button>
                  </>
                ) : (
                  <>
                    {/* Signed-out state */}
                    <div style={{ fontSize: 10, color: 'var(--text-dim, #9ca3af)', marginBottom: 10, lineHeight: 1.5 }}>
                      Sign in with your Apex Revenue account to activate AI Coach, AI Filters, and AI Prompts. Inference is included in Platinum and Agency subscriptions — no AWS credentials required.
                    </div>
                    <button
                      className="btn btn-sm btn-accent"
                      onClick={handleAiSignIn}
                      disabled={aiBusy}
                      style={{ fontSize: 10, minWidth: 140 }}
                    >
                      {aiBusy ? 'Waiting for sign-in…' : 'Sign in to Apex'}
                    </button>
                  </>
                )}
              </div>

              {/* ── Service toggles (existing) ───────────── */}
              <SettingToggle label="AI Prompts (Bedrock)" value={settings.awsPromptMode === 'bedrock'} onChange={() => toggle('awsPromptMode')} />
              <SettingToggle label="Voice Alerts (Polly)" value={settings.awsVoiceEnabled} onChange={() => toggle('awsVoiceEnabled')} />
              <SettingToggle label="Session Backup (S3)" value={settings.awsBackupEnabled} onChange={() => toggle('awsBackupEnabled')} />
              <SettingToggle label="CloudWatch Metrics" value={settings.awsMetricsEnabled} onChange={() => toggle('awsMetricsEnabled')} />
              <SettingToggle label="Firehose Streaming" value={settings.awsFirehoseEnabled} onChange={() => toggle('awsFirehoseEnabled')} />
              <SettingToggle label="IoT Core (Lovense Relay)" value={settings.awsIotEnabled} onChange={() => toggle('awsIotEnabled')} />
            </div>
          )}

          {tab === 'streaming' && (
            <div className="flex-col gap-3">
              <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
                Full stream controls (URL, key, resolution, encoder) live in{' '}
                <strong>Scene Properties</strong> on the right. Use the preset below for a
                stable baseline on Chaturbate (moderate bitrate for 1080p; lower in Scene Properties if your uplink is tight).
              </div>

              <div style={{
                padding: '12px 14px',
                background: 'var(--bg-elevated, #111)',
                border: '1px solid var(--border)',
                borderRadius: 6,
              }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: 'var(--text-secondary)', marginBottom: 8, letterSpacing: 0.4 }}>
                  CHATURBATE-SAFE PRESET
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5, marginBottom: 10 }}>
                  Sets RTMP URL to Chaturbate origin, 1920×1080 @ 30&nbsp;fps, 4500&nbsp;kbps video,
                  OpenH264 (software), veryfast preset, 128&nbsp;kbps audio. Your stream key is left unchanged.
                </div>
                <button
                  type="button"
                  className="btn btn-sm btn-accent"
                  style={{ fontSize: 10 }}
                  onClick={applyChaturbateSafePreset}
                >
                  Apply Chaturbate-safe preset
                </button>
                {chaturbatePresetNotice && (
                  <div style={{ fontSize: 10, color: 'var(--success, #2DD4A0)', marginTop: 10, lineHeight: 1.45 }}>
                    {chaturbatePresetNotice}
                  </div>
                )}
              </div>

              <SettingToggle label="Virtual Camera" value={settings.virtualCamEnabled} onChange={() => toggle('virtualCamEnabled')} />
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
                FFmpeg is required for streaming and recording.
                Place ffmpeg.exe in the app's ffmpeg/ folder or install it to your system PATH.
              </div>
            </div>
          )}

          {tab === 'hotkeys' && (
            <div className="flex-col gap-2">
              <HotkeyRow label="Start/Stop Streaming" hotkey="Ctrl+Shift+S" />
              <HotkeyRow label="Start/Stop Recording" hotkey="Ctrl+Shift+R" />
              <HotkeyRow label="Toggle Virtual Cam" hotkey="Ctrl+Shift+V" />
              <HotkeyRow label="Switch to Scene 1" hotkey="Ctrl+1" />
              <HotkeyRow label="Switch to Scene 2" hotkey="Ctrl+2" />
              <HotkeyRow label="Switch to Scene 3" hotkey="Ctrl+3" />
              <HotkeyRow label="Toggle Mute Mic" hotkey="Ctrl+Shift+M" />
              <HotkeyRow label="Toggle Mute Desktop" hotkey="Ctrl+Shift+D" />
              <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 8 }}>
                Custom hotkey configuration coming in a future update.
              </div>
            </div>
          )}
        </div>

        <div style={{ marginTop: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function SettingToggle({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11 }}>{label}</span>
      <button
        className={`btn btn-sm ${value ? 'btn-accent' : ''}`}
        onClick={onChange}
        style={{ minWidth: 40, fontSize: 10 }}
      >
        {value ? 'ON' : 'OFF'}
      </button>
    </div>
  );
}

function SettingRow({ label, value, readOnly }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11 }}>{label}</span>
      <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>{value ? 'Yes' : 'No'}</span>
    </div>
  );
}

function HotkeyRow({ label, hotkey }) {
  return (
    <div className="flex items-center justify-between" style={{ padding: '4px 0' }}>
      <span style={{ fontSize: 11 }}>{label}</span>
      <span style={{
        padding: '2px 6px', background: 'var(--bg-tertiary)', borderRadius: 3,
        fontSize: 10, fontFamily: 'monospace', color: 'var(--text-secondary)',
      }}>
        {hotkey}
      </span>
    </div>
  );
}

// Small tier indicator used inside the AI Services Account card. Colors
// match the Titlebar TierBadge for consistency (gold for Agency, purple
// for Platinum, gray for Free) but sized down for the tighter Settings
// layout. Defensive against unknown tier values (treats as Free).
function AiPlanBadge({ plan }) {
  const p = (plan || 'free').toLowerCase();
  let label, bg, color;
  if (p === 'agency') {
    label = 'AGENCY';
    bg = 'rgba(20, 184, 166, 0.15)';
    color = '#2dd4bf';
  } else if (p === 'platinum') {
    label = 'PLATINUM';
    bg = 'rgba(139, 92, 246, 0.15)';
    color = '#a78bfa';
  } else {
    label = 'FREE';
    bg = 'rgba(156, 163, 175, 0.15)';
    color = '#9ca3af';
  }
  return (
    <span style={{
      fontSize: 9,
      padding: '2px 8px',
      borderRadius: 3,
      fontWeight: 700,
      letterSpacing: 0.5,
      background: bg,
      color,
    }}>
      {label}
    </span>
  );
}
