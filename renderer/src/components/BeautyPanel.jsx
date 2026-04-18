import React, { useCallback } from 'react';

/**
 * Beauty Filter settings panel — lives in the RightPanel ✨ Beauty tab.
 *
 * Shows either:
 *  • Full controls (toggle + Intensity / Smoothness / Warmth / Brightness),
 *    when the effective plan unlocks the feature (admins via DEV toggle,
 *    beta users, or paying Platinum).
 *  • A locked preview with an upsell CTA for Free users.
 *
 * The panel never touches the BeautyFilter instance directly — it just
 * updates config in electron-store, and App.jsx listens for changes and
 * pushes them into the live filter via filter.update(...).
 */
export default function BeautyPanel({ config, onChange, unlocked, effectivePlan }) {
  const set = useCallback((key, value) => {
    onChange({ ...config, [key]: value });
  }, [config, onChange]);

  if (!unlocked) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{
          padding: '20px 16px',
          background: 'var(--bg-elevated, #1a1a22)',
          border: '1px solid var(--border, #2a2a35)',
          borderRadius: 6,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>✨🔒</div>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text, #f5f5f5)',
            letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6,
          }}>
            Beauty Filter
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim, #9ca3af)', lineHeight: 1.5, marginBottom: 14 }}>
            Real-time skin smoothing, tone, and warmth applied directly to your camera feed — viewers see the polished you, live.
          </div>
          <div style={{
            display: 'inline-block',
            padding: '8px 20px',
            background: 'var(--accent, #cc0000)',
            color: '#fff',
            fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase',
            borderRadius: 4, cursor: 'pointer',
          }}
               onClick={() => window.open('https://apexrevenue.works/billing', '_blank')}>
            Upgrade to Platinum
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim, #6b7280)', marginTop: 10 }}>
            Currently on: {effectivePlan?.toUpperCase() || 'FREE'}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {/* On/Off toggle */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '4px 0' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text, #f5f5f5)' }}>
            ✨ Beauty Filter
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim, #9ca3af)', marginTop: 2 }}>
            Applied to all webcam sources
          </div>
        </div>
        <Switch value={config.enabled} onChange={(v) => set('enabled', v)} />
      </div>

      <div style={{ height: 1, background: 'var(--border, #2a2a35)' }} />

      {/* Sliders — greyed out when disabled but still interactive so the
          performer can tune without repeatedly toggling the main switch */}
      <Slider
        label="Intensity"   hint="Overall blend of the smoothed pass"
        min={0} max={100} value={config.intensity}
        dim={!config.enabled}
        onChange={(v) => set('intensity', v)}
      />
      <Slider
        label="Smoothness"  hint="Skin softening strength"
        min={0} max={100} value={config.smoothness}
        dim={!config.enabled}
        onChange={(v) => set('smoothness', v)}
      />
      <Slider
        label="Warmth"      hint="Red / blue tonal shift"
        min={-100} max={100} value={config.warmth}
        dim={!config.enabled}
        center
        onChange={(v) => set('warmth', v)}
      />
      <Slider
        label="Brightness"  hint="Lift or darken overall"
        min={-100} max={100} value={config.brightness}
        dim={!config.enabled}
        center
        onChange={(v) => set('brightness', v)}
      />

      {/* Reset button — back to defaults */}
      <button
        type="button"
        onClick={() => onChange({ enabled: config.enabled, intensity: 50, smoothness: 50, warmth: 0, brightness: 0 })}
        style={{
          alignSelf: 'flex-end',
          padding: '4px 12px',
          fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
          background: 'transparent',
          color: 'var(--text-dim, #9ca3af)',
          border: '1px solid var(--border, #2a2a35)',
          borderRadius: 3,
          cursor: 'pointer',
        }}
      >
        Reset
      </button>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────

function Switch({ value, onChange }) {
  return (
    <div
      onClick={() => onChange(!value)}
      style={{
        width: 36, height: 20, borderRadius: 10,
        background: value ? 'var(--accent, #cc0000)' : 'var(--bg-elevated, #1a1a22)',
        border: `1px solid ${value ? 'var(--accent, #cc0000)' : 'var(--border, #2a2a35)'}`,
        cursor: 'pointer',
        position: 'relative',
        transition: 'background 0.15s',
        flexShrink: 0,
      }}
      role="switch"
      aria-checked={value}
    >
      <div style={{
        position: 'absolute',
        left: value ? 18 : 2, top: 1,
        width: 16, height: 16, borderRadius: '50%',
        background: '#fff',
        transition: 'left 0.15s',
      }} />
    </div>
  );
}

function Slider({ label, hint, min, max, value, onChange, dim, center }) {
  // Center-type sliders (Warmth/Brightness) show a tick mark at 0 and
  // display the value with a sign so the zero-point is visually obvious.
  const displayVal = center && value > 0 ? `+${value}` : `${value}`;
  return (
    <div style={{ opacity: dim ? 0.55 : 1, transition: 'opacity 0.15s' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
        <div>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text, #f5f5f5)' }}>
            {label}
          </span>
          <span style={{ fontSize: 9, color: 'var(--text-dim, #9ca3af)', marginLeft: 8 }}>
            {hint}
          </span>
        </div>
        <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--accent, #cc0000)', fontVariantNumeric: 'tabular-nums' }}>
          {displayVal}
        </span>
      </div>
      <input
        type="range"
        min={min} max={max} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ width: '100%', accentColor: 'var(--accent, #cc0000)' }}
      />
    </div>
  );
}
