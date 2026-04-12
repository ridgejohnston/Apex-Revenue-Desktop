import React, { useRef, useEffect, useState, useCallback } from 'react';

const SOURCE_COLORS = {
  webcam: '#7c5cfc', screen_capture: '#2ed573', window_capture: '#ffa502',
  image: '#ff6b81', text: '#1e90ff', browser: '#ff4757', color: '#00d2d3',
  media: '#ff9ff3', cam_site: '#ffc312', lovense_overlay: '#9b59b6',
  tip_goal: '#2ed573', tip_menu: '#e056fd', chat_overlay: '#00b894',
  alert_box: '#fdcb6e',
};

export default function PreviewCanvas({ scene, streamStatus }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });
  const [selectedSource, setSelectedSource] = useState(null);
  const [dragging, setDragging] = useState(null);

  // Fit canvas to container while maintaining 16:9
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const aspectRatio = 16 / 9;
      let w = rect.width - 16;
      let h = w / aspectRatio;
      if (h > rect.height - 16) {
        h = rect.height - 16;
        w = h * aspectRatio;
      }
      setCanvasSize({ width: Math.floor(w), height: Math.floor(h) });
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Draw scene preview
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    // Clear
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    if (!scene?.sources?.length) {
      // Empty scene placeholder
      ctx.fillStyle = '#1a1a26';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#33335a';
      ctx.font = 'bold 24px -apple-system, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('⚡ APEX REVENUE', canvas.width / 2, canvas.height / 2 - 20);
      ctx.font = '14px -apple-system, sans-serif';
      ctx.fillStyle = '#55556a';
      ctx.fillText('Add sources to build your scene', canvas.width / 2, canvas.height / 2 + 15);
      return;
    }

    const scaleX = canvas.width / 1920;
    const scaleY = canvas.height / 1080;

    // Draw sources bottom-to-top (first = bottom layer)
    scene.sources.forEach((source) => {
      if (!source.visible) return;

      const x = source.transform.x * scaleX;
      const y = source.transform.y * scaleY;
      const w = source.transform.width * scaleX;
      const h = source.transform.height * scaleY;

      ctx.globalAlpha = source.opacity;

      // Source type visualization
      const color = SOURCE_COLORS[source.type] || '#666';

      if (source.type === 'color') {
        ctx.fillStyle = source.properties?.color || '#000';
        ctx.fillRect(x, y, w, h);
      } else if (source.type === 'text') {
        ctx.fillStyle = 'rgba(0,0,0,0.3)';
        ctx.fillRect(x, y, w, h);
        ctx.fillStyle = source.properties?.color || '#fff';
        ctx.font = `${(source.properties?.fontSize || 48) * scaleY}px ${source.properties?.fontFamily || 'sans-serif'}`;
        ctx.textAlign = 'left';
        ctx.fillText(source.properties?.text || 'Text', x + 8, y + h / 2 + 6);
      } else {
        // Generic source representation
        ctx.fillStyle = color + '22';
        ctx.fillRect(x, y, w, h);
        ctx.strokeStyle = color;
        ctx.lineWidth = source.id === selectedSource ? 2 : 1;
        ctx.strokeRect(x, y, w, h);

        // Source icon and name
        ctx.fillStyle = color;
        ctx.font = `${12 * Math.max(scaleX, scaleY)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText(source.name, x + w / 2, y + h / 2);
      }

      // Selection handles
      if (source.id === selectedSource) {
        ctx.globalAlpha = 1;
        const handleSize = 6;
        ctx.fillStyle = '#fff';
        // Corners
        [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([hx, hy]) => {
          ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        });
        // Edge midpoints
        [[x + w / 2, y], [x + w / 2, y + h], [x, y + h / 2], [x + w, y + h / 2]].forEach(([hx, hy]) => {
          ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        });
      }

      ctx.globalAlpha = 1;
    });
  }, [scene, canvasSize, selectedSource]);

  // Handle click to select source
  const handleCanvasClick = useCallback((e) => {
    if (!scene?.sources?.length) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 1920;
    const my = ((e.clientY - rect.top) / rect.height) * 1080;

    // Find topmost source under mouse (iterate reverse = top layer first)
    for (let i = scene.sources.length - 1; i >= 0; i--) {
      const s = scene.sources[i];
      if (!s.visible) continue;
      const { x, y, width, height } = s.transform;
      if (mx >= x && mx <= x + width && my >= y && my <= y + height) {
        setSelectedSource(s.id);
        return;
      }
    }
    setSelectedSource(null);
  }, [scene]);

  return (
    <div
      ref={containerRef}
      className="flex-1"
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'var(--bg-primary)', position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Status overlay */}
      <div style={{
        position: 'absolute', top: 8, right: 8,
        display: 'flex', gap: 4, zIndex: 10,
      }}>
        {streamStatus.streaming && <span className="badge badge-live">LIVE</span>}
        {streamStatus.recording && <span className="badge badge-danger" style={{ background: 'var(--live-red-dim)', color: 'var(--live-red)' }}>● REC</span>}
        {streamStatus.virtualCam && <span className="badge badge-success">VCAM</span>}
      </div>

      {/* Stream stats overlay */}
      {streamStatus.streaming && (
        <div style={{
          position: 'absolute', bottom: 8, right: 8,
          display: 'flex', gap: 8, fontSize: 9, color: 'var(--text-dim)', zIndex: 10,
        }}>
          <span>{streamStatus.fps || 0} FPS</span>
          <span>{streamStatus.bitrate || 0} kbps</span>
          <span>{streamStatus.droppedFrames || 0} dropped</span>
          <span>{formatUptime(streamStatus.streamUptime)}</span>
        </div>
      )}

      <canvas
        ref={canvasRef}
        width={canvasSize.width}
        height={canvasSize.height}
        onClick={handleCanvasClick}
        style={{
          width: canvasSize.width,
          height: canvasSize.height,
          borderRadius: 4,
          cursor: 'crosshair',
        }}
      />
    </div>
  );
}

function formatUptime(seconds) {
  if (!seconds) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
