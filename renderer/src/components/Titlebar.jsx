import React, { useState, useRef, useEffect } from 'react';

export default function Titlebar({
  user,
  streamStatus,
  platform,
  updateStatus,
  onAuthClick,
  onSettingsClick,
  onSignOut,
  onS3Backup,
  // Tier / admin toggle
  effectivePlan,       // 'free' | 'platinum'
  billingSource,       // 'admin' | 'beta' | 'stripe' | 'admin-toggle' | 'offline' | ...
  adminToggle,         // 'free' | 'platinum' | null
  onAdminToggleChange, // (tier) => void
  subscriptionOffline, // boolean
  graceRemainingMs,    // number | null
}) {
  const [appMenuOpen, setAppMenuOpen] = useState(false);
  const [checkingUpdate, setCheckingUpdate] = useState(false);
  const menuRef = useRef(null);

  // Close the menu when clicking outside
  useEffect(() => {
    if (!appMenuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setAppMenuOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [appMenuOpen]);

  // Reset checking state when an update status comes back
  useEffect(() => {
    if (updateStatus && updateStatus.state !== 'checking') {
      setCheckingUpdate(false);
    }
  }, [updateStatus]);

  const handleCheckUpdates = async () => {
    setCheckingUpdate(true);
    await window.electronAPI.updates.check();
    // If nothing comes back within 6s, assume up-to-date
    setTimeout(() => setCheckingUpdate(false), 6000);
  };

  // Build update action depending on current state
  const updateAction = updateStatus?.state === 'ready'
    ? {
        label: `Restart & Update v${updateStatus.version}`,
        icon: '↻',
        desc: 'Install the downloaded update and relaunch',
        action: () => { setAppMenuOpen(false); window.electronAPI.updates.install(); },
        color: '#4ade80',
      }
    : {
        label: checkingUpdate ? 'Checking...' : 'Check for Updates',
        icon: checkingUpdate ? '⏳' : '↑',
        desc: updateStatus?.state === 'up-to-date'
          ? '✓ You\'re on the latest version'
          : updateStatus?.state === 'downloading'
            ? `Downloading update ${updateStatus.percent ?? 0}%…`
            : 'Check for a new version of Apex Revenue',
        action: checkingUpdate || updateStatus?.state === 'downloading'
          ? () => {}
          : () => { handleCheckUpdates(); },
        color: updateStatus?.state === 'up-to-date' ? 'var(--success, #2DD4A0)' : '#60a5fa',
      };

  const APP_ACTIONS = [
    updateAction,
    {
      label: 'Close to Tray',
      icon: '▼',
      desc: 'Hide the window — app keeps running in the system tray',
      action: () => { setAppMenuOpen(false); window.electronAPI.window.close(); },
      color: 'var(--text-secondary)',
    },
    {
      label: 'Restart',
      icon: '↺',
      desc: 'Quit and relaunch Apex Revenue',
      action: () => { setAppMenuOpen(false); window.electronAPI.window.restart(); },
      color: '#fbbf24',
    },
    {
      label: 'Exit',
      icon: '✕',
      desc: 'Fully quit Apex Revenue',
      action: () => { setAppMenuOpen(false); window.electronAPI.window.exit(); },
      color: 'var(--live-red, #e8001a)',
    },
  ];

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

        {/* Tier badge — color-coded by billing source */}
        {user && effectivePlan && (
          <TierBadge
            plan={effectivePlan}
            source={billingSource}
            offline={subscriptionOffline}
            graceRemainingMs={graceRemainingMs}
          />
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
        {/* Admin Dev Access — Free ⇄ Platinum tier toggle.
            Only visible when the signed-in user is in the `admins` Cognito group. */}
        {user?.isAdmin && (
          <AdminTierToggle
            value={adminToggle}
            onChange={onAdminToggleChange}
          />
        )}

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

        {/* App Controls Tab */}
        <div ref={menuRef} style={{ position: 'relative', marginLeft: 4 }}>
          <button
            className={`btn btn-sm ${appMenuOpen ? 'btn-accent' : ''}`}
            onClick={() => setAppMenuOpen((o) => !o)}
            style={{ fontSize: 10, gap: 4, paddingRight: 6 }}
            title="App controls"
          >
            ⚡ App
            <span style={{ fontSize: 8, opacity: 0.7 }}>{appMenuOpen ? '▲' : '▼'}</span>
          </button>

          {appMenuOpen && (
            <div style={{
              position: 'absolute', top: 'calc(100% + 4px)', right: 0,
              background: 'var(--bg-card, #111)', border: '1px solid var(--border)',
              borderRadius: 8, overflow: 'hidden', minWidth: 210,
              boxShadow: '0 8px 24px rgba(0,0,0,0.5)', zIndex: 9999,
            }}>
              <div style={{ padding: '6px 10px 4px', fontSize: 8, fontWeight: 600, color: 'var(--text-dim)', textTransform: 'uppercase', letterSpacing: 1 }}>
                App Controls
              </div>
              {APP_ACTIONS.map(({ label, icon, desc, action, color }) => (
                <button
                  key={label}
                  onClick={action}
                  style={{
                    display: 'flex', alignItems: 'flex-start', gap: 10,
                    width: '100%', padding: '8px 12px',
                    background: 'none', border: 'none', cursor: 'pointer',
                    textAlign: 'left', borderTop: '1px solid var(--border)',
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-elevated, #1a1a1a)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = 'none'}
                >
                  <span style={{ fontSize: 13, color, marginTop: 1, flexShrink: 0 }}>{icon}</span>
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, color }}>{label}</div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 1 }}>{desc}</div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Window chrome buttons */}
        <div className="flex items-center" style={{ marginLeft: 4 }}>
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

// ─── Tier Badge ───────────────────────────────────────────
//
// Shows the current effective plan with color coding:
//   • Platinum (admin)       — gold, "ADMIN"
//   • Platinum (admin-toggle)— gold with 🔧, "DEV"
//   • Platinum (beta)        — magenta, "BETA"
//   • Platinum (stripe)      — purple, "PLATINUM"
//   • Platinum (offline)     — amber, "OFFLINE [countdown]"
//   • Free                   — gray, "FREE"
function TierBadge({ plan, source, offline, graceRemainingMs }) {
  let label, bg, color, border, icon = null;

  if (plan === 'platinum') {
    if (source === 'admin')          { label = 'ADMIN';    bg = 'rgba(250, 204, 21, 0.15)'; color = '#fbbf24'; border = 'rgba(250, 204, 21, 0.5)'; }
    else if (source === 'admin-toggle') { label = 'DEV PLATINUM'; icon = '🔧'; bg = 'rgba(250, 204, 21, 0.15)'; color = '#fbbf24'; border = 'rgba(250, 204, 21, 0.5)'; }
    else if (source === 'beta')      { label = 'BETA';     bg = 'rgba(236, 72, 153, 0.15)'; color = '#f472b6'; border = 'rgba(236, 72, 153, 0.5)'; }
    else if (offline)                { label = 'PLATINUM (OFFLINE)'; bg = 'rgba(251, 146, 60, 0.15)'; color = '#fb923c'; border = 'rgba(251, 146, 60, 0.5)'; }
    else                             { label = 'PLATINUM'; bg = 'rgba(139, 92, 246, 0.15)'; color = '#a78bfa'; border = 'rgba(139, 92, 246, 0.5)'; }
  } else {
    if (source === 'admin-toggle')   { label = 'DEV FREE'; icon = '🔧'; bg = 'rgba(156, 163, 175, 0.15)'; color = '#9ca3af'; border = 'rgba(156, 163, 175, 0.5)'; }
    else                             { label = 'FREE';     bg = 'rgba(156, 163, 175, 0.15)'; color = '#9ca3af'; border = 'rgba(156, 163, 175, 0.5)'; }
  }

  const graceDays = offline && graceRemainingMs != null
    ? Math.max(0, Math.ceil(graceRemainingMs / (24 * 60 * 60 * 1000)))
    : null;

  return (
    <span
      style={{
        fontSize: 9,
        padding: '2px 8px',
        borderRadius: 3,
        fontWeight: 700,
        letterSpacing: 0.5,
        background: bg,
        color,
        border: `1px solid ${border}`,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
      }}
      title={
        source === 'admin'         ? 'Admin bypass — all Platinum features unlocked' :
        source === 'admin-toggle'  ? 'Dev Access — tier override active for QA' :
        source === 'beta'          ? 'Beta Platinum — free access while in the Cognito beta group' :
        offline                    ? `Offline — using cached tier (grace: ${graceDays}d remaining)` :
        source === 'stripe'        ? 'Platinum via Stripe subscription' :
        'Current plan'
      }
    >
      {icon && <span>{icon}</span>}
      <span>{label}</span>
      {graceDays != null && <span style={{ opacity: 0.7 }}>· {graceDays}d</span>}
    </span>
  );
}

// ─── Admin Dev Access: Free ⇄ Platinum tier toggle ────────
//
// Only rendered for admins. Clicking cycles through three states so admins
// can return to "live" tier resolution (null → free → platinum → null).
// The "LIVE" state means: no override, resolve tier from subscription as
// a non-admin user would see it.
function AdminTierToggle({ value, onChange }) {
  const states = [
    { key: null,        label: 'LIVE',     color: '#60a5fa', desc: 'Use real tier' },
    { key: 'free',      label: 'FREE',     color: '#9ca3af', desc: 'Force free view' },
    { key: 'platinum',  label: 'PLATINUM', color: '#a78bfa', desc: 'Force platinum view' },
  ];
  const currentIdx = states.findIndex((s) => s.key === value);
  const current = states[currentIdx === -1 ? 0 : currentIdx];

  const cycle = () => {
    const next = states[(currentIdx + 1) % states.length];
    onChange?.(next.key);
  };

  return (
    <div
      onClick={cycle}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: 0.5,
        borderRadius: 4,
        cursor: 'pointer',
        background: 'rgba(250, 204, 21, 0.08)',
        color: current.color,
        border: '1px solid rgba(250, 204, 21, 0.4)',
        userSelect: 'none',
      }}
      title={`Dev Access (admin-only): ${current.desc}. Click to cycle.`}
    >
      <span style={{ color: '#fbbf24' }}>🔧 DEV</span>
      <span style={{ opacity: 0.5 }}>|</span>
      <span>{current.label}</span>
    </div>
  );
}

