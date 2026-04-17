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
  // state: 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'ready' | 'error'

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
    })();

    // Mirror the global update status into our local state while modal is open
    api.updates.onStatus((status) => {
      setUpdateCheck(status);
    });
  }, []);

  const toggle = async (key) => {
    const newVal = !settings[key];
    setSettings((prev) => ({ ...prev, [key]: newVal }));
    await api.store.set(key, newVal);
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
              <div style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                Streaming settings are available in the OBS properties panel (right side).
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
