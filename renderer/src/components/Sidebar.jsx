import React, { useState, useMemo } from 'react';

const SOURCE_TYPE_ICONS = {
  webcam: '📷', screen_capture: '🖥️', window_capture: '🪟', game_capture: '🎮',
  image: '🖼️', text: '📝', browser: '🌐', color: '🎨', media: '🎬',
  audio_input: '🎤', audio_output: '🔊', cam_site: '🔗', lovense_overlay: '💜',
  tip_goal: '🎯', tip_menu: '📋', chat_overlay: '💬', alert_box: '🔔',
};

export default function Sidebar({
  mode, onModeChange, scenes, activeSceneId, activeScene,
  onSelectScene, onCreateScene, onDeleteScene, onRenameScene,
  onAddSource, onRemoveSource, onToggleSourceVisible, onToggleSourceLock,
  onNavigate,
}) {
  const [search, setSearch] = useState('');
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [collapsedCategories, setCollapsedCategories] = useState({});

  const platforms = useMemo(() => window.electronAPI?.getPlatforms() ?? {}, []);

  const toggleCategory = (cat) => {
    setCollapsedCategories((prev) => ({ ...prev, [cat]: !prev[cat] }));
  };

  const startRename = (id, name) => {
    setEditingId(id);
    setEditName(name);
  };

  const commitRename = () => {
    if (editingId && editName.trim()) {
      onRenameScene(editingId, editName.trim());
    }
    setEditingId(null);
  };

  return (
    <div
      className="flex-col"
      style={{
        width: 'var(--sidebar-w)', minWidth: 200,
        background: 'var(--bg-secondary)', borderRight: '1px solid var(--border)',
        overflow: 'hidden',
      }}
    >
      {/* Mode Toggle */}
      <div className="flex" style={{ borderBottom: '1px solid var(--border)' }}>
        <button
          className={`btn flex-1 ${mode === 'scenes' ? 'btn-accent' : ''}`}
          style={{ borderRadius: 0, fontSize: 10 }}
          onClick={() => onModeChange('scenes')}
        >
          🎬 OBS
        </button>
        <button
          className={`btn flex-1 ${mode === 'platforms' ? 'btn-accent' : ''}`}
          style={{ borderRadius: 0, fontSize: 10 }}
          onClick={() => onModeChange('platforms')}
        >
          🔗 Sites
        </button>
      </div>

      {mode === 'scenes' ? (
        <>
          {/* Scenes Panel */}
          <div className="section-header">
            <span>Scenes</span>
            <button className="btn btn-sm btn-icon" onClick={onCreateScene} title="Add Scene">+</button>
          </div>
          <div className="flex-col" style={{ maxHeight: 180, overflow: 'auto', padding: 4 }}>
            {scenes.map((scene) => (
              <div
                key={scene.id}
                className={`list-item ${scene.id === activeSceneId ? 'active' : ''}`}
                onClick={() => onSelectScene(scene.id)}
                onDoubleClick={() => startRename(scene.id, scene.name)}
              >
                {editingId === scene.id ? (
                  <input
                    className="input"
                    value={editName}
                    onChange={(e) => setEditName(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => e.key === 'Enter' && commitRename()}
                    autoFocus
                    style={{ width: '100%', fontSize: 11 }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <span className="name truncate">🎬 {scene.name}</span>
                    {scenes.length > 1 && (
                      <button
                        className="btn btn-sm btn-icon"
                        onClick={(e) => { e.stopPropagation(); onDeleteScene(scene.id); }}
                        style={{ fontSize: 9, opacity: 0.5 }}
                        title="Delete Scene"
                      >✕</button>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Sources Panel */}
          <div className="section-header">
            <span>Sources</span>
            <button className="btn btn-sm btn-icon" onClick={onAddSource} title="Add Source">+</button>
          </div>
          <div className="flex-col flex-1" style={{ overflow: 'auto', padding: 4 }}>
            {activeScene?.sources?.length === 0 && (
              <div style={{ padding: 12, textAlign: 'center', color: 'var(--text-dim)', fontSize: 10 }}>
                No sources. Click + to add.
              </div>
            )}
            {(activeScene?.sources || []).map((source) => (
              <div key={source.id} className="list-item" style={{ gap: 4 }}>
                <span style={{ fontSize: 12 }}>{SOURCE_TYPE_ICONS[source.type] || '📦'}</span>
                <span className="name truncate" style={{ fontSize: 11 }}>{source.name}</span>
                <button
                  className="btn btn-sm btn-icon"
                  onClick={() => onToggleSourceVisible(source.id)}
                  style={{ opacity: source.visible ? 1 : 0.3, fontSize: 10 }}
                  title={source.visible ? 'Hide' : 'Show'}
                >👁️</button>
                <button
                  className="btn btn-sm btn-icon"
                  onClick={() => onToggleSourceLock(source.id)}
                  style={{ opacity: source.locked ? 1 : 0.3, fontSize: 10 }}
                  title={source.locked ? 'Unlock' : 'Lock'}
                >{source.locked ? '🔒' : '🔓'}</button>
                <button
                  className="btn btn-sm btn-icon"
                  onClick={() => onRemoveSource(source.id)}
                  style={{ fontSize: 9, opacity: 0.5 }}
                  title="Remove"
                >✕</button>
              </div>
            ))}
          </div>
        </>
      ) : (
        <>
          {/* Platform Browser */}
          <div style={{ padding: 4 }}>
            <input
              className="input"
              style={{ width: '100%' }}
              placeholder="Search platforms..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <div className="flex-col flex-1" style={{ overflow: 'auto' }}>
            {Object.entries(platforms).map(([category, items]) => {
              const filtered = items.filter((p) =>
                !search || p.name.toLowerCase().includes(search.toLowerCase())
              );
              if (!filtered.length) return null;

              return (
                <div key={category}>
                  <div
                    className="section-header"
                    style={{ cursor: 'pointer' }}
                    onClick={() => toggleCategory(category)}
                  >
                    <span>{collapsedCategories[category] ? '▶' : '▼'} {category}</span>
                    <span style={{ fontSize: 9 }}>{filtered.length}</span>
                  </div>
                  {!collapsedCategories[category] && filtered.map((p) => (
                    <div
                      key={p.name}
                      className="list-item"
                      onClick={() => onNavigate(p.url)}
                    >
                      <span style={{ fontSize: 12 }}>{p.icon}</span>
                      <span className="name truncate">{p.name}</span>
                      {p.tracked && <span className="badge badge-accent" style={{ fontSize: 7 }}>⚡</span>}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
