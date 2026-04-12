import React, { useState, useEffect } from 'react';

const SOURCE_TYPES = [
  { type: 'webcam',          name: 'Webcam',            icon: '📷', category: 'Video',  desc: 'Camera/video capture device' },
  { type: 'screen_capture',  name: 'Screen Capture',    icon: '🖥️', category: 'Video',  desc: 'Capture entire display' },
  { type: 'window_capture',  name: 'Window Capture',    icon: '🪟', category: 'Video',  desc: 'Capture a specific window' },
  { type: 'game_capture',    name: 'Game Capture',      icon: '🎮', category: 'Video',  desc: 'Capture fullscreen games' },
  { type: 'image',           name: 'Image',             icon: '🖼️', category: 'Media',  desc: 'Display a static image' },
  { type: 'image_slideshow', name: 'Image Slideshow',   icon: '🎞️', category: 'Media',  desc: 'Rotate through images' },
  { type: 'media',           name: 'Media Source',      icon: '🎬', category: 'Media',  desc: 'Video/audio file playback' },
  { type: 'text',            name: 'Text (GDI+)',       icon: '📝', category: 'Display', desc: 'Custom text overlay' },
  { type: 'browser',         name: 'Browser Source',    icon: '🌐', category: 'Display', desc: 'Embed a webpage/widget' },
  { type: 'color',           name: 'Color Source',      icon: '🎨', category: 'Display', desc: 'Solid color background' },
  { type: 'audio_input',     name: 'Audio Input',       icon: '🎤', category: 'Audio',  desc: 'Microphone/line input' },
  { type: 'audio_output',    name: 'Audio Output',      icon: '🔊', category: 'Audio',  desc: 'Desktop/system audio' },
  // Cam-site specific
  { type: 'cam_site',        name: 'Cam Site Embed',    icon: '🔗', category: 'Cam',    desc: 'Embed a cam platform page' },
  { type: 'lovense_overlay', name: 'Lovense Overlay',   icon: '💜', category: 'Cam',    desc: 'Lovense toy status/control' },
  { type: 'tip_goal',        name: 'Tip Goal',          icon: '🎯', category: 'Cam',    desc: 'Animated tip goal progress bar' },
  { type: 'tip_menu',        name: 'Tip Menu',          icon: '📋', category: 'Cam',    desc: 'Interactive tip menu overlay' },
  { type: 'chat_overlay',    name: 'Chat Overlay',      icon: '💬', category: 'Cam',    desc: 'Display live chat on screen' },
  { type: 'alert_box',       name: 'Alert Box',         icon: '🔔', category: 'Cam',    desc: 'Tip/follow/raid alerts' },
];

const CATEGORIES = ['Video', 'Media', 'Display', 'Audio', 'Cam'];

export default function AddSourceModal({ onAdd, onClose }) {
  const [selected, setSelected] = useState(null);
  const [name, setName] = useState('');
  const [properties, setProperties] = useState({});
  const [screens, setScreens] = useState([]);
  const [windows, setWindows] = useState([]);

  const api = window.electronAPI;

  useEffect(() => {
    // Pre-load screen/window sources
    api.sources.getScreens().then(setScreens).catch(() => {});
    api.sources.getWindows().then(setWindows).catch(() => {});
  }, []);

  const handleSelect = (type) => {
    setSelected(type);
    setName(type.name);
    setProperties({});
  };

  const handleAdd = () => {
    if (!selected) return;
    onAdd({
      type: selected.type,
      name: name || selected.name,
      properties,
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 520, maxHeight: '80vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div className="modal-title">Add Source</div>

        <div className="flex flex-1" style={{ overflow: 'hidden', gap: 12 }}>
          {/* Source Type List */}
          <div style={{ width: 220, overflow: 'auto' }}>
            {CATEGORIES.map((cat) => (
              <div key={cat}>
                <div style={{ fontSize: 9, fontWeight: 600, color: 'var(--text-dim)', padding: '6px 4px 2px', textTransform: 'uppercase' }}>
                  {cat}
                </div>
                {SOURCE_TYPES.filter((s) => s.category === cat).map((s) => (
                  <div
                    key={s.type}
                    className={`list-item ${selected?.type === s.type ? 'active' : ''}`}
                    onClick={() => handleSelect(s)}
                  >
                    <span style={{ fontSize: 13 }}>{s.icon}</span>
                    <div>
                      <div className="name" style={{ fontSize: 11 }}>{s.name}</div>
                      <div style={{ fontSize: 9, color: 'var(--text-dim)' }}>{s.desc}</div>
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Properties Panel */}
          <div className="flex-col flex-1" style={{ overflow: 'auto' }}>
            {!selected ? (
              <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)', fontSize: 11 }}>
                Select a source type from the left
              </div>
            ) : (
              <div className="flex-col gap-2">
                <div>
                  <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Source Name</label>
                  <input
                    className="input" style={{ width: '100%' }}
                    value={name} onChange={(e) => setName(e.target.value)}
                  />
                </div>

                {/* Type-specific properties */}
                {selected.type === 'text' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Text</label>
                      <textarea
                        className="input" style={{ width: '100%', height: 60, resize: 'vertical' }}
                        value={properties.text || ''} onChange={(e) => setProperties({ ...properties, text: e.target.value })}
                        placeholder="Enter your text..."
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Font Size</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.fontSize || 48} onChange={(e) => setProperties({ ...properties, fontSize: parseInt(e.target.value) })} />
                      </div>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Color</label>
                        <input type="color" style={{ width: '100%', height: 26 }}
                          value={properties.color || '#ffffff'} onChange={(e) => setProperties({ ...properties, color: e.target.value })} />
                      </div>
                    </div>
                  </>
                )}

                {selected.type === 'browser' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>URL</label>
                    <input className="input" style={{ width: '100%' }}
                      value={properties.url || ''} onChange={(e) => setProperties({ ...properties, url: e.target.value })}
                      placeholder="https://..." />
                    <div className="flex gap-2" style={{ marginTop: 4 }}>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Width</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.width || 800} onChange={(e) => setProperties({ ...properties, width: parseInt(e.target.value) })} />
                      </div>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Height</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.height || 600} onChange={(e) => setProperties({ ...properties, height: parseInt(e.target.value) })} />
                      </div>
                    </div>
                  </div>
                )}

                {selected.type === 'color' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Color</label>
                    <input type="color" style={{ width: '100%', height: 40 }}
                      value={properties.color || '#000000'} onChange={(e) => setProperties({ ...properties, color: e.target.value })} />
                  </div>
                )}

                {selected.type === 'image' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Image Path</label>
                    <input className="input" style={{ width: '100%' }}
                      value={properties.path || ''} onChange={(e) => setProperties({ ...properties, path: e.target.value })}
                      placeholder="C:\path\to\image.png" />
                  </div>
                )}

                {selected.type === 'screen_capture' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Screen</label>
                    {screens.map((s) => (
                      <div key={s.id} className={`list-item ${properties.sourceId === s.id ? 'active' : ''}`}
                        onClick={() => setProperties({ ...properties, sourceId: s.id })}>
                        <span className="name">{s.name}</span>
                      </div>
                    ))}
                  </div>
                )}

                {selected.type === 'window_capture' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Window</label>
                    <div style={{ maxHeight: 150, overflow: 'auto' }}>
                      {windows.map((w) => (
                        <div key={w.id} className={`list-item ${properties.sourceId === w.id ? 'active' : ''}`}
                          onClick={() => setProperties({ ...properties, sourceId: w.id })}>
                          <span className="name truncate" style={{ fontSize: 10 }}>{w.name}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {selected.type === 'tip_goal' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Goal Amount (tokens)</label>
                      <input className="input" type="number" style={{ width: '100%' }}
                        value={properties.goalAmount || 1000} onChange={(e) => setProperties({ ...properties, goalAmount: parseInt(e.target.value) })} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Goal Label</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.goalLabel || 'Tip Goal'} onChange={(e) => setProperties({ ...properties, goalLabel: e.target.value })} />
                    </div>
                  </>
                )}

                {selected.type === 'tip_menu' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Menu Items (one per line: amount - description)</label>
                    <textarea className="input" style={{ width: '100%', height: 100, resize: 'vertical' }}
                      value={properties.menuItems || '15 - Flash\n25 - PM\n50 - Control toy 1min\n100 - Song request'}
                      onChange={(e) => setProperties({ ...properties, menuItems: e.target.value })}
                    />
                  </div>
                )}

                {selected.type === 'lovense_overlay' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Lovense API Token</label>
                    <input className="input" style={{ width: '100%' }} type="password"
                      value={properties.apiToken || ''} onChange={(e) => setProperties({ ...properties, apiToken: e.target.value })}
                      placeholder="From Lovense Connect app" />
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', marginTop: 4 }}>
                      Shows toy connection status and tip-to-vibration feedback.
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex justify-between" style={{ marginTop: 12 }}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-accent" onClick={handleAdd} disabled={!selected}>
            Add Source
          </button>
        </div>
      </div>
    </div>
  );
}
