/**
 * Apex Revenue — Prompt Builder
 *
 * Pure module ported from Apex-Revenue-Edge overlay.js (lines 1033–1210).
 * Consumes the output of shared/signals.js and produces an array of
 * prompt candidates. Scoring happens separately in shared/prompt-scoring.js.
 *
 * Prompt shape:
 *   {
 *     heat: 'hot' | 'medium' | '',
 *     icon: string,
 *     urgency: 'critical' | 'high' | 'medium',    // optional — only platinum-tier
 *     confidence: 1 | 2,                          // optional — only platinum-tier
 *     action: string,
 *     reason: string,
 *     value: number,
 *     tag: string,
 *     username?: string,
 *     userTips?: number,
 *     physicalReactionRequired?: boolean,         // Phase 2 will tag these
 *   }
 */

/**
 * buildPrompts(sig)
 *
 * @param {Object} sig  Output of detectSignals({ phase, phaseWeights, signals, context }).
 * @returns {Array} Array of prompt candidates, unscored.
 */
function buildPrompts(sig) {
  const { phase, phaseWeights: pw, signals: s, context: c } = sig;
  const prompts = [];

  const {
    viewers, tippers, lurkers, activeWhales, topTipEvent, topTipAmount,
    tipCounts, uniqueTip2mCount, vol5m, whaleMin, tph, totalTips, convRate,
    sessionMin, sortedTippers,
  } = c;

  // ── WHALE-BIASED (high weight in warming + cooling) ────────────────────────

  if (activeWhales.length >= 1) {
    const w = activeWhales[0];
    const reason =
      phase === 'warming' ? 'Early whale engagement sets the tip culture for the room'
      : phase === 'cooling' ? 'Your top spender is still here — a direct callout re-ignites'
      : phase === 'building' ? 'Personal attention converts high-value viewers'
      : 'Acknowledge your biggest tipper while momentum is hot';
    prompts.push({
      heat: 'hot',
      icon: '🎯',
      action: 'Call out ' + w.username + ' by name',
      reason,
      value: Math.round(((w.tips || 20) * 0.55 + 20) * pw.whale),
      tag: 'whale',
      username: w.username,
      userTips: w.tips || 0,
    });
  }

  if (s.quietWhales.length >= 1) {
    const qw = s.quietWhales[0];
    prompts.push({
      heat: 'hot',
      icon: '🔔',
      action: 'Re-engage ' + qw.username + ' — they\'ve gone quiet',
      reason: 'Present but silent 5+ min — direct attention often reactivates spending',
      value: Math.round(((qw.tips || 30) * 0.45 + 15) * pw.whale),
      tag: 'whale',
      username: qw.username,
      userTips: qw.tips || 0,
    });
  }

  if (s.returningWhales.length >= 1) {
    const rw = s.returningWhales[0];
    prompts.push({
      heat: 'hot',
      icon: '🔄',
      action: 'Welcome ' + rw.username + ' back to the room',
      reason: 'Returned ' + rw.joins + ' times — acknowledging return visits drives larger tips',
      value: Math.round(((rw.tips || 25) * 0.6 + 12) * pw.whale),
      tag: 'whale',
      username: rw.username,
      userTips: rw.tips || 0,
    });
  }

  if (activeWhales.length >= 2) {
    const goalType = phase === 'peak' ? 'Launch a timed group goal NOW' : 'Launch a whale-tier exclusive goal';
    const wTotal = activeWhales.reduce((sum, w) => sum + (w.tips || 20), 0);
    prompts.push({
      heat: 'hot',
      icon: '💰',
      action: goalType,
      reason:
        activeWhales.length +
        ' whales in room — ' +
        (phase === 'peak' ? 'peak momentum, maximize immediately' : 'high-value moment'),
      value: Math.round(wTotal * 0.42 * pw.whale),
      tag: 'whale',
    });
  }

  if (s.decelerating && activeWhales.length > 0) {
    prompts.push({
      heat: 'hot',
      icon: '🔥',
      action: 'Drop a limited-time exclusive offer',
      reason: 'Tip velocity is declining — urgency resets momentum and re-engages big spenders',
      value: Math.round(tph * 0.22 * pw.whale),
      tag: 'whale',
    });
  }

  if (phase === 'warming' && sessionMin < 12 && activeWhales.length === 0) {
    prompts.push({
      heat: 'medium',
      icon: '🎪',
      action: 'Tease an exclusive unlock goal',
      reason: 'Early session — setting expectations now primes whale spending for later',
      value: Math.round(viewers * 0.025 * 10 * pw.whale),
      tag: 'whale',
    });
  }

  // ── AUDIENCE-WIDE (high weight in peak + building) ─────────────────────────

  if (lurkers > 15) {
    const urgency =
      phase === 'peak'
        ? 'Room energy is high — this is the best moment to convert lurkers'
        : Math.round(lurkers) + ' viewers haven\'t tipped yet';
    prompts.push({
      heat: phase === 'peak' ? 'hot' : 'medium',
      icon: '📢',
      action: 'Announce your tip menu out loud',
      reason: urgency,
      value: Math.round(lurkers * 0.022 * 10 * pw.audience),
      tag: 'audience',
    });
  }

  if (convRate < 2.5 && viewers > 15) {
    prompts.push({
      heat: 'medium',
      icon: '✨',
      action: 'Run a quick viewer poll in chat',
      reason: 'Conv rate ' + convRate + '% — polls shift lurkers from passive to engaged',
      value: Math.round(viewers * 0.016 * 10 * pw.audience),
      tag: 'audience',
    });
  }

  if ((s.burst || s.accelerating) && phase !== 'cooling') {
    const burstReason = s.burst
      ? '2+ tips in 90 seconds — capitalise before the window closes'
      : 'Tip rate accelerating — a timed goal locks in momentum';
    prompts.push({
      heat: 'hot',
      icon: '⏱️',
      action: 'Set a 5-minute countdown goal',
      reason: burstReason,
      value: Math.round(tph * 0.17 * (phase === 'peak' ? pw.audience : pw.whale)),
      tag: 'momentum',
    });
  }

  if (tippers.length >= 3 && totalTips > 40 && phase !== 'warming') {
    const top = tippers[0];
    prompts.push({
      heat: 'medium',
      icon: '🏆',
      action: 'Thank ' + top.username + ' as top tipper publicly',
      reason:
        phase === 'peak'
          ? 'Public recognition during peak triggers copycat tipping'
          : 'Social proof drives repeat tips from others',
      value: Math.round((top.tips * 0.2 + 10) * pw.audience),
      tag: 'audience',
      username: top.username,
      userTips: top.tips || 0,
    });
  }

  if (viewers > 80 && tippers.length < 4 && phase !== 'warming') {
    prompts.push({
      heat: 'hot',
      icon: '🎪',
      action: 'Tease an exclusive unlock — big room, few tippers',
      reason: 'Large audience with low conversion — urgency prompt converts fence-sitters',
      value: Math.round(viewers * 0.03 * 10 * pw.audience),
      tag: 'audience',
    });
  }

  // ── PLATINUM-TIER SIGNALS ───────────────────────────────────────────────────
  //     (explicit urgency + confidence for composite scoring)

  // 1. Cascade
  if (s.cascade) {
    prompts.push({
      heat: 'hot',
      icon: '🌊',
      urgency: 'critical',
      confidence: 2,
      action: 'Ride the cascade — ' + uniqueTip2mCount + ' tippers in 2 min — launch a group goal',
      reason: 'Multi-tipper cluster is the highest-conversion window in any session',
      value: Math.round(vol5m * 0.55 * pw.audience),
      tag: 'cascade',
    });
  }

  // 2. Churn-risk whale
  if (s.churnRiskWhale) {
    const silentMin = Math.round((c.now - c.whaleLast[s.churnRiskWhale.username]) / 60000);
    prompts.push({
      heat: 'hot',
      icon: '⚠️',
      urgency: 'critical',
      confidence: 2,
      action: 'Intervene now — ' + s.churnRiskWhale.username + ' silent ' + silentMin + ' min',
      reason: 'Has tipped ' + (s.churnRiskWhale.tips || 0) + ' tk but re-engagement window is closing fast',
      value: Math.round(((s.churnRiskWhale.tips || whaleMin) * 0.65 + 25) * pw.whale),
      tag: 'churn-whale',
      username: s.churnRiskWhale.username,
      userTips: s.churnRiskWhale.tips || 0,
    });
  }

  // 3. Milestone proximity
  if (s.nextMilestone) {
    const gap = s.nextMilestone - totalTips;
    prompts.push({
      heat: 'hot',
      icon: '🎯',
      urgency: 'high',
      confidence: 2,
      action: 'Call out the milestone — ' + gap + ' tk from ' + s.nextMilestone,
      reason: 'Milestone proximity triggers completion bias — viewers tip to close the gap',
      value: Math.round(gap * 0.8 * pw.audience),
      tag: 'milestone',
    });
  }

  // 4. Competitive gap
  if (s.competitiveGap && sortedTippers.length >= 2) {
    const gap = (sortedTippers[0].tips || 0) - (sortedTippers[1].tips || 0);
    const leader = sortedTippers[0].username;
    const second = sortedTippers[1].username;
    prompts.push({
      heat: 'hot',
      icon: '⚔️',
      urgency: 'high',
      confidence: 2,
      action: 'Tease the leaderboard race — ' + leader + ' leads ' + second + ' by only ' + gap + ' tk',
      reason: 'Competitive framing converts ego-driven tippers — gap this small always escalates',
      value: Math.round(gap * 1.4 * pw.audience),
      tag: 'competition',
      username: leader,
      userTips: sortedTippers[0].tips || 0,
    });
  }

  // 5. First tipper recent
  if (s.firstTipRecent && tippers.length === 1) {
    const ft = tippers[0];
    prompts.push({
      heat: 'hot',
      icon: '🎉',
      urgency: 'critical',
      confidence: 2,
      action: 'Spotlight ' + ft.username + ' — they just opened the tipping',
      reason: 'The first tip sets the social norm for the room — loud acknowledgment multiplies follow-on tips',
      value: Math.round((ft.tips || 15) * 1.8 * pw.audience),
      tag: 'first-tip',
      username: ft.username,
      userTips: ft.tips || 0,
    });
  }

  // 6. Viewer surge
  if (s.viewerSurge) {
    // Find the baseline from 3+ min ago (already computed; recompute gap for display)
    // We approximate using the current viewer count; accurate numbers live in context.
    prompts.push({
      heat: 'hot',
      icon: '📣',
      urgency: 'high',
      confidence: 1,
      action: 'Hook the surge — new viewers in last 3 min — drop your best opener',
      reason: 'New viewers convert highest in the first 90 seconds — don\'t let them lurk into inactivity',
      value: Math.round(viewers * 0.04 * 10 * pw.audience),
      tag: 'surge',
    });
  }

  // 7. High-value returnee
  if (s.hvReturnee) {
    prompts.push({
      heat: 'medium',
      icon: '💎',
      urgency: 'high',
      confidence: 2,
      action: 'Greet ' + s.hvReturnee.username + ' — historic ' + whaleMin + '+ tk tipper, hasn\'t tipped today',
      reason: 'Historically high-value viewer — targeted acknowledgment reactivates dormant spend',
      value: Math.round((whaleMin * 0.3 + 20) * pw.whale),
      tag: 'hv-returnee',
      username: s.hvReturnee.username,
    });
  }

  // 8. Dead air recovery
  if (s.deadAir) {
    prompts.push({
      heat: 'hot',
      icon: '🔇',
      urgency: 'critical',
      confidence: 1,
      action: 'Break the silence — ask a bold question or tease a reveal',
      reason: 'No tips for 4+ min — rooms that go quiet lose 60% of their tippers within 5 min',
      value: Math.round((tph || viewers * 0.5) * 0.3 * pw.audience),
      tag: 'dead-air',
    });
  }

  // 9. Tip size anchor
  if (topTipAmount >= 100 && phase !== 'warming' && !s.spikeTip) {
    prompts.push({
      heat: 'medium',
      icon: '⚡',
      urgency: 'medium',
      confidence: 1,
      action:
        'Anchor the room to ' + topTipAmount + ' tk — thank ' +
        (topTipEvent.username || 'your top tipper') + ' and set a new goal',
      reason: 'Social anchoring: naming a high tip amount shifts the perceived \'normal\' tip upward',
      value: Math.round(topTipAmount * 0.18 * pw.whale),
      tag: 'anchor',
      username: topTipEvent.username || '',
      userTips: topTipAmount,
    });
  }

  // 10. Loyalty streak
  if (s.streakTipper) {
    const streakCount = tipCounts[s.streakTipper.username] || 0;
    prompts.push({
      heat: 'medium',
      icon: '🔁',
      urgency: 'medium',
      confidence: 2,
      action: 'Call out ' + s.streakTipper.username + ' — ' + streakCount + 'x tipper this session',
      reason: 'Publicly rewarding repeat tippers creates loyalty loops and signals it\'s worth tipping again',
      value: Math.round(((s.streakTipper.tips || 20) * 0.25 + 15) * pw.audience),
      tag: 'streak',
      username: s.streakTipper.username,
      userTips: s.streakTipper.tips || 0,
    });
  }

  return prompts;
}

module.exports = { buildPrompts };
