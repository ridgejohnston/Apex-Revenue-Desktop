import React, { useCallback } from 'react';
const {
  BG_GRADIENT_STYLES,
  BG_GRADIENT_PRESETS,
  GRADIENT_NONE,
  GRADIENT_SLOT_KEYS,
  GRADIENT_SLOT_LABELS,
  GRADIENT_SLOT_COUNT,
  isGradientSlotActive,
} = require('../../../shared/beauty-config');

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
export default function BeautyPanel({
  config, onChange, unlocked, effectivePlan,
  mediapipeStatus, onInstallMediapipe, onUninstallMediapipe, mediapipeProgress,
}) {
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
      bgGradientA: '#1a1a22',
      bgGradientB: '#cc0000',
      bgGradientC: GRADIENT_NONE,
      bgGradientD: GRADIENT_NONE,
      bgGradientE: GRADIENT_NONE,
      bgGradientStyle: 0,
      autoFeather: true,
      manualFeather: 50,
      autoBeauty: false,
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
        <AutoBeautyToggle
          enabled={!!config.autoBeauty}
          disabled={!config.enabled}
          onChange={(v) => set('autoBeauty', v)}
        />
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
        {!mediapipeStatus?.installed ? (
          <InstallPrompt
            progress={mediapipeProgress}
            onInstall={onInstallMediapipe}
          />
        ) : (
          <>
            <ModeSelector
              value={config.bgMode || 0}
              onChange={(v) => set('bgMode', v)}
              options={[
                { value: 0, label: 'Off' },
                { value: 1, label: 'Blur' },
                { value: 2, label: 'Color' },
                { value: 3, label: 'Gradient' },
              ]}
            />
            {config.bgMode === 1 && (
              <Slider label="Blur Strength" hint="Stronger → more out-of-focus"
                min={0} max={100} value={config.bgStrength ?? 60}
                onChange={(v) => set('bgStrength', v)} />
            )}
            {config.bgMode === 2 && (
              <>
                <PresetSwatches
                  value={config.bgColor ?? '#1a1a22'}
                  onChange={(v) => set('bgColor', v)}
                />
                <ColorRow label="Custom"
                  value={config.bgColor ?? '#1a1a22'}
                  onChange={(v) => set('bgColor', v)} />
              </>
            )}
            {config.bgMode === 3 && (
              <GradientControls
                slots={GRADIENT_SLOT_KEYS.map((k) => config[k])}
                style={config.bgGradientStyle ?? 0}
                onSlotChange={(i, v) => set(GRADIENT_SLOT_KEYS[i], v)}
                onStyleChange={(v) => set('bgGradientStyle', v)}
                onPresetApply={(preset) => onChange({
                  ...config,
                  bgGradientA:     preset.a,
                  bgGradientB:     preset.b,
                  bgGradientC:     preset.c,
                  bgGradientD:     preset.d,
                  bgGradientE:     preset.e,
                  bgGradientStyle: preset.style,
                })}
              />
            )}
            {(config.bgMode || 0) > 0 && (
              <EdgeSoftnessRow
                autoFeather={config.autoFeather !== false}
                manualFeather={config.manualFeather ?? 50}
                onAutoChange={(v) => set('autoFeather', v)}
                onManualChange={(v) => set('manualFeather', v)}
              />
            )}
            <InstalledFooter
              status={mediapipeStatus}
              onUninstall={onUninstallMediapipe}
            />
          </>
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

/**
 * Auto-Beauty toggle row. Sits at the top of the Beauty section and
 * controls whether the background vision analyzer (Claude Haiku on
 * Bedrock) continuously tunes the beauty/color/lighting sliders while
 * the stream is live. When enabled, the performer can still drag any
 * slider manually — the engine respects a 10-second grace window on
 * any slider the user touched before resuming auto-adjustment on it.
 */
function AutoBeautyToggle({ enabled, disabled, onChange }) {
  const handleClick = () => { if (!disabled) onChange(!enabled); };
  return (
    <div
      onClick={handleClick}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        background: enabled
          ? 'linear-gradient(90deg, rgba(204,0,0,0.12), rgba(204,0,0,0.02) 60%, transparent)'
          : 'var(--bg-elevated, #1a1a22)',
        border: `1px solid ${enabled ? 'var(--accent, #cc0000)' : 'var(--border, #2a2a35)'}`,
        borderRadius: 4,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.5 : 1,
        transition: 'background 0.15s, border-color 0.15s',
      }}
      role="button"
      aria-pressed={enabled}
      aria-disabled={disabled}
    >
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 10,
          fontWeight: 700,
          letterSpacing: 1.5,
          textTransform: 'uppercase',
          color: enabled ? 'var(--accent, #cc0000)' : 'var(--text, #f5f5f5)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}>
          <span>✨ Auto-Beauty</span>
          {enabled && (
            <span style={{
              fontSize: 8,
              fontWeight: 700,
              letterSpacing: 0.5,
              padding: '1px 5px',
              borderRadius: 2,
              background: 'var(--accent, #cc0000)',
              color: '#fff',
            }}>
              LIVE
            </span>
          )}
        </div>
        <div style={{
          fontSize: 9,
          color: 'var(--text-dim, #9ca3af)',
          marginTop: 3,
          lineHeight: 1.35,
        }}>
          AI vision tunes your filter every 15s for optimal on-cam look
        </div>
      </div>
      {/* Stop propagation so the inner Switch click isn't doubled by the row click */}
      <div onClick={(e) => e.stopPropagation()}>
        <Switch value={enabled} onChange={(v) => { if (!disabled) onChange(v); }} />
      </div>
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

/**
 * Install gate for the Background engine. Shown in place of the mode
 * selector when mediapipeStatus.installed is false.
 *
 * Three visual states:
 *   • Idle: headline + size + Install button
 *   • Downloading: progress bar + bytes/total + phase label
 *   • Error: red message + Retry button
 *
 * The progress prop is the same {phase, bytesDownloaded, totalBytes}
 * shape the main-process installer emits, plumbed through App.jsx.
 */
function InstallPrompt({ progress, onInstall }) {
  const installing = progress &&
    ['manifest', 'assets', 'verify', 'finalize'].includes(progress.phase);
  const errored = progress?.phase === 'error';

  const pctRaw = progress?.totalBytes > 0
    ? (progress.bytesDownloaded / progress.totalBytes) * 100
    : 0;
  const pct = Math.max(0, Math.min(100, pctRaw));

  return (
    <div style={{
      padding: 14,
      background: 'var(--bg-elevated, #1a1a22)',
      border: '1px solid var(--border, #2a2a35)',
      borderRadius: 5,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div>
        <div style={{
          fontSize: 11, fontWeight: 700, letterSpacing: 1,
          textTransform: 'uppercase', color: 'var(--text, #f5f5f5)',
          marginBottom: 4,
        }}>
          Install Background Engine
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-dim, #9ca3af)', lineHeight: 1.45 }}>
          One-time 23 MB download. Runs locally on your machine — no footage leaves your device. Uninstall any time to reclaim space.
        </div>
      </div>

      {installing && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{
            height: 6, borderRadius: 3,
            background: 'var(--bg-primary, #0a0a0f)',
            overflow: 'hidden',
          }}>
            <div style={{
              width: `${pct}%`, height: '100%',
              background: 'var(--accent, #cc0000)',
              transition: 'width 0.15s ease-out',
            }} />
          </div>
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: 9, color: 'var(--text-dim, #9ca3af)',
            fontVariantNumeric: 'tabular-nums',
          }}>
            <span>{phaseLabel(progress.phase)}</span>
            <span>
              {formatBytes(progress.bytesDownloaded)} / {formatBytes(progress.totalBytes)}
              {' '}({Math.round(pct)}%)
            </span>
          </div>
        </div>
      )}

      {errored && (
        <div style={{
          fontSize: 10, color: '#ef4444', lineHeight: 1.4,
          padding: '6px 8px',
          background: 'rgba(239, 68, 68, 0.08)',
          border: '1px solid rgba(239, 68, 68, 0.25)',
          borderRadius: 3,
        }}>
          Install failed: {progress.message || 'unknown error'}
        </div>
      )}

      {!installing && (
        <button
          type="button"
          onClick={onInstall}
          style={{
            padding: '8px 16px',
            background: 'var(--accent, #cc0000)',
            color: '#fff',
            border: 'none',
            borderRadius: 3,
            fontSize: 11, fontWeight: 700, letterSpacing: 1.5,
            textTransform: 'uppercase',
            cursor: 'pointer',
          }}
        >
          {errored ? 'Retry Install' : 'Install'}
        </button>
      )}
    </div>
  );
}

/**
 * Preset color swatches for Background → Color mode. Curated set covers
 * the situations a cam performer actually asks for:
 *   • Studio neutrals (black, charcoal, soft grey) for clean portraits
 *   • Warm/tan tones that flatter most skin
 *   • Bold accents (red, teal, purple) for branding/personality
 *   • Chroma-key green & blue for downstream OBS key-in workflows
 * The "Infinity" full-picker lives below this row (ColorRow component).
 */
const PRESET_COLORS = [
  { hex: '#000000', label: 'Black' },
  { hex: '#1a1a22', label: 'Charcoal' },
  { hex: '#3a3a44', label: 'Slate' },
  { hex: '#8d7a68', label: 'Warm Tan' },
  { hex: '#7a94b8', label: 'Dusk Blue' },
  { hex: '#cc0000', label: 'Apex Red' },
  { hex: '#14b8a6', label: 'Teal' },
  { hex: '#a855f7', label: 'Purple' },
  { hex: '#00b140', label: 'Chroma Green' },
  { hex: '#0047bb', label: 'Chroma Blue' },
];

function PresetSwatches({ value, onChange }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(5, 1fr)',
      gap: 4,
    }}>
      {PRESET_COLORS.map((p) => {
        const selected = value?.toLowerCase() === p.hex.toLowerCase();
        return (
          <button
            key={p.hex}
            type="button"
            title={p.label}
            aria-label={p.label}
            onClick={() => onChange(p.hex)}
            style={{
              aspectRatio: '1 / 1',
              background: p.hex,
              border: selected
                ? '2px solid var(--accent, #cc0000)'
                : '1px solid var(--border, #2a2a35)',
              borderRadius: 3,
              cursor: 'pointer',
              padding: 0,
              outline: 'none',
              transition: 'border-color 0.12s',
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * Background → Gradient controls. Shown when bgMode === 3. Four stacked
 * regions support going from zero to styled in one tap or dialing in a
 * custom multi-color gradient:
 *
 *   1. Preset gradients — 8 one-tap curated combos spanning 2, 3, and
 *      5-color compositions. Tap applies all 5 slots (setting unused
 *      ones to the 'none' sentinel) + the style that reads best with
 *      those colors. User can still tweak slots/style after.
 *
 *   2. Color slots A..E — up to five pickers. A slot can be:
 *        • Active: native color input + 'No Color' button (hides slot)
 *        • Inactive: hidden entirely per the "hide when No Color" rule
 *      Slots are hidden independently — so a 2-color setup (A+B only)
 *      shows only two rows, cleanly matching what the performer
 *      configured. An "+ Add color" row appears below the last active
 *      slot and promotes the next inactive slot to a color.
 *
 *   3. Style selector — 4×2 grid of the 8 spatial patterns. Each tile
 *      renders a CSS preview of the ACTUAL current slots (not just
 *      A→B) so the performer sees what a 3- or 5-color gradient
 *      actually looks like in each pattern.
 *
 * The "natural fade" semantics (A gets more space, E less when later
 * slots are inactive) are implemented in the fragment shader's
 * sampleGradient() helper — the UI just renders what's configured
 * and trusts the shader. Slot anchor positions match exactly:
 *   A=0.0  B=0.25  C=0.5  D=0.75  E=1.0
 */
function GradientControls({
  slots, style,
  onSlotChange, onStyleChange, onPresetApply,
}) {
  // Find the first inactive slot so we can show an "+ Add color" row
  // just below the last active one. Scanning forward and taking the
  // first inactive index gives us a stable insertion point even when
  // earlier slots get toggled off (the "add" affordance stays glued
  // to the bottom of the active range).
  const firstInactiveIdx = slots.findIndex((s) => !isGradientSlotActive(s));
  const canAdd = firstInactiveIdx >= 0 && firstInactiveIdx < GRADIENT_SLOT_COUNT;

  // When the user clicks "+ Add color", we promote the next inactive
  // slot to a reasonable default hex. We seed with the same brand
  // crimson A/B defaults + three appealing follow-ups so the added
  // slot doesn't arrive as pure black. User immediately re-colors via
  // the picker anyway, but the seed makes the visual change obvious.
  const ADD_SEEDS = ['#1a1a22', '#cc0000', '#e8489d', '#6a1bff', '#1a8a9a'];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <GradientPresetRow slots={slots} style={style} onApply={onPresetApply} />

      {/* Render only ACTIVE slots — hide-when-none rule */}
      {slots.map((v, i) => {
        if (!isGradientSlotActive(v)) return null;
        return (
          <GradientSlotRow
            key={i}
            label={GRADIENT_SLOT_LABELS[i]}
            value={v}
            canDeactivate={countActive(slots) > 1}
            onChange={(next) => onSlotChange(i, next)}
            onDeactivate={() => onSlotChange(i, GRADIENT_NONE)}
          />
        );
      })}

      {/* "+ Add color" affordance — appears below the last active slot */}
      {canAdd && (
        <button
          type="button"
          onClick={() => onSlotChange(firstInactiveIdx, ADD_SEEDS[firstInactiveIdx] || '#cccccc')}
          style={{
            padding: '7px 10px',
            fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
            color: 'var(--text-dim, #9ca3af)',
            background: 'transparent',
            border: '1px dashed var(--border, #2a2a35)',
            borderRadius: 3,
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          + Add color {GRADIENT_SLOT_LABELS[firstInactiveIdx]}
        </button>
      )}

      <GradientStylePicker slots={slots} value={style} onChange={onStyleChange} />
    </div>
  );
}

// ─── Gradient helpers (shared by preset, slot-row, and style-picker) ───

function countActive(slots) {
  let n = 0;
  for (const s of slots) if (isGradientSlotActive(s)) n++;
  return n;
}

/**
 * Build a CSS gradient string using up-to-5 slots with the same
 * "natural fade" semantics the fragment shader uses:
 *   A=0%  B=25%  C=50%  D=75%  E=100%
 * Inactive slots are omitted from the color-stops list, and the last
 * active color is extended to 100% so the tail of the gradient reads
 * as a flat hold (matching the shader). If only one color is active,
 * we return a solid-color "gradient" — CSS needs at least 2 stops,
 * so we duplicate the single color at 0% and 100%.
 */
function buildCssStops(slots) {
  const anchors = [0, 25, 50, 75, 100];
  const stops = [];
  for (let i = 0; i < GRADIENT_SLOT_COUNT; i++) {
    if (isGradientSlotActive(slots[i])) stops.push({ c: slots[i], p: anchors[i] });
  }
  if (stops.length === 0) return { ok: false, stops: [] };
  if (stops.length === 1) return { ok: true, stops: [{ c: stops[0].c, p: 0 }, { c: stops[0].c, p: 100 }] };
  // Hold the last active color from its anchor through 100%
  const last = stops[stops.length - 1];
  if (last.p < 100) stops.push({ c: last.c, p: 100 });
  return { ok: true, stops };
}

function stopsToString(stops) {
  return stops.map((s) => `${s.c} ${s.p}%`).join(', ');
}

/**
 * Build a CSS preview for a given spatial style using the current
 * multi-stop slot list. The shader's precise output is authoritative;
 * these CSS strings just give the UI enough fidelity to distinguish
 * styles and convey what each pattern looks like with the configured
 * colors. CSS can't exactly replicate the shader's tie-dye swirl or
 * square (Chebyshev) distance field, so we use conic/radial gradient
 * approximations that are visually close enough for at-a-glance tile
 * differentiation.
 */
function cssPreviewForSlotGradient(style, slots) {
  const { ok, stops } = buildCssStops(slots);
  if (!ok) return 'var(--bg-elevated, #1a1a22)';
  const s = stopsToString(stops);
  switch (style) {
    case 0: return `linear-gradient(to bottom, ${s})`;
    case 1: return `linear-gradient(to right, ${s})`;
    case 2: return `linear-gradient(135deg, ${s})`;
    case 3: return `linear-gradient(225deg, ${s})`;
    case 4: return `radial-gradient(circle at center, ${s})`;
    case 5: {
      // Tie-dye: conic gradient with all active stops, cycled once
      // back to the first color to avoid the seam discontinuity that
      // a raw conic gradient would show.
      const active = stops.filter((x, i, arr) => !(i === arr.length - 1 && x.p === 100 && arr[i-1] && arr[i-1].c === x.c));
      if (active.length >= 2) {
        const cycled = [...active.map((x) => x.c), active[0].c].join(', ');
        return `conic-gradient(from 0deg at 50% 50%, ${cycled})`;
      }
      return `radial-gradient(circle at center, ${s})`;
    }
    case 6: return `radial-gradient(farthest-side at center, ${s})`;
    case 7: {
      // Waves: repeating linear, compressed to ~25% so the repeats
      // read as banded. Only use the FIRST two active colors — the
      // repeating-linear-gradient syntax doesn't play well with >2.
      const first = stops[0]?.c ?? '#000';
      const second = stops[1]?.c ?? first;
      return `repeating-linear-gradient(to bottom, ${first} 0%, ${second} 25%, ${first} 50%)`;
    }
    default: return `linear-gradient(to bottom, ${s})`;
  }
}

/**
 * Preset row for gradients. 4×2 grid. Each swatch shows a linear CSS
 * preview using the preset's full slot palette (some have 2, some 3,
 * some all 5 colors) so the performer can tell at a glance how rich
 * a given preset will be.
 *
 * Selected detection: a preset is "selected" when every slot (A..E)
 * and the style all match. Case-insensitive hex comparison so stored
 * uppercase/lowercase forms both match.
 */
function GradientPresetRow({ slots, style, onApply }) {
  const isSelected = (p) => {
    const presetSlots = [p.a, p.b, p.c, p.d, p.e];
    if (p.style !== style) return false;
    for (let i = 0; i < GRADIENT_SLOT_COUNT; i++) {
      const a = (presetSlots[i] || '').toLowerCase();
      const b = (slots[i] || '').toLowerCase();
      if (a !== b) return false;
    }
    return true;
  };

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 4,
    }}>
      {BG_GRADIENT_PRESETS.map((p) => {
        const selected = isSelected(p);
        // Preview uses each preset's own slot palette
        const presetSlotsArr = [p.a, p.b, p.c, p.d, p.e];
        const { ok, stops } = buildCssStops(presetSlotsArr);
        const bg = ok
          ? `linear-gradient(135deg, ${stopsToString(stops)})`
          : 'var(--bg-elevated, #1a1a22)';
        return (
          <button
            key={p.name}
            type="button"
            title={p.name}
            aria-label={p.name}
            onClick={() => onApply(p)}
            style={{
              aspectRatio: '1 / 1',
              background: bg,
              border: selected
                ? '2px solid var(--accent, #cc0000)'
                : '1px solid var(--border, #2a2a35)',
              borderRadius: 3,
              cursor: 'pointer',
              padding: 0,
              outline: 'none',
              transition: 'border-color 0.12s',
            }}
          />
        );
      })}
    </div>
  );
}

/**
 * One color-slot row. Shown only when the slot is active. Displays:
 *   • Slot label (A..E)
 *   • Native color picker
 *   • Hex readout
 *   • "No Color" button (hidden when there's only one active slot —
 *     we prevent deactivating the last one, else the gradient becomes
 *     empty and the shader falls back to u_bgColor which is confusing).
 */
function GradientSlotRow({ label, value, canDeactivate, onChange, onDeactivate }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 1,
        textTransform: 'uppercase',
        color: 'var(--text, #f5f5f5)',
        width: 56,
      }}>
        Color {label}
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
      <span style={{
        fontSize: 10, color: 'var(--text-dim, #9ca3af)',
        fontVariantNumeric: 'tabular-nums',
        flex: 1,
      }}>
        {(value || '').toUpperCase()}
      </span>
      {canDeactivate && (
        <button
          type="button"
          onClick={onDeactivate}
          title="Remove this color from the gradient"
          style={{
            background: 'transparent',
            border: '1px solid var(--border, #2a2a35)',
            color: 'var(--text-dim, #9ca3af)',
            fontSize: 9, fontWeight: 700, letterSpacing: 1,
            textTransform: 'uppercase',
            borderRadius: 3,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          No Color
        </button>
      )}
    </div>
  );
}

/**
 * Gradient style picker. 4×2 grid of miniature previews — each shows
 * what the 8 spatial patterns do to the CURRENT multi-stop slot
 * configuration (not just A/B). Seeing real colors in every preview
 * means the performer can A/B styles without guessing at outcomes.
 */
function GradientStylePicker({ slots, value, onChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{
        fontSize: 10, fontWeight: 700, letterSpacing: 1,
        textTransform: 'uppercase',
        color: 'var(--text, #f5f5f5)',
      }}>
        Style
      </span>
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 4,
      }}>
        {BG_GRADIENT_STYLES.map((s) => {
          const active = s.value === value;
          return (
            <button
              key={s.value}
              type="button"
              title={s.label}
              aria-label={s.label}
              onClick={() => onChange(s.value)}
              style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                background: cssPreviewForSlotGradient(s.value, slots),
                border: active
                  ? '2px solid var(--accent, #cc0000)'
                  : '1px solid var(--border, #2a2a35)',
                borderRadius: 3,
                cursor: 'pointer',
                padding: 0,
                outline: 'none',
                overflow: 'hidden',
                transition: 'border-color 0.12s',
              }}
            >
              <span style={{
                position: 'absolute',
                bottom: 2, left: 0, right: 0,
                fontSize: 8, fontWeight: 700, letterSpacing: 0.5,
                textTransform: 'uppercase',
                color: '#fff',
                textShadow: '0 1px 2px rgba(0,0,0,0.8)',
                pointerEvents: 'none',
              }}>
                {s.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}


/**
 * Small affordance at the bottom of the Background section once the
 * engine is installed — shows version/size for transparency and gives
 * the user a path to uninstall (reclaim ~23 MB) without digging.
 */
function InstalledFooter({ status, onUninstall }) {
  if (!status?.installed) return null;
  const mb = Math.round((status.totalBytes || 0) / (1024 * 1024));
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      paddingTop: 6,
      fontSize: 9, color: 'var(--text-dim, #6b7280)',
      fontVariantNumeric: 'tabular-nums',
    }}>
      <span>Engine installed · {mb} MB</span>
      <button
        type="button"
        onClick={onUninstall}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--text-dim, #9ca3af)',
          fontSize: 9, fontWeight: 700, letterSpacing: 1,
          textTransform: 'uppercase',
          cursor: 'pointer',
          textDecoration: 'underline',
          padding: 0,
        }}
      >
        Uninstall
      </button>
    </div>
  );
}

/**
 * Edge-softness control — governs u_maskFeather in the composite shader.
 * Default "Auto" uses beauty-filter's halo detector to calibrate from
 * live mask stats (better for everyday use). Flipping Auto off reveals
 * a manual slider for performers who want a specific look locked in.
 */
function EdgeSoftnessRow({ autoFeather, manualFeather, onAutoChange, onManualChange }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: 'var(--text, #f5f5f5)' }}>
            Edge Softness
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim, #9ca3af)', marginTop: 2 }}>
            {autoFeather
              ? 'Auto-calibrated to hide halos around hair / fabric'
              : 'Manual override — wider softens, tighter sharpens'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase', color: autoFeather ? 'var(--accent, #cc0000)' : 'var(--text-dim, #9ca3af)' }}>
            Auto
          </span>
          <Switch value={autoFeather} onChange={onAutoChange} />
        </div>
      </div>
      {!autoFeather && (
        <input
          type="range"
          min={0} max={100} value={manualFeather}
          onChange={(e) => onManualChange(Number(e.target.value))}
          style={{ width: '100%', accentColor: 'var(--accent, #cc0000)' }}
        />
      )}
    </div>
  );
}

function phaseLabel(phase) {
  switch (phase) {
    case 'manifest': return 'Fetching manifest…';
    case 'assets':   return 'Downloading…';
    case 'verify':   return 'Verifying…';
    case 'finalize': return 'Installing…';
    case 'done':     return 'Done';
    default:         return 'Starting…';
  }
}

function formatBytes(n) {
  if (!n || n < 1024) return `${n || 0} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
