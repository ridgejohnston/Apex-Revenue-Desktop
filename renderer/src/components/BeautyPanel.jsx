import React, { useCallback } from 'react';

/**
 * Filter settings panel — lives in the RightPanel ✨ Beauty tab.
 *
 * Organized into three sections:
 *   • Beauty   — Intensity, Smoothness, Sharpness
 *   • Color    — Warmth, Brightness, Contrast, Saturation
 *   • Lighting — Low-Light Boost, Radial Light (vignette ↔ key light)
 *
 * The panel never touches the BeautyFilter instance directly — it just
 * updates config in electron-store, and App.jsx listens for changes and
 * pushes them into the live filter via filter.update(...).
 *
 * Tier-gated: Free users see a locked preview with a Platinum upsell CTA.
 */
export default function BeautyPanel({ config, onChange, unlocked, effectivePlan }) {
  const set = useCallback((key, value) => {
    onChange({ ...config, [key]: value });
  }, [config, onChange]);

  const resetAll = useCallback(() => {
    onChange({
      enabled:    config.enabled,
      intensity:  50,
      smoothness: 50,
      warmth:     0,
      brightness: 0,
      sharpness:  0,
      contrast:   0,
      saturation: 0,
      lowLight:   0,
      radial:     0,
      bgMode:     0,
      bgStrength: 60,
      bgColor:    '#1a1a22',
    });
  }, [config.enabled, onChange]);

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
            Beauty & Filters
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim, #9ca3af)', lineHeight: 1.5, marginBottom: 14 }}>
            Real-time skin smoothing, color grading, virtual key light, and more — all applied directly to your camera feed. Viewers see the polished you, live.
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
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      {/* Master on/off */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '2px 0' }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text, #f5f5f5)' }}>
            ✨ Filters
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim, #9ca3af)', marginTop: 2 }}>
            Applied to all webcam sources
          </div>
        </div>
        <Switch value={config.enabled} onChange={(v) => set('enabled', v)} />
      </div>

      {/* ─── BEAUTY ─── */}
      <Section title="Beauty" dim={!config.enabled}>
        <Slider label="Intensity"  hint="Overall smoothing blend"
          min={0} max={100} value={config.intensity} onChange={(v) => set('intensity', v)} />
        <Slider label="Smoothness" hint="Skin softening strength"
          min={0} max={100} value={config.smoothness} onChange={(v) => set('smoothness', v)} />
        <Slider label="Sharpness"  hint="Restore fine detail"
          min={0} max={100} value={config.sharpness} onChange={(v) => set('sharpness', v)} />
      </Section>

      {/* ─── COLOR ─── */}
      <Section title="Color" dim={!config.enabled}>
        <Slider label="Warmth"     hint="Red ↔ blue shift"
          min={-100} max={100} value={config.warmth} center onChange={(v) => set('warmth', v)} />
        <Slider label="Brightness" hint="Lift or darken overall"
          min={-100} max={100} value={config.brightness} center onChange={(v) => set('brightness', v)} />
        <Slider label="Contrast"   hint="Pop shadows vs highlights"
          min={-100} max={100} value={config.contrast} center onChange={(v) => set('contrast', v)} />
        <Slider label="Saturation" hint="Color richness"
          min={-100} max={100} value={config.saturation} center onChange={(v) => set('saturation', v)} />
      </Section>

      {/* ─── LIGHTING ─── */}
      <Section title="Lighting" dim={!config.enabled}>
        <Slider label="Low-Light Boost" hint="Lift shadows in dim rooms"
          min={0} max={100} value={config.lowLight} onChange={(v) => set('lowLight', v)} />
        <Slider label="Radial Light" hint="Vignette ↔ virtual key light"
          min={-100} max={100} value={config.radial} center onChange={(v) => set('radial', v)} />
      </Section>

      {/* ─── BACKGROUND ─── */}
      <Section title="Background" dim={!config.enabled}>
        <ModeSelector
          value={config.bgMode || 0}
          onChange={(v) => set('bgMode', v)}
          options={[
            { value: 0, label: 'Off' },
            { value: 1, label: 'Blur' },
            { value: 2, label: 'Color' },
          ]}
        />
        {config.bgMode === 1 && (
          <Slider label="Blur Strength" hint="Stronger → more out-of-focus"
            min={0} max={100} value={config.bgStrength ?? 60}
            onChange={(v) => set('bgStrength', v)} />
        )}
        {config.bgMode === 2 && (
          <ColorRow label="Color"
            value={config.bgColor ?? '#1a1a22'}
            onChange={(v) => set('bgColor', v)} />
        )}
        {(config.bgMode || 0) > 0 && (
          <div style={{ fontSize: 9, color: 'var(--text-dim, #6b7280)', lineHeight: 1.4 }}>
            First activation downloads a ~3 MB person-segmentation model. Keep a light background behind you for best edge quality.
          </div>
        )}
      </Section>

      {/* Reset */}
      <button
        type="button"
        onClick={resetAll}
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
        Reset all
      </button>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────

function Section({ title, children, dim }) {
  return (
    <div style={{
      borderTop: '1px solid var(--border, #2a2a35)',
      paddingTop: 10,
      opacity: dim ? 0.55 : 1,
      transition: 'opacity 0.15s',
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
    }}>
      <div style={{
        fontSize: 9, fontWeight: 700, letterSpacing: 2,
        textTransform: 'uppercase',
        color: 'var(--accent, #cc0000)',
        marginBottom: 2,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

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

function Slider({ label, hint, min, max, value, onChange, center }) {
  const displayVal = center && value > 0 ? `+${value}` : `${value}`;
  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 3 }}>
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

/**
 * Segmented 3-button control for Background mode. Keeps all three
 * options visible so the current selection is always apparent — a
 * dropdown would hide state behind a click and the set is tiny.
 */
function ModeSelector({ value, onChange, options }) {
  return (
    <div style={{
      display: 'flex',
      border: '1px solid var(--border, #2a2a35)',
      borderRadius: 4,
      overflow: 'hidden',
    }}>
      {options.map((opt) => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            style={{
              flex: 1,
              padding: '6px 4px',
              background: active ? 'var(--accent, #cc0000)' : 'transparent',
              color: active ? '#fff' : 'var(--text-dim, #9ca3af)',
              border: 'none',
              fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
              cursor: 'pointer',
            }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function ColorRow({ label, value, onChange }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text, #f5f5f5)', flex: 1 }}>
        {label}
      </span>
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          width: 40, height: 26, padding: 0,
          border: '1px solid var(--border, #2a2a35)',
          borderRadius: 3,
          background: 'transparent',
          cursor: 'pointer',
        }}
      />
      <span style={{ fontSize: 10, color: 'var(--text-dim, #9ca3af)', fontVariantNumeric: 'tabular-nums' }}>
        {value.toUpperCase()}
      </span>
    </div>
  );
}
