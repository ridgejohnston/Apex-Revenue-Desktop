import React, { useRef, useEffect, useState, useCallback } from 'react';

const api = window.electronAPI;

const SOURCE_COLORS = {
  webcam: '#7c5cfc', screen_capture: '#2ed573', window_capture: '#ffa502',
  image: '#ff6b81', text: '#1e90ff', browser: '#ff4757', color: '#00d2d3',
  media: '#ff9ff3', cam_site: '#ffc312', lovense_overlay: '#9b59b6',
  tip_goal: '#2ed573', tip_menu: '#e056fd', chat_overlay: '#00b894',
  alert_box: '#fdcb6e', audio_input: '#00cec9', audio_output: '#00cec9',
  game_capture: '#ffa502',
};

// Hidden DOM elements used to draw frames onto canvas. Keyed by source id.
// The shape varies by source type:
//   { type: 'stream', el: <video> }                 — MediaStream sources
//   { type: 'image',  el: <img>,  src: url }        — image / image_url
//   { type: 'video',  el: <video>, src: url }       — media / video_url
//   { type: 'slideshow', el: <img>, images: [urls], index, lastAt, interval }
const mediaCache = {};

function getOrCreateStreamVideo(sourceId, stream) {
  let entry = mediaCache[sourceId];
  if (!entry || entry.type !== 'stream') {
    releaseMedia(sourceId);
    const v = document.createElement('video');
    v.autoplay = true; v.muted = true; v.playsInline = true;
    entry = { type: 'stream', el: v };
    mediaCache[sourceId] = entry;
  }
  if (entry.el.srcObject !== stream) {
    entry.el.srcObject = stream;
    entry.el.play().catch(() => {});
  }
  return entry.el;
}

function getOrCreateImage(sourceId, src) {
  let entry = mediaCache[sourceId];
  if (!entry || entry.type !== 'image' || entry.src !== src) {
    releaseMedia(sourceId);
    const img = new Image();
    img.crossOrigin = 'anonymous'; // allow http images to be drawn
    img.src = src;
    entry = { type: 'image', el: img, src, loaded: false };
    img.onload = () => { entry.loaded = true; };
    img.onerror = () => { entry.error = true; };
    mediaCache[sourceId] = entry;
  }
  return entry;
}

function getOrCreateFileVideo(sourceId, src, opts = {}) {
  let entry = mediaCache[sourceId];
  if (!entry || entry.type !== 'video' || entry.src !== src) {
    releaseMedia(sourceId);
    const v = document.createElement('video');
    v.src = src;
    v.autoplay = true;
    v.playsInline = true;
    v.muted = opts.muted ?? true;
    v.loop = opts.loop ?? true;
    v.crossOrigin = 'anonymous';
    v.play().catch(() => {});
    entry = { type: 'video', el: v, src };
    mediaCache[sourceId] = entry;
  }
  return entry.el;
}

function getOrCreateSlideshow(sourceId, images, interval) {
  let entry = mediaCache[sourceId];
  const imagesKey = images.join('|');
  if (!entry || entry.type !== 'slideshow' || entry.imagesKey !== imagesKey) {
    releaseMedia(sourceId);
    const img = new Image();
    img.crossOrigin = 'anonymous';
    entry = {
      type: 'slideshow',
      el: img,
      images,
      imagesKey,
      index: 0,
      lastAt: 0,
      interval: Math.max(1, interval),
      loaded: false,
    };
    img.onload = () => { entry.loaded = true; };
    img.onerror = () => { entry.error = true; };
    img.src = images[0];
    mediaCache[sourceId] = entry;
  } else {
    entry.interval = Math.max(1, interval);
  }
  // Advance slide if interval elapsed
  const now = Date.now();
  if (entry.lastAt === 0) {
    entry.lastAt = now;
  } else if (now - entry.lastAt > entry.interval * 1000) {
    entry.index = (entry.index + 1) % entry.images.length;
    entry.lastAt = now;
    entry.loaded = false;
    entry.el.src = entry.images[entry.index];
  }
  return entry;
}

function releaseMedia(sourceId) {
  const entry = mediaCache[sourceId];
  if (!entry) return;
  if (entry.type === 'stream' && entry.el) {
    entry.el.srcObject = null;
  } else if ((entry.type === 'video') && entry.el) {
    entry.el.pause();
    entry.el.src = '';
    entry.el.load();
  } else if ((entry.type === 'image' || entry.type === 'slideshow') && entry.el) {
    entry.el.src = '';
  }
  delete mediaCache[sourceId];
}

// Convert a native filesystem path to an apex-file:// URL the renderer
// can load via <img> / <video>. Main.js registers the scheme as
// privileged so it bypasses webSecurity restrictions on local files.
//
// Windows paths like "C:\Users\Ridge\pic.png" need two transforms:
//   • backslashes → forward slashes (URL path separator)
//   • drive letter prefix gets a leading slash: /C:/Users/Ridge/pic.png
// Non-Windows paths pass through largely unchanged.
// encodeURI (NOT encodeURIComponent) preserves path separators while
// percent-encoding spaces and special chars.
function toApexFileUrl(nativePath) {
  if (!nativePath) return '';
  // Pass through URLs untouched — defensive, in case callers pass a
  // URL that happens to start with a letter.
  if (/^[a-z]+:\/\//i.test(nativePath)) return nativePath;
  let p = String(nativePath).replace(/\\/g, '/');
  if (/^[A-Za-z]:/.test(p)) p = '/' + p; // /C:/path
  return 'apex-file://' + encodeURI(p).replace(/#/g, '%23').replace(/\?/g, '%3F');
}

// Shared placeholder renderer for sources that can't show their content
// yet — not-set, loading, error states across image / video-file /
// slideshow branches. Centralizing keeps the visual language consistent.
function drawPlaceholder(ctx, x, y, w, h, color, name, status, scaleX, scaleY, selected) {
  ctx.fillStyle = color + '22';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = color;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.strokeRect(x, y, w, h);
  ctx.fillStyle = color;
  const bigFont = 12 * Math.max(scaleX, scaleY);
  const smallFont = 9 * Math.max(scaleX, scaleY);
  ctx.font = `${bigFont}px -apple-system, sans-serif`;
  ctx.textAlign = 'center';
  ctx.fillText(name, x + w / 2, y + h / 2 - bigFont * 0.2);
  ctx.font = `${smallFont}px -apple-system, sans-serif`;
  ctx.fillStyle = 'var(--text-dim)';
  ctx.fillText(status, x + w / 2, y + h / 2 + bigFont * 0.8);
}

export default function PreviewCanvas({ scene, streamStatus, sourceStreams = {} }) {
  const canvasRef = useRef(null);
  const containerRef = useRef(null);
  const rafRef = useRef(null);
  // Per-source cache of slideshow folder contents. Keyed by source.id
  // with value { folder, loading, images[], error? }. Kept in a ref
  // (not state) so updating it doesn't retrigger the draw-loop useEffect,
  // which would tear down and recreate the requestAnimationFrame chain.
  const slideshowFolderListRef = useRef({});
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

  // Clean up cached media elements for sources that no longer exist or
  // whose backing content has changed. Runs whenever scene sources or
  // the MediaStream map change. Iterating mediaCache directly (rather
  // than tracking per-source IDs in React state) keeps this cheap — the
  // cache typically has 1-3 entries for active sources.
  useEffect(() => {
    const activeSourceIds = new Set();
    const sourcesList = scene?.sources || [];
    for (const s of sourcesList) {
      if (s.visible) activeSourceIds.add(s.id);
    }
    Object.keys(mediaCache).forEach((id) => {
      const entry = mediaCache[id];
      // Stream-type entries: release when the underlying MediaStream
      // is gone (source was removed or deactivated by the
      // webcam-release handshake during a live stream).
      if (entry.type === 'stream' && !sourceStreams[id]) {
        releaseMedia(id);
        return;
      }
      // All other types: release when the source itself disappears
      // from the active scene or is no longer visible.
      if (entry.type !== 'stream' && !activeSourceIds.has(id)) {
        releaseMedia(id);
      }
    });
  }, [sourceStreams, scene]);

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
          const video = getOrCreateStreamVideo(source.id, stream);
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

        } else if (source.type === 'image' || source.type === 'image_url') {
          // ── Static image (local file via apex-file:// or remote URL) ──
          // Local paths come in as properties.path and get wrapped in the
          // apex-file:// protocol the main process registers. Remote URLs
          // are used directly — the <img> element handles http(s) natively.
          const rawSrc = source.type === 'image'
            ? (source.properties?.path || '')
            : (source.properties?.url || '');
          const resolvedSrc = source.type === 'image' && rawSrc
            ? toApexFileUrl(rawSrc)
            : rawSrc;

          if (!resolvedSrc) {
            drawPlaceholder(ctx, x, y, w, h, color, source.name, '⚠ Path not set', scaleX, scaleY, source.id === selectedSource);
          } else {
            const entry = getOrCreateImage(source.id, resolvedSrc);
            if (entry.error) {
              drawPlaceholder(ctx, x, y, w, h, color, source.name, '⚠ Failed to load', scaleX, scaleY, source.id === selectedSource);
            } else if (entry.loaded && entry.el.naturalWidth > 0) {
              ctx.drawImage(entry.el, x, y, w, h);
            } else {
              drawPlaceholder(ctx, x, y, w, h, color, source.name, '⏳ Loading', scaleX, scaleY, source.id === selectedSource);
            }
          }

        } else if (source.type === 'media' || source.type === 'video_url') {
          // ── Video file (local via apex-file:// or remote URL) ──
          const rawSrc = source.type === 'media'
            ? (source.properties?.path || '')
            : (source.properties?.url || '');
          const resolvedSrc = source.type === 'media' && rawSrc
            ? toApexFileUrl(rawSrc)
            : rawSrc;

          if (!resolvedSrc) {
            drawPlaceholder(ctx, x, y, w, h, color, source.name, '⚠ Path not set', scaleX, scaleY, source.id === selectedSource);
          } else {
            const video = getOrCreateFileVideo(source.id, resolvedSrc, {
              loop: source.properties?.loop !== false, // default true
              muted: source.properties?.muted !== false, // default true in preview
            });
            if (video.readyState >= 2 && video.videoWidth > 0) {
              ctx.drawImage(video, x, y, w, h);
            } else {
              drawPlaceholder(ctx, x, y, w, h, color, source.name, '⏳ Buffering', scaleX, scaleY, source.id === selectedSource);
            }
          }

        } else if (source.type === 'image_slideshow') {
          // ── Folder slideshow ──
          // The main process exposes api.slideshow.listImages(folderPath)
          // (preload: window.api) to enumerate valid files. We cache the
          // result per-source on first draw; if the folder path changes
          // the cache is invalidated by the imagesKey check.
          const folder = source.properties?.folderPath || '';
          const interval = parseInt(source.properties?.interval, 10) || 5;
          const listed = slideshowFolderListRef.current[source.id];

          if (!folder) {
            drawPlaceholder(ctx, x, y, w, h, color, source.name, '⚠ Folder not set', scaleX, scaleY, source.id === selectedSource);
          } else if (!listed || listed.folder !== folder) {
            // Kick off async folder listing (fire once per unique folder)
            // and draw a loading placeholder this frame.
            if (!listed || listed.folder !== folder) {
              slideshowFolderListRef.current[source.id] = { folder, loading: true, images: [] };
              api.slideshow?.listImages?.(folder)
                .then((images) => {
                  slideshowFolderListRef.current[source.id] = {
                    folder, loading: false, images: images || [],
                  };
                })
                .catch(() => {
                  slideshowFolderListRef.current[source.id] = {
                    folder, loading: false, images: [], error: true,
                  };
                });
            }
            drawPlaceholder(ctx, x, y, w, h, color, source.name, '⏳ Scanning folder', scaleX, scaleY, source.id === selectedSource);
          } else if (listed.error || listed.images.length === 0) {
            const msg = listed.error ? '⚠ Folder read failed' : '⚠ No images in folder';
            drawPlaceholder(ctx, x, y, w, h, color, source.name, msg, scaleX, scaleY, source.id === selectedSource);
          } else {
            const imageUrls = listed.images.map(toApexFileUrl);
            const entry = getOrCreateSlideshow(source.id, imageUrls, interval);
            if (entry.loaded && entry.el.naturalWidth > 0) {
              ctx.drawImage(entry.el, x, y, w, h);
              // Small corner badge showing which slide is current
              ctx.globalAlpha = 0.75;
              ctx.fillStyle = 'rgba(0,0,0,0.55)';
              const badgeW = 58 * scaleX;
              const badgeH = 18 * scaleY;
              ctx.fillRect(x + w - badgeW - 6, y + 6, badgeW, badgeH);
              ctx.fillStyle = '#fff';
              ctx.font = `${10 * Math.max(scaleX, scaleY)}px -apple-system, sans-serif`;
              ctx.textAlign = 'center';
              ctx.fillText(`${entry.index + 1} / ${entry.images.length}`, x + w - badgeW / 2 - 6, y + 6 + badgeH * 0.7);
              ctx.globalAlpha = source.opacity;
            } else {
              drawPlaceholder(ctx, x, y, w, h, color, source.name, '⏳ Loading slide', scaleX, scaleY, source.id === selectedSource);
            }
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


