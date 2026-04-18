/**
 * Apex Revenue — Prompt Composite Scoring
 *
 * Pure module ported from Apex-Revenue-Edge overlay.js (lines 1250–1276).
 *
 * Formula:
 *   score = baseValue
 *         × urgencyMult
 *         × confidenceMult
 *         × cooldownFactor
 *         × physicalFatigueFactor
 *
 * Where:
 *   baseValue               prompt's value field, already phase-weighted at build time
 *   urgencyMult             critical 1.85 | high 1.40 | medium 1.00
 *   confidenceMult          2+ signals 1.30 | 1 signal 1.00
 *   cooldownFactor          0.55 if same tag shown in last 3 min, else 1.00
 *   physicalFatigueFactor   1.0 unless prompt requires toy response AND performer
 *                           set a fatigue slider value > 0. Phase 2 Playbook wires
 *                           this to a user setting; Phase 0 passes 0 (no effect).
 */

const URGENCY_MULT  = { critical: 1.85, high: 1.40, medium: 1.00 };
const CONF_MULT     = { 2: 1.30, 1: 1.00 };
const COOLDOWN_MS   = 3 * 60000;
const COOLDOWN_FACTOR = 0.55;

/**
 * scorePrompts(prompts, shownAt, opts)
 *
 * @param {Array}  prompts   Array of { value, urgency, confidence, tag,
 *                                      physicalReactionRequired? }
 * @param {Object} shownAt   { [tag]: lastShownTimestamp } — caller maintains.
 * @param {Object} opts      { now?, physicalFatigueFactor? (0–1) }
 *
 * @returns {Array} New sorted array with ._score and ._breakdown added.
 */
function scorePrompts(prompts, shownAt, opts) {
  shownAt = shownAt || {};
  opts = opts || {};
  const now = opts.now || Date.now();
  const fatigueRaw = typeof opts.physicalFatigueFactor === 'number' ? opts.physicalFatigueFactor : 0;
  const fatigue = Math.max(0, Math.min(1, fatigueRaw));

  const scored = prompts.map((p) => {
    const u = URGENCY_MULT[p.urgency] || 1.00;
    const c = CONF_MULT[p.confidence] || 1.00;
    const age = shownAt[p.tag] ? now - shownAt[p.tag] : Infinity;
    const cool = age < COOLDOWN_MS ? COOLDOWN_FACTOR : 1.00;
    const fatigueMult = p.physicalReactionRequired ? 1 - fatigue : 1;

    const score = (p.value || 0) * u * c * cool * fatigueMult;
    return {
      ...p,
      _score: score,
      _breakdown: {
        baseValue: p.value || 0,
        urgencyMult: u,
        confidenceMult: c,
        cooldownFactor: cool,
        physicalFatigueFactor: fatigueMult,
      },
    };
  });

  scored.sort((a, b) => b._score - a._score);
  return scored;
}

module.exports = { scorePrompts, URGENCY_MULT, CONF_MULT, COOLDOWN_MS };
