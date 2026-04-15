import React from 'react';

export default function Titlebar({ user, streamStatus, platform, updateStatus, onAuthClick, onSettingsClick, onSignOut, onS3Backup }) {

  function renderUpdateBadge() {
    if (!updateStatus) return null;

    if (updateStatus.state === 'available') {
      return (
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 3,
          background: 'rgba(59, 130, 246, 0.2)', color: '#60a5fa',
          border: '1px solid rgba(59, 130, 246, 0.4)',
        }}>
          v{updateStatus.version} available ↓
        </span>
      );
    }

    if (updateStatus.state === 'downloading') {
      return (
        <span style={{
          fontSize: 9, padding: '2px 6px', borderRadius: 3,
          background: 'rgba(234, 179, 8, 0.2)', color: '#fbbf24',
          border: '1px solid rgba(234, 179, 8, 0.4)',
        }}>
          Downloading {updateStatus.percent}%
        </span>
      );
    }

    if (updateStatus.state === 'ready') {
      return (
        <button
          onClick={() => window.electronAPI.updates.install()}
          style={{
            fontSize: 9, padding: '2px 8px', borderRadius: 3, cursor: 'pointer',
            background: 'rgba(34, 197, 94, 0.2)', color: '#4ade80',
            border: '1px solid rgba(34, 197, 94, 0.5)',
          }}
          title={`v${updateStatus.version} downloaded — click to restart and install`}
        >
          ↻ Restart & Update
        </button>
      );
    }

    return null;
  }

  return (
    <div
      className="drag-region flex items-center justify-between"
      style={{
        height: 'var(--titlebar-h)', minHeight: 36,
        background: 'var(--bg-secondary)', borderBottom: '1px solid var(--border)',
        padding: '0 8px',
      }}
    >
      {/* Left: Logo + Status */}
      <div className="flex items-center gap-2 no-drag">
        <span style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1, color: 'var(--accent)' }}>
          ⚡ APEX REVENUE
        </span>
        <span style={{ fontSize: 9, color: 'var(--text-dim)' }}>v3.0</span>

        {streamStatus.streaming ? (
          <span className="badge badge-live">LIVE</span>
        ) : (
          <span className="badge" style={{ background: 'var(--bg-elevated)', color: 'var(--text-dim)' }}>OFFLINE</span>
        )}

        {streamStatus.recording && <span className="badge badge-danger" style={{ background: 'var(--live-red-dim)', color: 'var(--live-red)' }}>REC</span>}

        {platform && (
          <span className="badge badge-accent">{platform.toUpperCase()}</span>
        )}

        {renderUpdateBadge()}
      </div>

      {/* Center: Browser Controls (for cam site view) */}
      <div className="flex items-center gap-1 no-drag">
        <button className="btn btn-sm btn-icon" onClick={() => window.electronAPI.cam.back()} title="Back">◀</button>
        <button className="btn btn-sm btn-icon" onClick={() => window.electronAPI.cam.forward()} title="Forward">▶</button>
        <button className="btn btn-sm btn-icon" onClick={() => window.electronAPI.cam.reload()} title="Reload">↻</button>
      </div>

      {/* Right: User + Controls */}
      <div className="flex items-center gap-2 no-drag">
        <button className="btn btn-sm" onClick={onS3Backup} title="Backup to S3">💾</button>
        <button className="btn btn-sm" onClick={onSettingsClick} title="Settings">⚙️</button>

        {user ? (
          <div className="flex items-center gap-2">
            <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{user.email}</span>
            <button className="btn btn-sm" onClick={onSignOut}>Sign Out</button>
          </div>
        ) : (
          <button className="btn btn-sm btn-accent" onClick={onAuthClick}>Sign In</button>
        )}

        {/* Window controls */}
        <div className="flex items-center" style={{ marginLeft: 8 }}>
          <button
            className="btn btn-icon"
            onClick={() => window.electronAPI.window.minimize()}
            style={{ borderRadius: 0, fontSize: 14 }}
          >─</button>
          <button
            className="btn btn-icon"
            onClick={() => window.electronAPI.window.maximize()}
            style={{ borderRadius: 0, fontSize: 12 }}
          >☐</button>
          <button
            className="btn btn-icon"
            onClick={() => window.electronAPI.window.close()}
            style={{ borderRadius: 0, fontSize: 14 }}
          >✕</button>
        </div>
      </div>
    </div>
  );
}
