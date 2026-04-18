/**
 * Apex Revenue — BrowserView Guard
 *
 * Runtime invariant: Apex never writes to a platform's chat input unless the
 * performer explicitly typed and clicked send from an Apex UI surface. This
 * module wraps all webContents.executeJavaScript call paths that could touch
 * chat selectors.
 *
 * Rule set:
 *   - Any executeJavaScript body containing a CHAT_SELECTOR pattern requires
 *     { userInitiated: true } in the options bag.
 *   - Requests without the flag are rejected and emit a 'silent.violation'
 *     event to CloudWatch via the main Firehose.
 *   - CI enforcement: scripts/check-silent.js greps the codebase for the same
 *     patterns paired with hard-coded Apex-branded strings and fails the build.
 *
 * This is deliberately paranoid. The Silent-in-Chat policy is the single
 * cheapest and most durable differentiator against competitors like the ones
 * performers complain about in forum posts ("your name appeared 13 times in
 * 20 minutes"). Regressions here compound in performer trust debt.
 */

const CHAT_SELECTOR_PATTERNS = [
  // Generic selectors
  /\[class\*=["']chat[-_]?input/i,
  /textarea[^)]*chat/i,
  /#chat[-_]?box/i,
  /#chat[-_]?input/i,
  /\.chat[-_]?input/i,
  /\.chat[-_]?box/i,

  // Platform-specific (expand as needed)
  /data-testid=["']chat-input/i,
  /data-testid=["']send-message/i,
  /\[data-paction[-_]?name=["']chat/i,

  // Command-prefix strings that platforms use to send chat messages
  // when a performer types them. If these ever appear in executeJavaScript
  // payloads that weren't user-initiated, something is wrong.
  /['"]\s*\/msg\b/,
  /['"]\s*\/tip\b/,
  /['"]\s*\/pm\b/,
];

function looksLikeChatWrite(jsBody) {
  if (typeof jsBody !== 'string') return false;
  return CHAT_SELECTOR_PATTERNS.some((re) => re.test(jsBody));
}

/**
 * guardedExecuteJavaScript(webContents, jsBody, options)
 *
 * @param {WebContents} webContents — Electron webContents handle
 * @param {string}      jsBody      — the JS to inject
 * @param {Object}      options     — { userInitiated?, userUnderstandsWrite? }
 *
 * Returns a Promise (same as webContents.executeJavaScript) or rejects with
 * a 'silent.violation' error when the write is blocked.
 */
function guardedExecuteJavaScript(webContents, jsBody, options) {
  options = options || {};
  if (looksLikeChatWrite(jsBody) && !options.userInitiated) {
    const err = new Error('silent.violation: chat write attempted without userInitiated flag');
    err.code = 'SILENT_VIOLATION';
    logViolation(jsBody);
    return Promise.reject(err);
  }
  return webContents.executeJavaScript(jsBody);
}

// Instrumentation hook — wired to Firehose in main/aws-services.js on startup.
// Until then, violations log to console only.
let violationSink = (evt) => {
  console.error('[SILENT] Violation:', evt);
};

function setViolationSink(fn) {
  if (typeof fn === 'function') violationSink = fn;
}

function logViolation(jsBody) {
  violationSink({
    at: Date.now(),
    sample: jsBody.slice(0, 240),
    stack: (new Error().stack || '').split('\n').slice(1, 5).join(' | '),
  });
}

module.exports = {
  guardedExecuteJavaScript,
  looksLikeChatWrite,
  setViolationSink,
  CHAT_SELECTOR_PATTERNS,
};
