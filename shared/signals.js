/**
 * Apex Revenue — Signal Detection
 *
 * Pure module ported from Apex-Revenue-Edge overlay.js (lines 867–941).
 * Consumes a LiveData snapshot, produces a normalized Signals object.
 * No DOM, no IPC, no side effects — safe to call from main or renderer.
 *
 * Also usable by the legacy Chrome extension during the sunset window
 * so both clients produce identical signals.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const MILESTONES = [100, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000, 7500, 10000];

const PHASE_WEIGHTS = {
  warming:  { whale: 1.5,  audience: 0.65 },
  building: { whale: 1.0,  audience: 1.0  },
  peak:     { whale: 0.75, audience: 1.5  },
  cooling:  { whale: 1.6,  audience: 0.5  },
};

// ── Phase detection ──────────────────────────────────────────────────────────

function detectPhase(ctx) {
  const { sessionMin, tph, totalTips, burst, convRate, decelerating } = ctx;
  if (sessionMin < 10 || (tph < 30 && totalTips < 40)) return 'warming';
  if (decelerating && tph < 90) return 'cooling';
  if (tph > 120 || (burst && convRate > 3)) return 'peak';
  return 'building';
}

// ── Main detector ────────────────────────────────────────────────────────────

/**
 * detectSignals(snapshot, thresholds, viewerHistory, thirtyDayHistory)
 *
 * @param {Object} snapshot           LiveData from EarningsTracker + present fans.
 *                                    Shape: { whales, fans, viewers, totalTips,
 *                                             tokensPerHour, convRate, tipEvents,
 *                                             startTime }
 * @param {Object} thresholds         { whaleMin, bigTipperMin, tipperMin } —
 *                                    from performer_signal_thresholds (cloud-synced).
 * @param {Array}  viewerHistory      Mutable { t, v } array. Caller persists it
 *                                    across calls; detectSignals appends + prunes.
 * @param {Object} thirtyDayHistory   Optional { [username]: { total } } from cloud.
 *
 * @returns {Object} { phase, phaseWeights, signals: { ... }, context: { ... } }
 */
function detectSignals(snapshot, thresholds, viewerHistory, thirtyDayHistory) {
  thirtyDayHistory = thirtyDayHistory || {};
  const now = Date.now();
  const whales    = snapshot.whales    || [];
  const fans      = snapshot.fans      || [];
  const viewers   = snapshot.viewers   || 0;
  const totalTips = snapshot.totalTips || 0;
  const tph       = snapshot.tokensPerHour || 0;
  const convRate  = parseFloat(snapshot.convRate) || 0;
  const tipEvents = snapshot.tipEvents || [];
  const startTime = snapshot.startTime || (now - 10 * 60000);
  const sessionMin = (now - startTime) / 60000;
  const whaleMin = (thresholds && thresholds.whaleMin) || 200;

  const activeWhales = whales.filter((w) => w.present !== false);
  const tippers      = fans.filter((f) => f.tips > 0);
  const lurkers      = Math.max(0, viewers - tippers.length);

  // ── Velocity: 5-min window vs prior 5–15 min window (normalised) ──────────
  const tips5m    = tipEvents.filter((e) => now - e.timestamp < 5 * 60000);
  const tips5_15m = tipEvents.filter((e) => {
    const age = now - e.timestamp;
    return age >= 5 * 60000 && age < 15 * 60000;
  });
  const vol5m    = tips5m.reduce((s, e) => s + e.amount, 0);
  const vol5_15m = tips5_15m.reduce((s, e) => s + e.amount, 0) / 2;
  const accelerating = vol5m > vol5_15m * 1.25 && vol5m > 0;
  const decelerating = vol5_15m > 0 && vol5m < vol5_15m * 0.55;

  // ── Burst: 2+ tip events in last 90 seconds ───────────────────────────────
  const burst = tipEvents.filter((e) => now - e.timestamp < 90000).length >= 2;

  // ── Per-user recency ──────────────────────────────────────────────────────
  const whaleLast = {};
  tipEvents.forEach((e) => {
    if (!whaleLast[e.username] || e.timestamp > whaleLast[e.username]) {
      whaleLast[e.username] = e.timestamp;
    }
  });

  // ── Quiet whales: active but no tip in 5+ min ─────────────────────────────
  const quietWhales = activeWhales.filter(
    (w) => whaleLast[w.username] && now - whaleLast[w.username] > 5 * 60000,
  );

  // ── Returning whales: left and came back (joins > 1) ──────────────────────
  const returningWhales = activeWhales.filter((w) => (w.joins || 0) > 1);

  // ── Cascade: 3+ unique tippers in last 2 min → social proof forming ──────
  const tips2m = tipEvents.filter((e) => now - e.timestamp < 2 * 60000);
  const uniqueTip2mSet = new Set(tips2m.map((e) => e.username));
  const cascade = uniqueTip2mSet.size >= 3;

  // ── Spike tip: single tip ≥ 100 in last 60s ──────────────────────────────
  const spikeTip = tipEvents.find((e) => now - e.timestamp < 60000 && e.amount >= 100) || null;

  // ── Anchor: largest single tip this session ──────────────────────────────
  const topTipEvent = tipEvents.reduce(
    (max, e) => (e.amount > (max.amount || 0) ? e : max),
    {},
  );
  const topTipAmount = topTipEvent.amount || 0;

  // ── First tipper recent: exactly 1 tipper, tipped in last 90s ────────────
  const lastTipTs = tipEvents.length > 0 ? Math.max(...tipEvents.map((e) => e.timestamp)) : 0;
  const firstTipRecent = tippers.length === 1 && lastTipTs > 0 && now - lastTipTs < 90000;

  // ── Next milestone: within 12% of round-number total ─────────────────────
  const nextMilestone = MILESTONES.find(
    (m) => m > totalTips && (m - totalTips) / m <= 0.12,
  ) || null;

  // ── Competitive gap: top 2 tippers within 20% ────────────────────────────
  const sortedTippers = [...tippers].sort((a, b) => (b.tips || 0) - (a.tips || 0));
  const competitiveGap =
    sortedTippers.length >= 2 &&
    (sortedTippers[0].tips || 0) > 0 &&
    (sortedTippers[0].tips - sortedTippers[1].tips) / sortedTippers[0].tips < 0.20;

  // ── Viewer surge: > 25% and > 5 more viewers in last 3 min ───────────────
  viewerHistory.push({ t: now, v: viewers });
  if (viewerHistory.length > 120) viewerHistory.shift(); // cap at ~6 min @ 3s interval
  const oldVHEntry = viewerHistory.find((h) => now - h.t >= 3 * 60000);
  const viewerSurge = !!(
    oldVHEntry && viewers > oldVHEntry.v * 1.25 && viewers > oldVHEntry.v + 5
  );

  // ── High-value returnee: historical whale-min tipper, present, no tip today ─
  const hvReturnee = fans.find((f) => {
    const hist = thirtyDayHistory[f.username];
    return hist && hist.total >= whaleMin && f.present !== false && !(f.tips > 0);
  }) || null;

  // ── Dead air: 4+ min silent in established session, or 12+ min no tips ──
  const deadAir =
    lastTipTs > 0
      ? now - lastTipTs > 4 * 60000 && sessionMin > 8
      : sessionMin > 12 && totalTips === 0;

  // ── Churn-risk whale: tipped ≥ threshold this session, silent 8+ min ────
  const churnRiskWhale = activeWhales.find(
    (w) =>
      whaleLast[w.username] &&
      now - whaleLast[w.username] > 8 * 60000 &&
      (w.tips || 0) >= whaleMin,
  ) || null;

  // ── Streak: same user tipped 3+ separate times ──────────────────────────
  const tipCounts = {};
  tipEvents.forEach((e) => {
    tipCounts[e.username] = (tipCounts[e.username] || 0) + 1;
  });
  const streakTipper = fans.find((f) => (tipCounts[f.username] || 0) >= 3) || null;

  // ── Phase ────────────────────────────────────────────────────────────────
  const phase = detectPhase({ sessionMin, tph, totalTips, burst, convRate, decelerating });
  const phaseWeights = PHASE_WEIGHTS[phase];

  return {
    phase,
    phaseWeights,
    signals: {
      accelerating,
      decelerating,
      burst,
      quietWhales,
      returningWhales,
      cascade,
      spikeTip,
      firstTipRecent,
      nextMilestone,
      competitiveGap,
      viewerSurge,
      hvReturnee,
      deadAir,
      churnRiskWhale,
      streakTipper,
    },
    context: {
      now,
      sessionMin,
      vol5m,
      vol5_15m,
      viewers,
      tippers,
      lurkers,
      activeWhales,
      whaleLast,
      topTipEvent,
      topTipAmount,
      tipCounts,
      uniqueTip2mCount: uniqueTip2mSet.size,
      sortedTippers,
      whaleMin,
      tph,
      totalTips,
      convRate,
    },
  };
}

module.exports = { detectSignals, detectPhase, PHASE_WEIGHTS, MILESTONES };
