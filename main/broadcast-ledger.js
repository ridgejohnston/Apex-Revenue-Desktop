/**
 * Apex Revenue — Broadcast Session Ledger
 *
 * Records every RTMP broadcast session (start/end timestamps, duration,
 * platform, exit reason) to a persistent electron-store ledger. Used for:
 *
 *   1. UI display — how many hours has the model used today out of the
 *      4-hour Platinum include.
 *   2. Overage calculation — once daily use passes 4 h, any additional
 *      broadcast minutes are tagged 'overage=true' so the billing
 *      backend can settle them at-cost.
 *   3. Cloud sync (future) — the backend needs authoritative usage data
 *      to enforce the quota at the IAM layer. Local ledger is the
 *      client-side shadow copy, designed to converge with the server.
 *
 * No enforcement happens here. No stream gets cut off. Broadcasting
 * beyond the 4-hour daily include is explicit policy (see
 * BROADCAST_QUOTA.HARD_CAP_ENABLED = false in shared/apex-config.js).
 * This module just accounts. Settlement is a separate server concern.
 *
 * STORAGE SHAPE
 *
 * electron-store key: "broadcastLedger" → {
 *   sessions: [
 *     {
 *       id:          "bc_2026-04-19T18-15-43-a7k2",
 *       startedAt:   1713550543123,   // epoch ms, UTC
 *       endedAt:     1713568943456,   // epoch ms, UTC — null if still running
 *       durationMs:  18400333,        // filled on end
 *       platform:    "chaturbate",    // whichever RTMP target was used
 *       exitReason:  "user_stop",     // "user_stop" | "error" | "crash"
 *     },
 *     ...
 *   ],
 *   // Daily aggregates. Key is YYYY-MM-DD in the model's local
 *   // timezone (per BROADCAST_QUOTA.RESET_TIMEZONE_MODE).
 *   dailyTotals: {
 *     "2026-04-19": { totalMs: 28800000, sessions: 4, overageMs: 0 },
 *     "2026-04-20": { totalMs: 21600000, sessions: 2, overageMs: 7200000 }
 *   }
 * }
 *
 * Sessions older than 90 days are pruned during normal writes. Daily
 * totals older than 400 days likewise. This keeps the ledger small
 * even for a model broadcasting every day for years.
 */

const INCLUDED_HOURS_PER_DAY_DEFAULT = 4;
const INCLUDED_MS_PER_DAY_DEFAULT    = INCLUDED_HOURS_PER_DAY_DEFAULT * 60 * 60 * 1000;
const SESSION_RETENTION_DAYS         = 90;
const DAILY_TOTAL_RETENTION_DAYS     = 400;

let store = null;

/**
 * Initialize the ledger with an electron-store instance. Called once
 * from main.js at startup (after the store is constructed) so the
 * ledger module can read/write without holding its own store ref.
 */
function init(electronStore) {
  store = electronStore;
}

function _loadLedger() {
  if (!store) return { sessions: [], dailyTotals: {} };
  const raw = store.get('broadcastLedger');
  if (!raw || typeof raw !== 'object') {
    return { sessions: [], dailyTotals: {} };
  }
  return {
    sessions:     Array.isArray(raw.sessions) ? raw.sessions : [],
    dailyTotals:  raw.dailyTotals && typeof raw.dailyTotals === 'object' ? raw.dailyTotals : {},
  };
}

function _saveLedger(ledger) {
  if (!store) return;
  store.set('broadcastLedger', ledger);
}

/**
 * Format an epoch-ms timestamp to a YYYY-MM-DD date string in the local
 * timezone. Daily aggregates key off this string. The model's local
 * tz is used (not UTC) so "hours broadcast today" matches their
 * subjective day.
 */
function _localDateKey(epochMs) {
  const d = new Date(epochMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Generate an opaque session id. Not cryptographic; just needs to be
 * unique per session for the model's lifetime and human-readable in
 * logs when debugging a weird session.
 */
function _newSessionId(startEpoch) {
  const iso = new Date(startEpoch).toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const suffix = Math.random().toString(36).slice(2, 6);
  return `bc_${iso}_${suffix}`;
}

/**
 * Prune stale records. Called opportunistically during writes, not on
 * a timer, so there's no background interval to shut down on app exit.
 */
function _prune(ledger, nowMs) {
  const sessionCutoff = nowMs - SESSION_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  ledger.sessions = ledger.sessions.filter(
    (s) => (s.endedAt || s.startedAt) >= sessionCutoff
  );

  const totalCutoff = nowMs - DAILY_TOTAL_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const cutoffKey = _localDateKey(totalCutoff);
  for (const key of Object.keys(ledger.dailyTotals)) {
    if (key < cutoffKey) delete ledger.dailyTotals[key];
  }
}

/**
 * Record the start of a broadcast session. Returns the generated session
 * id, which the caller should hold onto and pass to recordStop() when
 * the broadcast ends. If the session crashes and no recordStop is ever
 * called, the entry remains in the ledger with endedAt=null; a startup
 * cleanup (not yet implemented) can sweep orphans.
 */
function recordStart(platform) {
  const startedAt = Date.now();
  const id = _newSessionId(startedAt);
  const ledger = _loadLedger();
  ledger.sessions.push({
    id,
    startedAt,
    endedAt:    null,
    durationMs: 0,
    platform:   platform || 'unknown',
    exitReason: null,
  });
  _prune(ledger, startedAt);
  _saveLedger(ledger);
  return id;
}

/**
 * Record the end of a broadcast session. Looks up the open session by
 * id, fills in endedAt/duration, and accumulates the duration into the
 * daily aggregate. If the session crosses a date boundary the duration
 * is split between the two days. If the session exceeds the daily
 * included quota on either day, the overflow is tracked as overageMs.
 */
function recordStop(sessionId, exitReason = 'user_stop', { includedMsPerDay = INCLUDED_MS_PER_DAY_DEFAULT } = {}) {
  if (!sessionId) return null;
  const endedAt = Date.now();
  const ledger = _loadLedger();

  const session = ledger.sessions.find((s) => s.id === sessionId);
  if (!session) return null;           // not found, nothing to update
  if (session.endedAt) return session; // already finalized, idempotent

  session.endedAt    = endedAt;
  session.durationMs = Math.max(0, endedAt - session.startedAt);
  session.exitReason = exitReason;

  // Split the session's duration across any date boundaries it crossed.
  // In practice most sessions fit inside one day, but a model streaming
  // across local midnight would otherwise misattribute hours.
  const splits = _splitAcrossLocalDays(session.startedAt, endedAt);
  for (const { dateKey, ms } of splits) {
    const prev = ledger.dailyTotals[dateKey] || { totalMs: 0, sessions: 0, overageMs: 0 };
    const newTotal = prev.totalMs + ms;
    // Overage accounting: anything above includedMsPerDay on that day
    // counts as overage. Idempotent on re-computation from totalMs.
    const overageMs = Math.max(0, newTotal - includedMsPerDay);
    ledger.dailyTotals[dateKey] = {
      totalMs:   newTotal,
      // Session count increments once per session per day it touched.
      sessions:  prev.sessions + 1,
      overageMs,
    };
  }

  _prune(ledger, endedAt);
  _saveLedger(ledger);
  return session;
}

/**
 * Split a [start, end] epoch-ms interval into per-local-day chunks.
 * Returns [{ dateKey: "YYYY-MM-DD", ms }, ...]. Order preserved.
 */
function _splitAcrossLocalDays(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  while (cursor < endMs) {
    const cursorKey = _localDateKey(cursor);
    // Find the start of the NEXT local day at/after cursor.
    const d = new Date(cursor);
    d.setHours(24, 0, 0, 0); // rolls forward to next midnight local
    const nextMidnight = d.getTime();
    const chunkEnd = Math.min(nextMidnight, endMs);
    out.push({ dateKey: cursorKey, ms: chunkEnd - cursor });
    cursor = chunkEnd;
  }
  return out;
}

/**
 * Get today's aggregate (local timezone) plus overage status. Useful
 * for UI display ("3.2 / 4 hours used today") and for enforcement
 * decisions later when IAM-level caps land.
 */
function getTodayUsage({ includedMsPerDay = INCLUDED_MS_PER_DAY_DEFAULT } = {}) {
  const ledger = _loadLedger();
  const todayKey = _localDateKey(Date.now());
  const record = ledger.dailyTotals[todayKey] || { totalMs: 0, sessions: 0, overageMs: 0 };

  // If there's a session open right now (endedAt=null), project its
  // current accumulated time into today's totals. That way the UI
  // shows live-updating usage rather than a frozen "last completed
  // session" number.
  const nowMs = Date.now();
  let liveMs = 0;
  for (const s of ledger.sessions) {
    if (s.endedAt === null) {
      // Only count the portion of the live session that falls inside today
      const splits = _splitAcrossLocalDays(s.startedAt, nowMs);
      for (const { dateKey, ms } of splits) {
        if (dateKey === todayKey) liveMs += ms;
      }
    }
  }

  const totalMs = record.totalMs + liveMs;
  const overageMs = Math.max(0, totalMs - includedMsPerDay);
  const includedUsedMs = Math.min(totalMs, includedMsPerDay);

  return {
    dateKey:        todayKey,
    totalMs,
    includedUsedMs,
    overageMs,
    includedMsPerDay,
    sessions:       record.sessions + (liveMs > 0 ? 1 : 0),
    overageActive:  overageMs > 0,
    pctOfInclude:   Math.min(1, totalMs / includedMsPerDay),
  };
}

/**
 * Return the full ledger (for debugging / future cloud sync). Consumers
 * should not mutate the returned object — read-only.
 */
function getLedger() {
  return _loadLedger();
}

module.exports = {
  init,
  recordStart,
  recordStop,
  getTodayUsage,
  getLedger,
  // Exposed for unit testing / internal use:
  _splitAcrossLocalDays,
  _localDateKey,
};
