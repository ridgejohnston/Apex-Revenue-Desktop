import React, { useEffect, useState, useRef } from 'react';

const api = window.electronAPI;

// ── Debug Panel ──────────────────────────────────────────
// Modal that shows recent errors and offers one-click actions:
//   • Copy to Clipboard — pulls the full log, ready to paste
//   • Open Log Folder   — Explorer at %APPDATA%/apex-revenue-desktop/logs
//   • Refresh           — reload from the in-memory buffer
//   • Clear             — truncate the log (with confirm)
//
// The primary workflow is the Copy button: Ridge hits it, pastes into
// a chat with the dev/AI assistant, and the assistant has everything
// it needs (main + renderer errors, redacted of stream keys & AWS
// creds) to diagnose.
export default function DebugPanel({ onClose }) {
  const [entries, setEntries] = useState('');
  const [loading, setLoading] = useState(true);
  const [copiedFlash, setCopiedFlash] = useState(false);
  const [clearConfirm, setClearConfirm] = useState(false);
  const scrollRef = useRef(null);

  const loadEntries = async () => {
    setLoading(true);
    try {
      // recent() is fast (in-memory buffer); readAll() hits disk. Use
      // recent for the interactive view — the Copy button still grabs
      // the full log via its own IPC call.
      const text = await api.errors.recent(300);
      setEntries(text || '(no errors yet — this is a good thing)');
    } catch (err) {
      setEntries(`Failed to load errors: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadEntries();
  }, []);

  // Auto-scroll to bottom (newest entries) whenever the log refreshes.
  useEffect(() => {
    if (scrollRef.current && !loading) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [entries, loading]);

  const handleCopy = async () => {
    try {
      const result = await api.errors.copyToClipboard();
      if (result && result.ok) {
        setCopiedFlash(true);
        setTimeout(() => setCopiedFlash(false), 2000);
      }
    } catch (err) {
      console.warn('Copy failed:', err.message);
    }
  };

  const handleOpenFolder = async () => {
    try {
      await api.errors.openFolder();
    } catch (err) {
      console.warn('Open folder failed:', err.message);
    }
  };

  const handleClear = async () => {
    if (!clearConfirm) {
      setClearConfirm(true);
      setTimeout(() => setClearConfirm(false), 3000);
      return;
    }
    try {
      await api.errors.clear();
      setClearConfirm(false);
      loadEntries();
    } catch (err) {
      console.warn('Clear failed:', err.message);
    }
  };

  // Line colorizer — picks color by level tag so scanning is easier.
  // Lines look like "[2026-04-18T...] [ERROR] [source] message"
  const renderLine = (line, i) => {
    let color = 'var(--text-secondary)';
    if (line.includes('] [FATAL]')) color = '#f87171';
    else if (line.includes('] [ERROR]')) color = '#fb923c';
    else if (line.includes('] [WARN]')) color = '#fbbf24';
    else if (line.includes('] [INFO]')) color = '#60a5fa';
    return (
      <div key={i} style={{ color, wordBreak: 'break-word', lineHeight: 1.45 }}>
        {line}
      </div>
    );
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.65)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 1000,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: 'min(860px, 92vw)', maxHeight: '85vh',
          background: 'var(--bg-primary, #0a0a0f)',
          border: '1px solid var(--border, rgba(255,255,255,0.08))',
          borderRadius: 8, display: 'flex', flexDirection: 'column',
        }}
      >
        {/* Header */}
        <div style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' }}>
              🐛 Debug & Error Log
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-dim)', marginTop: 2 }}>
              Paste this to your developer or AI assistant for troubleshooting. Stream keys and credentials are redacted automatically.
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'transparent', border: 'none', color: 'var(--text-dim)',
              cursor: 'pointer', fontSize: 18, padding: 4, lineHeight: 1,
            }}
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Log viewer */}
        <div
          ref={scrollRef}
          style={{
            flex: 1, overflow: 'auto', padding: 12,
            background: 'var(--bg-secondary, #070710)',
            fontFamily: 'Consolas, Menlo, "Courier New", monospace',
            fontSize: 10,
            minHeight: 240,
          }}
        >
          {loading ? (
            <div style={{ color: 'var(--text-dim)' }}>Loading…</div>
          ) : (
            entries.split('\n').map(renderLine)
          )}
        </div>

        {/* Action bar */}
        <div style={{
          padding: '10px 14px',
          borderTop: '1px solid var(--border, rgba(255,255,255,0.08))',
          display: 'flex', gap: 8, flexWrap: 'wrap',
        }}>
          <button
            onClick={handleCopy}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 600,
              background: copiedFlash ? '#10b981' : 'var(--accent, #6366f1)',
              color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer',
              transition: 'background 0.15s',
            }}
          >
            {copiedFlash ? '✓ Copied to Clipboard' : '📋 Copy to Clipboard'}
          </button>
          <button
            onClick={handleOpenFolder}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 600,
              background: 'var(--bg-secondary, rgba(255,255,255,0.05))',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border, rgba(255,255,255,0.08))',
              borderRadius: 4, cursor: 'pointer',
            }}
          >
            📁 Open Log Folder
          </button>
          <button
            onClick={loadEntries}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 600,
              background: 'var(--bg-secondary, rgba(255,255,255,0.05))',
              color: 'var(--text-secondary)',
              border: '1px solid var(--border, rgba(255,255,255,0.08))',
              borderRadius: 4, cursor: 'pointer',
            }}
          >
            🔄 Refresh
          </button>
          <div style={{ flex: 1 }} />
          <button
            onClick={handleClear}
            style={{
              padding: '6px 14px', fontSize: 11, fontWeight: 600,
              background: clearConfirm ? '#dc2626' : 'transparent',
              color: clearConfirm ? '#fff' : 'var(--text-dim)',
              border: `1px solid ${clearConfirm ? '#dc2626' : 'var(--border, rgba(255,255,255,0.08))'}`,
              borderRadius: 4, cursor: 'pointer',
            }}
          >
            {clearConfirm ? '🗑️ Click again to confirm' : '🗑️ Clear Log'}
          </button>
        </div>
      </div>
    </div>
  );
}
