import React, { useCallback } from 'react';
const { BG_GRADIENT_STYLES, BG_GRADIENT_PRESETS } = require('../../../shared/beauty-config');

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
      bgGradientStyle: 0,
      autoFeather: true,
      manualFeather: 50,
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
                colorA={config.bgGradientA ?? '#1a1a22'}
                colorB={config.bgGradientB ?? '#cc0000'}
                style={config.bgGradientStyle ?? 0}
                onColorAChange={(v) => set('bgGradientA', v)}
                onColorBChange={(v) => set('bgGradientB', v)}
                onStyleChange={(v) => set('bgGradientStyle', v)}
                onPresetApply={(preset) => onChange({
                  ...config,
                  bgGradientA:     preset.a,
                  bgGradientB:     preset.b,
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
 * Background → Gradient controls. Shown when bgMode === 3. Three stacked
 * rows so a performer can go from zero to styled background in one tap
 * (presets) or dial in a custom look (A/B pickers + style dropdown):
 *
 *   1. Preset gradients  — 8 curated one-tap combos (Apex brand, Sunset,
 *                          Midnight, Rose Gold, Neon, Ocean, Warm Studio,
 *                          Lavender Dusk). Applies both colors + a style
 *                          that reads best with those colors. User can
 *                          still change style after.
 *   2. Color A + Color B — Native color pickers. Live-update the filter
 *                          on every change; no "apply" button needed.
 *   3. Style selector    — 4×2 grid of the 8 spatial patterns. Each has
 *                          a tiny SVG icon showing what the gradient
 *                          does to the two picked colors so the choice
 *                          is visual, not just textual.
 *
 * All three rows write into the same config object via onChange; the
 * shader re-renders on every frame with the current values, so changes
 * are immediately visible in preview.
 */
function GradientControls({
  colorA, colorB, style,
  onColorAChange, onColorBChange, onStyleChange, onPresetApply,
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <GradientPresetRow
        colorA={colorA}
        colorB={colorB}
        style={style}
        onApply={onPresetApply}
      />
      <ColorRow label="Color A" value={colorA} onChange={onColorAChange} />
      <ColorRow label="Color B" value={colorB} onChange={onColorBChange} />
      <GradientStylePicker
        colorA={colorA}
        colorB={colorB}
        value={style}
        onChange={onStyleChange}
      />
    </div>
  );
}

/**
 * Preset row for gradients. Same 5-column grid as PresetSwatches so the
 * UI rhythm matches. Each swatch is a mini CSS gradient using the
 * preset's actual colors, so the performer sees what they're about to
 * apply. Layout: 8 presets = 5 columns x 2 rows.
 *
 * Selected detection: a preset is "selected" when all three fields
 * (colorA, colorB, style) match. Case-insensitive hex comparison so
 * uppercase and lowercase forms both match.
 */
function GradientPresetRow({ colorA, colorB, style, onApply }) {
  const isSelected = (p) =>
    p.a.toLowerCase() === (colorA || '').toLowerCase() &&
    p.b.toLowerCase() === (colorB || '').toLowerCase() &&
    p.style === style;

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 4,
    }}>
      {BG_GRADIENT_PRESETS.map((p) => {
        const selected = isSelected(p);
        return (
          <button
            key={p.name}
            type="button"
            title={p.name}
            aria-label={p.name}
            onClick={() => onApply(p)}
            style={{
              aspectRatio: '1 / 1',
              // Linear-gradient CSS preview of the actual colors — fast
              // visual read, and correct enough to convey vibe even if
              // the preset's actual style is radial/tie-dye/etc.
              background: `linear-gradient(135deg, ${p.a}, ${p.b})`,
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
 * Gradient style picker. 4×2 grid of miniature SVG previews — each shows
 * exactly what the 8 spatial patterns do to the currently-selected
 * color A → color B pair. Seeing the current colors in every preview
 * means the performer can A/B styles without guessing.
 *
 * Preview rendering: each style is approximated by CSS — cheap, no
 * canvas/webgl needed at panel-draw time. The actual shader does the
 * precise version at composite time.
 */
function GradientStylePicker({ colorA, colorB, value, onChange }) {
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
                background: cssPreviewForStyle(s.value, colorA, colorB),
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
 * Build a CSS preview string for each gradient style. These are
 * approximations — the real gradient is computed in the fragment
 * shader at composite time — but CSS has enough expressiveness to
 * convey the shape of each pattern so the performer can distinguish
 * them at a glance.
 */
function cssPreviewForStyle(style, a, b) {
  switch (style) {
    case 0: return `linear-gradient(to bottom, ${a}, ${b})`;
    case 1: return `linear-gradient(to right, ${a}, ${b})`;
    case 2: return `linear-gradient(135deg, ${a}, ${b})`;
    case 3: return `linear-gradient(225deg, ${a}, ${b})`;
    case 4: return `radial-gradient(circle at center, ${a}, ${b})`;
    case 5: {
      // Tie-dye: layer a conic and a radial to hint at the swirl effect
      return `conic-gradient(from 0deg at 50% 50%, ${a}, ${b}, ${a}, ${b}, ${a})`;
    }
    case 6: {
      // Square: layered radial with small/large stops to suggest concentric squares
      // CSS has no native "square radial" — use a conic gradient that steps
      // at 45° intervals to hint at the axis-aligned edges.
      return `radial-gradient(farthest-side at center, ${a} 0%, ${b} 100%)`;
    }
    case 7: {
      // Waves: stacked linear gradients with repeating color bands
      return `repeating-linear-gradient(to bottom, ${a} 0%, ${b} 25%, ${a} 50%)`;
    }
    default: return a;
  }
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
