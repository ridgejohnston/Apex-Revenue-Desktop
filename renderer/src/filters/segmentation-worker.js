/**
 * Apex Revenue — Segmentation Worker
 *
 * Runs MediaPipe Selfie Segmentation on a dedicated thread. Isolated
 * from the render thread so:
 *   • MediaPipe's WASM inference can't block rAF / React / WebGL compositing
 *   • The segmenter's internal timing has its own event loop
 *   • GC pressure from mask Float32Arrays doesn't hitch the main thread
 *
 * Wire protocol:
 *
 *   main → worker:
 *     { type: 'init',  wasmBase, modelPath }
 *     { type: 'frame', imageBitmap, timestamp }       (imageBitmap transferred)
 *     { type: 'close' }
 *
 *   worker → main:
 *     { type: 'ready' }
 *     { type: 'mask',  buffer, width, height, timestamp }  (buffer transferred)
 *     { type: 'mask-missed', timestamp }                   (inference ran, no mask)
 *     { type: 'error', stage, message }
 *
 * Backpressure: the worker processes frames serially. The main-thread
 * SelfieSegmenter never sends a new frame until the previous 'mask' or
 * 'mask-missed' acknowledgement has arrived — so the worker's inbox
 * is always ≤ 1 pending frame. If inference is slow (integrated GPU,
 * CPU delegate fallback) the effective segmentation rate caps itself
 * without further main-thread coordination.
 *
 * Cleanup: every ImageBitmap is closed after segmentation (whether or
 * not a mask came back) so we don't leak GPU-backed surfaces. Every
 * MPMask is also closed after its Float32Array is copied out.
 */

import { ImageSegmenter, FilesetResolver } from '@mediapipe/tasks-vision';

let segmenter = null;
let ready = false;

self.onmessage = async (e) => {
  const msg = e.data;

  if (msg.type === 'init') {
    try {
      const fileset = await FilesetResolver.forVisionTasks(msg.wasmBase);
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: msg.modelPath,
          delegate: 'GPU',
        },
        runningMode: 'VIDEO',
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
      ready = true;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({
        type: 'error',
        stage: 'init',
        message: err?.message || String(err),
      });
    }
    return;
  }

  if (msg.type === 'frame') {
    const bitmap = msg.imageBitmap;
    if (!ready || !segmenter) {
      try { bitmap?.close?.(); } catch {}
      self.postMessage({ type: 'mask-missed', timestamp: msg.timestamp });
      return;
    }
    let resultRef = null;
    try {
      const result = segmenter.segmentForVideo(bitmap, msg.timestamp);
      resultRef = result;
      const mask = result?.confidenceMasks?.[0];
      if (mask) {
        const w = mask.width;
        const h = mask.height;
        // getAsFloat32Array copies the mask bytes out of MediaPipe's
        // internal arena. The resulting ArrayBuffer is transferable,
        // so we send its ownership back to the main thread zero-copy.
        const floats = mask.getAsFloat32Array();
        const buffer = floats.buffer;
        try { mask.close(); } catch {}
        self.postMessage(
          {
            type: 'mask',
            buffer,
            width: w,
            height: h,
            timestamp: msg.timestamp,
          },
          [buffer]
        );
      } else {
        self.postMessage({ type: 'mask-missed', timestamp: msg.timestamp });
      }
    } catch (err) {
      self.postMessage({
        type: 'error',
        stage: 'frame',
        message: err?.message || String(err),
      });
    } finally {
      try { resultRef?.close?.(); } catch {}
      try { bitmap?.close?.(); } catch {}
    }
    return;
  }

  if (msg.type === 'close') {
    try { segmenter?.close(); } catch {}
    segmenter = null;
    ready = false;
    self.close();
    return;
  }
};
