import React from 'react';
import { createRoot } from 'react-dom/client';
import App, { ErrorBoundary } from './App';
import './styles/global.css';

// ─── Global error capture ────────────────────────────────
// Wire browser-level error events and console.error to the central
// error log in the main process. Runs before React mounts so even
// setup-phase errors get captured. All IPC calls are wrapped in
// try/catch so a broken preload never cascades into more errors.
(function setupGlobalErrorLogging() {
  const api = window.electronAPI;
  if (!api || !api.errors || !api.errors.log) return;

  // Uncaught synchronous errors in any script on the page. This is
  // the catch-all for render-phase errors outside React's tree
  // (script tags, event handlers, inline code, setTimeout callbacks).
  window.addEventListener('error', (ev) => {
    try {
      api.errors.log('error', 'renderer.global', ev.message || 'Unknown error', {
        file: ev.filename,
        line: ev.lineno,
        col: ev.colno,
        stack: ev.error && ev.error.stack,
      });
    } catch {}
  });

  // Rejected promises without a .catch handler. Common in async/await
  // code where the rejection slips past all the try/catches.
  window.addEventListener('unhandledrejection', (ev) => {
    try {
      const reason = ev.reason;
      const isErr = reason instanceof Error;
      api.errors.log('error', 'renderer.rejection',
        isErr ? reason.message : String(reason),
        { stack: isErr ? reason.stack : undefined }
      );
    } catch {}
  });

  // Monkey-patch console.error so React's own error logging and any
  // third-party library's console.error flow into the log too. We
  // keep the original behavior (still shows in devtools) and only
  // add the IPC side-effect.
  //
  // Guarded against infinite recursion: if the IPC call itself
  // throws and logs via console.error, we'd loop. The guard flag
  // skips re-entry while we're in the middle of a log call.
  const origConsoleError = console.error.bind(console);
  let inHook = false;
  console.error = (...args) => {
    origConsoleError(...args);
    if (inHook) return;
    inHook = true;
    try {
      const msg = args.map((a) => {
        if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
        if (typeof a === 'object' && a !== null) {
          try { return JSON.stringify(a); } catch { return String(a); }
        }
        return String(a);
      }).join(' ');
      api.errors.log('error', 'renderer.console', msg);
    } catch {}
    inHook = false;
  };
})();

const root = createRoot(document.getElementById('root'));
root.render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
