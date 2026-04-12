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

  useEffect(() => {
    (async () => {
      const keys = Object.keys(settings);
      const loaded = {};
      for (const k of keys) {
        loaded[k] = await api.store.get(k) ?? settings[k];
      }
      setSettings(loaded);
    })();
  }, []);

  const toggle = async (key) => {
    const newVal = !settings[key];
    setSettings((prev) => ({ ...prev, [key]: newVal }));
    await api.store.set(key, newVal);
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
              <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 8 }}>
                Apex Revenue Desktop v2.0.0
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
