import React, { useState, useEffect } from 'react';

const SOURCE_TYPES = [
  { type: 'webcam',          name: 'Webcam',            icon: '📷', category: 'Video',  desc: 'Camera/video capture device' },
  { type: 'screen_capture',  name: 'Screen Capture',    icon: '🖥️', category: 'Video',  desc: 'Capture entire display' },
  { type: 'window_capture',  name: 'Window Capture',    icon: '🪟', category: 'Video',  desc: 'Capture a specific window' },
  { type: 'game_capture',    name: 'Game Capture',      icon: '🎮', category: 'Video',  desc: 'Capture fullscreen games' },
  { type: 'image',           name: 'Image',             icon: '🖼️', category: 'Media',  desc: 'Display a static image file' },
  { type: 'image_url',       name: 'Image URL',         icon: '🌅', category: 'Media',  desc: 'Display an image from a URL' },
  { type: 'image_slideshow', name: 'Image Slideshow',   icon: '🎞️', category: 'Media',  desc: 'Rotate through images' },
  { type: 'media',           name: 'Video File',        icon: '🎬', category: 'Media',  desc: 'Play back a local video/audio file' },
  { type: 'video_url',       name: 'Video URL',         icon: '🎥', category: 'Media',  desc: 'Play back a video from a URL' },
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
  const [cameras, setCameras] = useState([]);
  const [audioInputs, setAudioInputs] = useState([]);
  const [audioOutputs, setAudioOutputs] = useState([]);
  const [devicesLoading, setDevicesLoading] = useState(false);

  const api = window.electronAPI;

  useEffect(() => {
    // Pre-load screen/window sources
    api.sources.getScreens().then(setScreens).catch(() => {});
    api.sources.getWindows().then(setWindows).catch(() => {});

    // Enumerate media devices via browser API (cameras + mics + speakers)
    if (navigator.mediaDevices?.enumerateDevices) {
      setDevicesLoading(true);
      navigator.mediaDevices
        .enumerateDevices()
        .then((devices) => {
          setCameras(devices.filter((d) => d.kind === 'videoinput'));
          setAudioInputs(devices.filter((d) => d.kind === 'audioinput'));
          setAudioOutputs(devices.filter((d) => d.kind === 'audiooutput'));
        })
        .catch(() => {})
        .finally(() => setDevicesLoading(false));
    }
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

  const prop = (key, val) => setProperties((p) => ({ ...p, [key]: val }));

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 540, maxHeight: '82vh', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
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
                {/* Source Name */}
                <div>
                  <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Source Name</label>
                  <input
                    className="input" style={{ width: '100%' }}
                    value={name} onChange={(e) => setName(e.target.value)}
                  />
                </div>

                {/* ── Webcam ── */}
                {selected.type === 'webcam' && (
                  <DeviceDropdown
                    label="Camera Device"
                    devices={cameras}
                    value={properties.deviceId || ''}
                    onChange={(val, label) => { prop('deviceId', val); prop('deviceLabel', label); }}
                    loading={devicesLoading}
                    emptyMsg="No cameras detected"
                  />
                )}

                {/* ── Screen Capture ── */}
                {selected.type === 'screen_capture' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Display</label>
                    <div style={{ maxHeight: 160, overflow: 'auto' }}>
                      {screens.map((s) => (
                        <ScreenTile
                          key={s.id}
                          item={s}
                          selected={properties.sourceId === s.id}
                          onClick={() => prop('sourceId', s.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

                {/* ── Window / Game Capture ── */}
                {(selected.type === 'window_capture' || selected.type === 'game_capture') && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                      {selected.type === 'game_capture' ? 'Game / Process' : 'Window'}
                    </label>
                    <div style={{ maxHeight: 180, overflow: 'auto' }}>
                      {windows.map((w) => (
                        <ScreenTile
                          key={w.id}
                          item={w}
                          selected={properties.sourceId === w.id}
                          onClick={() => prop('sourceId', w.id)}
                          compact
                        />
                      ))}
                      {windows.length === 0 && (
                        <div style={{ fontSize: 10, color: 'var(--text-dim)', padding: 8 }}>
                          No windows detected
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* ── Audio Input ── */}
                {selected.type === 'audio_input' && (
                  <DeviceDropdown
                    label="Input Device (Microphone)"
                    devices={audioInputs}
                    value={properties.deviceId || ''}
                    onChange={(val, label) => { prop('deviceId', val); prop('deviceLabel', label); prop('dshowName', label); }}
                    loading={devicesLoading}
                    emptyMsg="No input devices detected"
                  />
                )}

                {/* ── Audio Output ── */}
                {selected.type === 'audio_output' && (
                  <DeviceDropdown
                    label="Output Device (Speakers)"
                    devices={audioOutputs}
                    value={properties.deviceId || ''}
                    onChange={(val, label) => { prop('deviceId', val); prop('deviceLabel', label); prop('dshowName', label); }}
                    loading={devicesLoading}
                    emptyMsg="No output devices detected"
                  />
                )}

                {/* ── Image ── */}
                {selected.type === 'image' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Image File Path</label>
                    <input className="input" style={{ width: '100%' }}
                      value={properties.path || ''} onChange={(e) => prop('path', e.target.value)}
                      placeholder="C:\path\to\image.png" />
                  </div>
                )}

                {/* ── Image URL ── */}
                {selected.type === 'image_url' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Image URL</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.url || ''} onChange={(e) => prop('url', e.target.value)}
                        placeholder="https://example.com/banner.png" />
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                      Supports direct image links (PNG, JPG, WebP, GIF). The image loads
                      once when the source becomes visible and re-fetches if the URL
                      changes.
                    </div>
                  </>
                )}

                {/* ── Video URL ── */}
                {selected.type === 'video_url' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Video URL</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.url || ''} onChange={(e) => prop('url', e.target.value)}
                        placeholder="https://example.com/video.mp4" />
                    </div>
                    <div className="flex gap-2">
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={properties.loop || false}
                          onChange={(e) => prop('loop', e.target.checked)} />
                        Loop
                      </label>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={properties.muted || false}
                          onChange={(e) => prop('muted', e.target.checked)} />
                        Muted
                      </label>
                    </div>
                    <div style={{ fontSize: 9, color: 'var(--text-dim)', lineHeight: 1.4 }}>
                      Supports direct video links (MP4, WebM) and HLS streams (.m3u8).
                      YouTube/Twitch URLs are not supported — use Browser Source for
                      those platforms.
                    </div>
                  </>
                )}

                {/* ── Image Slideshow ── */}
                {selected.type === 'image_slideshow' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Folder Path</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.folderPath || ''} onChange={(e) => prop('folderPath', e.target.value)}
                        placeholder="C:\path\to\images\" />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Slide Interval (seconds)</label>
                      <input className="input" type="number" style={{ width: '100%' }}
                        value={properties.interval || 5} min={1} max={60}
                        onChange={(e) => prop('interval', parseInt(e.target.value))} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Transition</label>
                      <select className="input" style={{ width: '100%' }}
                        value={properties.transition || 'fade'}
                        onChange={(e) => prop('transition', e.target.value)}>
                        <option value="fade">Fade</option>
                        <option value="cut">Cut</option>
                        <option value="slide">Slide</option>
                      </select>
                    </div>
                  </>
                )}

                {/* ── Media Source ── */}
                {selected.type === 'media' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>File Path</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.path || ''} onChange={(e) => prop('path', e.target.value)}
                        placeholder="C:\path\to\video.mp4" />
                    </div>
                    <div className="flex gap-2">
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={properties.loop || false}
                          onChange={(e) => prop('loop', e.target.checked)} />
                        Loop
                      </label>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'flex', alignItems: 'center', gap: 4 }}>
                        <input type="checkbox" checked={properties.restartOnActive || false}
                          onChange={(e) => prop('restartOnActive', e.target.checked)} />
                        Restart when active
                      </label>
                    </div>
                  </>
                )}

                {/* ── Text ── */}
                {selected.type === 'text' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Text</label>
                      <textarea
                        className="input" style={{ width: '100%', height: 60, resize: 'vertical' }}
                        value={properties.text || ''} onChange={(e) => prop('text', e.target.value)}
                        placeholder="Enter your text..."
                      />
                    </div>
                    <div className="flex gap-2">
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Font Size</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.fontSize || 48} onChange={(e) => prop('fontSize', parseInt(e.target.value))} />
                      </div>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Color</label>
                        <input type="color" style={{ width: '100%', height: 26 }}
                          value={properties.color || '#ffffff'} onChange={(e) => prop('color', e.target.value)} />
                      </div>
                    </div>
                  </>
                )}

                {/* ── Browser Source ── */}
                {selected.type === 'browser' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>URL</label>
                    <input className="input" style={{ width: '100%' }}
                      value={properties.url || ''} onChange={(e) => prop('url', e.target.value)}
                      placeholder="https://..." />
                    <div className="flex gap-2" style={{ marginTop: 4 }}>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Width</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.width || 800} onChange={(e) => prop('width', parseInt(e.target.value))} />
                      </div>
                      <div className="flex-1">
                        <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Height</label>
                        <input className="input" type="number" style={{ width: '100%' }}
                          value={properties.height || 600} onChange={(e) => prop('height', parseInt(e.target.value))} />
                      </div>
                    </div>
                  </div>
                )}

                {/* ── Color Source ── */}
                {selected.type === 'color' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Color</label>
                    <input type="color" style={{ width: '100%', height: 40 }}
                      value={properties.color || '#000000'} onChange={(e) => prop('color', e.target.value)} />
                  </div>
                )}

                {/* ── Tip Goal ── */}
                {selected.type === 'tip_goal' && (
                  <>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Goal Amount (tokens)</label>
                      <input className="input" type="number" style={{ width: '100%' }}
                        value={properties.goalAmount || 1000} onChange={(e) => prop('goalAmount', parseInt(e.target.value))} />
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Goal Label</label>
                      <input className="input" style={{ width: '100%' }}
                        value={properties.goalLabel || 'Tip Goal'} onChange={(e) => prop('goalLabel', e.target.value)} />
                    </div>
                  </>
                )}

                {/* ── Tip Menu ── */}
                {selected.type === 'tip_menu' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Menu Items (one per line: amount - description)</label>
                    <textarea className="input" style={{ width: '100%', height: 100, resize: 'vertical' }}
                      value={properties.menuItems || '15 - Flash\n25 - PM\n50 - Control toy 1min\n100 - Song request'}
                      onChange={(e) => prop('menuItems', e.target.value)}
                    />
                  </div>
                )}

                {/* ── Lovense Overlay ── */}
                {selected.type === 'lovense_overlay' && (
                  <div>
                    <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>Lovense API Token</label>
                    <input className="input" style={{ width: '100%' }} type="password"
                      value={properties.apiToken || ''} onChange={(e) => prop('apiToken', e.target.value)}
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

// ── Device Dropdown ──────────────────────────────────────
function DeviceDropdown({ label, devices, value, onChange, loading, emptyMsg }) {
  return (
    <div>
      <label style={{ fontSize: 10, color: 'var(--text-dim)' }}>{label}</label>
      {loading ? (
        <div style={{ fontSize: 10, color: 'var(--text-dim)', padding: '4px 0' }}>
          Detecting devices...
        </div>
      ) : devices.length === 0 ? (
        <div style={{ fontSize: 10, color: 'var(--warning)', padding: '4px 0' }}>
          {emptyMsg}
        </div>
      ) : (
        <select
          className="input" style={{ width: '100%' }}
          value={value}
          onChange={(e) => {
            const opt = e.target.options[e.target.selectedIndex];
            onChange(e.target.value, opt.text);
          }}
        >
          <option value="">— Select device —</option>
          {devices.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {d.label || `Device ${d.deviceId.slice(0, 8)}`}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

// ── Screen / Window Tile ─────────────────────────────────
function ScreenTile({ item, selected, onClick, compact }) {
  return (
    <div
      className={`list-item ${selected ? 'active' : ''}`}
      onClick={onClick}
      style={{ gap: 8, padding: '4px 6px' }}
    >
      {item.thumbnail && !compact && (
        <img
          src={item.thumbnail}
          alt=""
          style={{ width: 64, height: 36, objectFit: 'cover', borderRadius: 2, flexShrink: 0, border: '1px solid var(--border)' }}
        />
      )}
      <span className="name truncate" style={{ fontSize: 10 }}>{item.name}</span>
    </div>
  );
}
