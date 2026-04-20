import React, { useState, useEffect, useMemo, useRef } from 'react';

const api = window.electronAPI;

function emptySlot() {
  return {
    sourceId: null,
    triggerTokens: 25,
    durationSeconds: 8,
    streamUrl: '',
    streamKey: '',
  };
}

function normalizeMultiOutputs(raw) {
  const a = Array.isArray(raw) ? raw.slice(0, 8) : [];
  while (a.length < 8) a.push(emptySlot());
  return a.map((x) => ({ ...emptySlot(), ...x }));
}

function defaultCfg() {
  return {
    enabled: false,
    tipThresholdTokens: 25,
    holdSeconds: 8,
    defaultWebcamSourceId: null,
    alternateSourceIds: [],
    multiOutputEnabled: false,
    multiOutputs: normalizeMultiOutputs([]),
  };
}

export default function MultiViewPanel({ activeScene }) {
  const [cfg, setCfg] = useState(defaultCfg);
  const cfgRef = useRef(cfg);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    cfgRef.current = cfg;
  }, [cfg]);

  const webcams = useMemo(() => {
    const src = activeScene?.sources || [];
    return src.filter((s) => s.type === 'webcam');
  }, [activeScene?.sources]);

  useEffect(() => {
    api.store.get('multiViewSettings').then((s) => {
      let merged = { ...defaultCfg(), ...s };
      merged.multiOutputs = normalizeMultiOutputs(merged.multiOutputs);
      if (s.dualOutputMode && s.alternateStreamUrl) {
        merged.multiOutputEnabled = true;
        merged.multiOutputs[0] = {
          ...merged.multiOutputs[0],
          streamUrl: s.alternateStreamUrl || merged.multiOutputs[0].streamUrl,
          streamKey: s.alternateStreamKey != null ? s.alternateStreamKey : merged.multiOutputs[0].streamKey,
        };
      }
      setCfg(merged);
    });
  }, []);

  const save = async (next) => {
    setBusy(true);
    try {
      const merged = { ...cfg, ...next };
      if (merged.multiOutputs) merged.multiOutputs = normalizeMultiOutputs(merged.multiOutputs);
      await api.store.set('multiViewSettings', merged);
      setCfg(merged);
      try {
        await api.multiView?.applyPrimaryStream?.();
      } catch { /* optional IPC */ }
    } finally {
      setBusy(false);
    }
  };

  const patchMultiOutputSlot = (index, partial) => {
    const mo = normalizeMultiOutputs(cfg.multiOutputs);
    mo[index] = { ...mo[index], ...partial };
    save({ multiOutputs: mo });
  };

  const moveAlt = (id, dir) => {
    const ids = [...(cfg.alternateSourceIds || [])];
    const i = ids.indexOf(id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    save({ alternateSourceIds: ids });
  };

  const toggleAlt = (id) => {
    const ids = new Set(cfg.alternateSourceIds || []);
    if (ids.has(id)) ids.delete(id);
    else ids.add(id);
    save({ alternateSourceIds: [...ids] });
  };

  return (
    <div className="flex-col gap-3" style={{ fontSize: 11 }}>
      <div style={{ fontSize: 10, color: 'var(--text-dim)', lineHeight: 1.5 }}>
        Add one <strong>Webcam</strong> source per physical device (USB, Bluetooth, NDI / Wi‑Fi bridge, etc.). Set{' '}
        <strong>Primary stream camera</strong> for your main broadcast (Output panel). With <strong>Multi-output</strong>{' '}
        off, tips use the alternate pool to switch the <em>single</em> stream. With Multi-output on, the primary stays on
        the main RTMP; each configured output slot can push another camera to its own RTMP URL when tips meet that row’s
        token threshold.
      </div>

      <div style={{
        padding: '10px 12px',
        background: 'var(--bg-elevated, #111)',
        border: '1px solid var(--border)',
        borderRadius: 6,
      }}>
        <div className="flex items-center justify-between" style={{ marginBottom: 8 }}>
          <span style={{ fontWeight: 600 }}>Tip-triggered camera switch</span>
          <button
            type="button"
            className={`btn btn-sm ${cfg.enabled ? 'btn-accent' : ''}`}
            style={{ fontSize: 10 }}
            disabled={busy}
            onClick={() => save({ enabled: !cfg.enabled })}
          >
            {cfg.enabled ? 'ON' : 'OFF'}
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: cfg.multiOutputEnabled ? '1fr' : '1fr 1fr', gap: 8, marginBottom: 8 }}>
          {!cfg.multiOutputEnabled && (
            <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              Min tip (tokens) — legacy
              <input
                type="number"
                min={1}
                className="input"
                style={{ width: '100%', marginTop: 4, fontSize: 11 }}
                value={cfg.tipThresholdTokens}
                onChange={(e) => setCfg((c) => ({ ...c, tipThresholdTokens: Number(e.target.value) || 1 }))}
                onBlur={() => save({ tipThresholdTokens: cfg.tipThresholdTokens })}
              />
            </label>
          )}
          {!cfg.multiOutputEnabled && (
            <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>
              Hold alternate (sec) — legacy mode
              <input
                type="number"
                min={1}
                max={120}
                className="input"
                style={{ width: '100%', marginTop: 4, fontSize: 11 }}
                value={cfg.holdSeconds}
                onChange={(e) => setCfg((c) => ({ ...c, holdSeconds: Number(e.target.value) || 8 }))}
                onBlur={() => save({ holdSeconds: cfg.holdSeconds })}
              />
            </label>
          )}
        </div>

        {cfg.multiOutputEnabled && (
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginBottom: 8, lineHeight: 1.45 }}>
            Tip thresholds and hold times are set per output row below (legacy min tip / hold fields are hidden).
          </div>
        )}

        <div style={{ marginBottom: 10 }}>
          <label className="flex items-center gap-2" style={{ fontSize: 10, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={!!cfg.multiOutputEnabled}
              disabled={busy}
              onChange={() => save({ multiOutputEnabled: !cfg.multiOutputEnabled })}
            />
            <span style={{ fontWeight: 600 }}>Multi-output (up to 8 extra RTMP feeds)</span>
          </label>
          <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4, marginLeft: 22, lineHeight: 1.45 }}>
            Each row: camera, token threshold, duration (seconds), and a separate RTMP URL + key. Different physical
            devices only — the primary stays open for preview.
          </div>
        </div>

        {cfg.multiOutputEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 12, maxHeight: '42vh', overflow: 'auto' }}>
            {normalizeMultiOutputs(cfg.multiOutputs).map((slot, index) => (
              <div
                key={index}
                style={{
                  padding: 8,
                  background: 'rgba(255,255,255,0.03)',
                  borderRadius: 4,
                  border: '1px solid var(--border)',
                }}
              >
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Output {index + 1}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'minmax(100px,1fr) 72px 72px', gap: 6, marginBottom: 6 }}>
                  <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                    Camera
                    <select
                      className="input"
                      style={{ width: '100%', marginTop: 2, fontSize: 10 }}
                      value={slot.sourceId || ''}
                      onChange={(e) => patchMultiOutputSlot(index, { sourceId: e.target.value || null })}
                    >
                      <option value="">— Off —</option>
                      {webcams.map((w) => (
                        <option key={w.id} value={w.id}>{w.name || 'Webcam'}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                    Tokens
                    <input
                      type="number"
                      min={1}
                      className="input"
                      style={{ width: '100%', marginTop: 2, fontSize: 10 }}
                      value={slot.triggerTokens}
                      onChange={(e) => {
                        const v = Math.max(1, Number(e.target.value) || 1);
                        setCfg((c) => {
                          const mo = normalizeMultiOutputs(c.multiOutputs);
                          mo[index] = { ...mo[index], triggerTokens: v };
                          const next = { ...c, multiOutputs: mo };
                          cfgRef.current = next;
                          return next;
                        });
                      }}
                      onBlur={() => save({ multiOutputs: normalizeMultiOutputs(cfgRef.current.multiOutputs) })}
                    />
                  </label>
                  <label style={{ fontSize: 9, color: 'var(--text-dim)' }}>
                    Sec
                    <input
                      type="number"
                      min={1}
                      max={600}
                      className="input"
                      style={{ width: '100%', marginTop: 2, fontSize: 10 }}
                      value={slot.durationSeconds}
                      onChange={(e) => {
                        const v = Math.min(600, Math.max(1, Number(e.target.value) || 8));
                        setCfg((c) => {
                          const mo = normalizeMultiOutputs(c.multiOutputs);
                          mo[index] = { ...mo[index], durationSeconds: v };
                          const next = { ...c, multiOutputs: mo };
                          cfgRef.current = next;
                          return next;
                        });
                      }}
                      onBlur={() => save({ multiOutputs: normalizeMultiOutputs(cfgRef.current.multiOutputs) })}
                    />
                  </label>
                </div>
                <label style={{ fontSize: 9, color: 'var(--text-dim)', display: 'block', marginBottom: 4 }}>
                  RTMP URL
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 2, fontSize: 10 }}
                    placeholder="rtmp://host/app"
                    value={slot.streamUrl || ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCfg((c) => {
                        const mo = normalizeMultiOutputs(c.multiOutputs);
                        mo[index] = { ...mo[index], streamUrl: v };
                        const next = { ...c, multiOutputs: mo };
                        cfgRef.current = next;
                        return next;
                      });
                    }}
                    onBlur={() => save({ multiOutputs: normalizeMultiOutputs(cfgRef.current.multiOutputs) })}
                  />
                </label>
                <label style={{ fontSize: 9, color: 'var(--text-dim)', display: 'block' }}>
                  Stream key
                  <input
                    className="input"
                    style={{ width: '100%', marginTop: 2, fontSize: 10 }}
                    placeholder="stream name"
                    value={slot.streamKey || ''}
                    onChange={(e) => {
                      const v = e.target.value;
                      setCfg((c) => {
                        const mo = normalizeMultiOutputs(c.multiOutputs);
                        mo[index] = { ...mo[index], streamKey: v };
                        const next = { ...c, multiOutputs: mo };
                        cfgRef.current = next;
                        return next;
                      });
                    }}
                    onBlur={() => save({ multiOutputs: normalizeMultiOutputs(cfgRef.current.multiOutputs) })}
                  />
                </label>
              </div>
            ))}
          </div>
        )}

        <div style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>Primary stream camera</div>
          <select
            className="input"
            style={{ width: '100%', fontSize: 11 }}
            value={cfg.defaultWebcamSourceId || ''}
            onChange={(e) => {
              const v = e.target.value || null;
              const alt = (cfg.alternateSourceIds || []).filter((x) => x !== v);
              save({ defaultWebcamSourceId: v, alternateSourceIds: alt });
            }}
          >
            <option value="">— Select —</option>
            {webcams.map((w) => (
              <option key={w.id} value={w.id}>{w.name || 'Webcam'}</option>
            ))}
          </select>
        </div>

        <div style={{ fontSize: 10, color: 'var(--text-secondary)', marginBottom: 4 }}>Alternate pool (legacy rotation)</div>
        {webcams.length === 0 ? (
          <div style={{ fontSize: 10, color: 'var(--text-dim)', padding: 8 }}>No webcam sources in this scene.</div>
        ) : (
          webcams.map((w) => {
            const inPool = (cfg.alternateSourceIds || []).includes(w.id);
            const isDefault = w.id === cfg.defaultWebcamSourceId;
            return (
              <div key={w.id} className="flex items-center gap-2" style={{ padding: '4px 0', fontSize: 10 }}>
                <input
                  type="checkbox"
                  checked={inPool}
                  disabled={isDefault}
                  onChange={() => toggleAlt(w.id)}
                />
                <span className="flex-1 truncate">{w.name || 'Webcam'}</span>
                {inPool && !isDefault && (
                  <span className="flex gap-1">
                    <button type="button" className="btn btn-sm btn-icon" style={{ fontSize: 9 }} onClick={() => moveAlt(w.id, -1)}>↑</button>
                    <button type="button" className="btn btn-sm btn-icon" style={{ fontSize: 9 }} onClick={() => moveAlt(w.id, 1)}>↓</button>
                  </span>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
