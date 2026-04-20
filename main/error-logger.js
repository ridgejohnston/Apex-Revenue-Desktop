// Central error logger for Apex Revenue Desktop.
//
// Responsibilities:
//   • Write structured error lines to a persistent file
//   • Keep an in-memory ring buffer of recent entries for instant
//     "copy last errors" workflows without reading from disk
//   • Rotate files when they exceed MAX_LOG_SIZE, preserving the
//     last MAX_LOG_FILES generations
//   • Redact sensitive tokens (stream keys, AWS credentials, bearer
//     tokens) on the way in so pasted logs don't leak secrets
//   • Expose a tiny API (log/recent/readAll/getLogPath) used by
//     main.js IPC handlers
//
// Singleton: require('./error-logger') returns the same instance
// everywhere. Call .init() once in app.whenReady so we have access
// to app.getPath('userData').

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const MAX_LOG_SIZE = 2 * 1024 * 1024;  // 2MB per file
const MAX_LOG_FILES = 5;                // keep last 5 generations
const MAX_IN_MEMORY = 300;              // ring buffer size

class ErrorLogger {
  constructor() {
    this._ready = false;
    this._logDir = null;
    this._currentFile = null;
    this._inMemory = [];
  }

  // Resolve userData path and ensure the log directory exists.
  // Safe to call multiple times — subsequent calls no-op.
  init() {
    if (this._ready) return;
    try {
      const userData = app.getPath('userData');
      this._logDir = path.join(userData, 'logs');
      fs.mkdirSync(this._logDir, { recursive: true });
      this._currentFile = path.join(this._logDir, 'errors.log');
      this._ready = true;
      const version = (app.getVersion && app.getVersion()) || 'unknown';
      this.log('info', 'logger', `Error logger initialized — app v${version}`);
    } catch (err) {
      // Can't use this.log here — logger isn't ready.
      console.error('[ErrorLogger] init failed:', err.message);
    }
  }

  // level:   'debug' | 'info' | 'warn' | 'error' | 'fatal'
  // source:  a short tag identifying where this originated
  //          (e.g. 'main.uncaught', 'renderer.console', 'stream-engine')
  // message: primary human-readable string
  // context: optional object with extra key-value data (stack, file,
  //          line, etc). Serialized with JSON.stringify, redacted.
  log(level, source, message, context) {
    const ts = new Date().toISOString();
    const lvl = String(level || 'info').toUpperCase();
    const src = String(source || 'unknown');
    const msg = this._redact(String(message == null ? '' : message));
    let ctxStr = '';
    if (context != null) {
      try {
        ctxStr = ' ' + this._redact(JSON.stringify(context));
      } catch {
        ctxStr = ' [unserializable context]';
      }
    }
    const line = `[${ts}] [${lvl}] [${src}] ${msg}${ctxStr}`;

    // Ring buffer — O(1) push, O(1) shift at capacity.
    this._inMemory.push(line);
    if (this._inMemory.length > MAX_IN_MEMORY) {
      this._inMemory.shift();
    }

    if (!this._ready || !this._currentFile) return;

    try {
      // Rotate BEFORE appending if we're over the size threshold.
      // Checking on every write is fine — stat is cheap and the
      // alternative (write-then-check) has to move a file mid-
      // write which is trickier to reason about.
      if (fs.existsSync(this._currentFile)) {
        const stat = fs.statSync(this._currentFile);
        if (stat.size > MAX_LOG_SIZE) {
          this._rotate();
        }
      }
      fs.appendFileSync(this._currentFile, line + '\n', 'utf8');
    } catch (err) {
      // Don't recurse: if disk is broken, just write to console and
      // accept that this log entry is lost.
      console.error('[ErrorLogger] write failed:', err.message);
    }
  }

  // Shift errors.log -> errors.log.1, .1 -> .2, ..., drop the oldest.
  // Not atomic. If power drops mid-rotate we might end up with
  // missing files; not a correctness concern for an error log.
  _rotate() {
    try {
      // Work back-to-front so earlier renames don't clobber later files
      for (let i = MAX_LOG_FILES - 1; i >= 1; i--) {
        const src = path.join(this._logDir, `errors.log.${i}`);
        const dst = path.join(this._logDir, `errors.log.${i + 1}`);
        if (fs.existsSync(src)) {
          if (i + 1 > MAX_LOG_FILES) {
            fs.unlinkSync(src);
          } else {
            fs.renameSync(src, dst);
          }
        }
      }
      fs.renameSync(this._currentFile, path.join(this._logDir, 'errors.log.1'));
    } catch (err) {
      console.error('[ErrorLogger] rotate failed:', err.message);
    }
  }

  // Redact patterns that should never appear in a pasted log.
  //
  // The goal is to keep enough context that debugging remains
  // possible (paths, filenames, error messages, line numbers) while
  // removing things that could compromise accounts if shared.
  //
  // Conservative approach: only redact patterns we're very confident
  // are secrets. False negatives (leaking a secret) are a security
  // issue; false positives (redacting legitimate text) are a
  // debugging hindrance. We err toward the debugging side and rely
  // on well-known token formats.
  _redact(s) {
    if (!s) return s;
    return s
      // AWS Access Key IDs — always 20 chars, always start AKIA
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA<REDACTED>')
      // Stream keys in RTMP URLs (the trailing /<key> segment)
      .replace(/(rtmps?:\/\/[^\s"'<>]+?\/)([A-Za-z0-9_-]{16,})/g, '$1<REDACTED_KEY>')
      // Generic stream_key / streamKey / streamkey assignments
      .replace(/(stream[_-]?key\s*[:=]\s*['"]?)([^'"\s]{8,})/gi, '$1<REDACTED>')
      // Bearer tokens
      .replace(/(Bearer\s+)([A-Za-z0-9._~+/-]{16,})/g, '$1<REDACTED>')
      // Authorization header values in serialized headers
      .replace(/("?[Aa]uthorization"?\s*[:=]\s*['"]?)([^'",\s}]{16,})/g, '$1<REDACTED>')
      // password / apiKey / apiSecret / accessToken / refreshToken
      .replace(/((?:password|api[_-]?key|api[_-]?secret|access[_-]?token|refresh[_-]?token|secret[_-]?key|client[_-]?secret)\s*[:=]\s*['"]?)([^'",\s}]+)/gi, '$1<REDACTED>')
      // AWS Signature V4 signatures in headers
      .replace(/(Signature=)([a-f0-9]{40,})/g, '$1<REDACTED>')
      // Cognito JWT-ish tokens: three dot-separated base64 segments
      .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<REDACTED_JWT>');
  }

  // Return the last n entries from the in-memory ring buffer as a
  // newline-joined string. Fast path for the "copy recent errors"
  // button — avoids reading from disk.
  recent(n = 200) {
    const count = Math.max(1, Math.min(MAX_IN_MEMORY, n | 0));
    return this._inMemory.slice(-count).join('\n');
  }

  // Scan the in-memory ring buffer for recent entries matching both a
  // source tag AND a message/context regex, within the last `withinMs`
  // milliseconds. Returns an array of { ts, level, source, message,
  // context } objects, newest LAST. Used by stream-engine's hint
  // classifier to correlate FFmpeg stderr errors with renderer-side
  // telemetry (beauty-filter fps, MediaRecorder output bitrate) that
  // was written to the same ring buffer moments before.
  //
  // Why in-memory and not file: the ring buffer is always current
  // within the same app session, whereas readAll() includes entries
  // from previous sessions after rotation. We want signals from NOW.
  findRecent(source, regex, withinMs = 15000) {
    if (!this._inMemory.length) return [];
    const now = Date.now();
    const cutoff = now - withinMs;
    const matches = [];
    // Each line: [ISO_TS] [LEVEL] [source] message {optional JSON}
    const lineRe = /^\[([^\]]+)\]\s+\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/;
    for (const line of this._inMemory) {
      const m = line.match(lineRe);
      if (!m) continue;
      const ts = Date.parse(m[1]);
      if (!Number.isFinite(ts) || ts < cutoff) continue;
      if (m[3] !== source) continue;
      const rest = m[4];
      if (regex && !regex.test(rest)) continue;
      // Split message vs JSON context. The logger format puts JSON
      // (starting with '{') at the tail of the line after a space.
      // Use the last '{...}' substring as the context candidate.
      let message = rest;
      let context = null;
      const jsonStart = rest.indexOf('{');
      if (jsonStart > 0) {
        const candidate = rest.slice(jsonStart);
        try {
          context = JSON.parse(candidate);
          message = rest.slice(0, jsonStart).trim();
        } catch {
          // Not parseable JSON — leave message as the full rest
        }
      }
      matches.push({
        ts,
        level: m[2],
        source: m[3],
        message,
        context,
      });
    }
    return matches;
  }

  // Read the current log file from disk, plus any in-memory entries
  // not yet flushed. Used by the "view full log" path.
  readAll() {
    if (!this._ready || !this._currentFile) return this.recent();
    try {
      if (!fs.existsSync(this._currentFile)) return this.recent();
      return fs.readFileSync(this._currentFile, 'utf8');
    } catch (err) {
      return `[ErrorLogger] read failed: ${err.message}\n\n` + this.recent();
    }
  }

  // Clear in-memory buffer and truncate the current log file.
  // Rotations are preserved (old generations still on disk).
  clear() {
    this._inMemory = [];
    if (this._ready && this._currentFile) {
      try {
        fs.writeFileSync(this._currentFile, '', 'utf8');
      } catch (err) {
        console.error('[ErrorLogger] clear failed:', err.message);
      }
    }
    this.log('info', 'logger', 'Log cleared by user');
  }

  getLogPath() {
    return this._currentFile;
  }

  getLogDir() {
    return this._logDir;
  }
}

module.exports = new ErrorLogger();
