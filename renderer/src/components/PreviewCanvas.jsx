import React, { useRef, useEffect, useState, useCallback } from 'react';

const SOURCE_COLORS = {
  webcam: '#7c5cfc', screen_capture: '#2ed573', window_capture: '#ffa502',
  image: '#ff6b81', text: '#1e90ff', browser: '#ff4757', color: '#00d2d3',
  media: '#ff9ff3', cam_site: '#ffc312', lovense_overlay: '#9b59b6',
  tip_goal: '#2ed573', tip_menu: '#e056fd', chat_overlay: '#00b894',
  alert_box: '#fdcb6e', audio_input: '#00cec9', audio_output: '#00cec9',
  game_capture: '#ffa502',
};

// Hidden video elements used to draw MediaStream frames onto canvas
const videoCache = {}; // sourceId → <video>

function getOrCreateVideo(sourceId, stream) {
  if (!videoCache[sourceId]) {
    const v = document.createElement('video');
    v.autoplay = true;
    v.muted = true;
    v.playsInline = true;
    videoCache[sourceId] = v;
  }
  const v = videoCache[sourceId];
  if (v.srcObject !== stream) {
    v.srcObject = stream;
    v.play().catch(() => {});
  }
  return v;
}

function releaseVideo(sourceId) {
  const v = videoCache[sourceId];
  if (v) {
    v.srcObject = null;
    delete videoCache[sourceId];
  }
}

export default function PreviewCanvas({ scene, streamStatus, sourceStreams = {} }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rafRef = useRef(null);
  const [canvasSize, setCanvasSize] = useState({ width: 1920, height: 1080 });
  const [selectedSource, setSelectedSource] = useState(null);

  // Fit canvas to container while maintaining 16:9
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => {
      const rect = container.getBoundingClientRect();
      const aspectRatio = 16 / 9;
      let w = rect.width - 16;
      let h = w / aspectRatio;
      if (h > rect.height - 16) { h = rect.height - 16; w = h * aspectRatio; }
      setCanvasSize({ width: Math.floor(w), height: Math.floor(h) });
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Clean up video elements for sources that no longer have streams
  useEffect(() => {
    const activeIds = new Set(Object.keys(sourceStreams));
    Object.keys(videoCache).forEach((id) => {
      if (!activeIds.has(id)) releaseVideo(id);
    });
  }, [sourceStreams]);

  // Draw loop — runs via requestAnimationFrame so live video frames update continuously
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const draw = () => {
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const sources = scene?.sources;
      if (!sources?.length) {
        ctx.fillStyle = '#1a1a26';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#33335a';
        ctx.font = `bold ${24 * (canvas.width / 1280)}px -apple-system, sans-serif`;
        ctx.textAlign = 'center';
        ctx.fillText('⚡ APEX REVENUE', canvas.width / 2, canvas.height / 2 - 20);
        ctx.font = `${14 * (canvas.width / 1280)}px -apple-system, sans-serif`;
        ctx.fillStyle = '#55556a';
        ctx.fillText('Add sources to build your scene', canvas.width / 2, canvas.height / 2 + 15);
        rafRef.current = requestAnimationFrame(draw);
        return;
      }

      const scaleX = canvas.width / 1920;
      const scaleY = canvas.height / 1080;

      sources.forEach((source) => {
        if (!source.visible) return;
        const x = source.transform.x * scaleX;
        const y = source.transform.y * scaleY;
        const w = source.transform.width * scaleX;
        const h = source.transform.height * scaleY;

        ctx.globalAlpha = source.opacity;
        const color = SOURCE_COLORS[source.type] || '#666';
        const stream = sourceStreams[source.id];

        if (source.type === 'color') {
          // ── Solid color ──────────────────────────────
          ctx.fillStyle = source.properties?.color || '#000';
          ctx.fillRect(x, y, w, h);

        } else if (source.type === 'text') {
          // ── Text ─────────────────────────────────────
          ctx.fillStyle = 'rgba(0,0,0,0.3)';
          ctx.fillRect(x, y, w, h);
          ctx.fillStyle = source.properties?.color || '#fff';
          ctx.font = `${(source.properties?.fontSize || 48) * scaleY}px ${source.properties?.fontFamily || 'sans-serif'}`;
          ctx.textAlign = 'left';
          ctx.fillText(source.properties?.text || 'Text', x + 8, y + h / 2 + 6);

        } else if (stream && (source.type === 'webcam' || source.type === 'screen_capture' ||
                               source.type === 'window_capture' || source.type === 'game_capture')) {
          // ── Live video stream ─────────────────────────
          const video = getOrCreateVideo(source.id, stream);
          if (video.readyState >= 2) {
            // Video is ready — draw the frame
            ctx.drawImage(video, x, y, w, h);
          } else {
            // Still loading — draw a "connecting" placeholder
            ctx.fillStyle = color + '33';
            ctx.fillRect(x, y, w, h);
            ctx.strokeStyle = color;
            ctx.lineWidth = 1;
            ctx.strokeRect(x, y, w, h);
            ctx.fillStyle = color;
            ctx.font = `${11 * Math.max(scaleX, scaleY)}px -apple-system, sans-serif`;
            ctx.textAlign = 'center';
            ctx.fillText('⏳ ' + source.name, x + w / 2, y + h / 2);
          }

        } else if (stream && (source.type === 'audio_input' || source.type === 'audio_output')) {
          // ── Audio source — show waveform visualizer ───
          ctx.fillStyle = color + '22';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, w, h);
          // Animated waveform bars
          const bars = 12;
          const barW = (w * 0.6) / bars;
          const gap = barW * 0.3;
          const now = Date.now() / 300;
          ctx.fillStyle = color;
          for (let i = 0; i < bars; i++) {
            const barH = (Math.sin(now + i * 0.8) * 0.4 + 0.5) * h * 0.5;
            const bx = x + w * 0.2 + i * (barW + gap);
            ctx.fillRect(bx, y + h / 2 - barH / 2, barW, barH);
          }
          ctx.fillStyle = color;
          ctx.font = `${9 * Math.max(scaleX, scaleY)}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(source.name, x + w / 2, y + h * 0.85);

        } else {
          // ── Generic / waiting for device ─────────────
          ctx.fillStyle = color + '22';
          ctx.fillRect(x, y, w, h);
          ctx.strokeStyle = color;
          ctx.lineWidth = source.id === selectedSource ? 2 : 1;
          ctx.strokeRect(x, y, w, h);
          ctx.fillStyle = color;
          ctx.font = `${12 * Math.max(scaleX, scaleY)}px -apple-system, sans-serif`;
          ctx.textAlign = 'center';
          ctx.fillText(source.name, x + w / 2, y + h / 2);
        }

        // ── Selection handles ─────────────────────────
        if (source.id === selectedSource) {
          ctx.globalAlpha = 1;
          const hs = 6;
          ctx.fillStyle = '#fff';
          [[x,y],[x+w,y],[x,y+h],[x+w,y+h]].forEach(([hx,hy]) =>
            ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs));
          [[x+w/2,y],[x+w/2,y+h],[x,y+h/2],[x+w,y+h/2]].forEach(([hx,hy]) =>
            ctx.fillRect(hx - hs/2, hy - hs/2, hs, hs));
        }

        ctx.globalAlpha = 1;
      });

      rafRef.current = requestAnimationFrame(draw);
    };

    rafRef.current = requestAnimationFrame(draw);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [scene, canvasSize, selectedSource, sourceStreams]);

  const handleCanvasClick = useCallback((e) => {
    if (!scene?.sources?.length) return;
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * 1920;
    const my = ((e.clientY - rect.top) / rect.height) * 1080;
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
        background: 'var(--bg-primary)', position: 'relative', overflow: 'hidden',
      }}
    >
      <div style={{ position: 'absolute', top: 8, right: 8, display: 'flex', gap: 4, zIndex: 10 }}>
        {streamStatus.streaming && <span className="badge badge-live">LIVE</span>}
        {streamStatus.recording && <span className="badge badge-danger" style={{ background: 'var(--live-red-dim)', color: 'var(--live-red)' }}>● REC</span>}
        {streamStatus.virtualCam && <span className="badge badge-success">VCAM</span>}
      </div>

      {streamStatus.streaming && (
        <div style={{ position: 'absolute', bottom: 8, right: 8, display: 'flex', gap: 8, fontSize: 9, color: 'var(--text-dim)', zIndex: 10 }}>
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
        style={{ width: canvasSize.width, height: canvasSize.height, borderRadius: 4, cursor: 'crosshair' }}
      />
    </div>
  );
}

function formatUptime(seconds) {
  if (!seconds) return '00:00:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
}


