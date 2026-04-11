/**
 * ============================================================
 *  SensationsService v1.0
 *  Pure Node.js extraction of ApexSensations CB app logic
 *
 *  Removes all Chaturbate (cb.*) dependencies.
 *  Uses Node.js EventEmitter for output.
 *  Preserves ALL math/logic: combo bonus, auto-reset, overflow handling, cascading.
 * ============================================================
 */

const EventEmitter = require('events');

class SensationsService extends EventEmitter {
  constructor() {
    super();

    // ─── State ───────────────────────────────────────
    this.state = {
      tipQueue: [],
      processing: false,
      sessionTokens: 0,
      leaderboard: [],
      comboTracker: {},
      comboWindow: 30000, // 30s window for combo tracking

      // One-time goal
      goalProgress: 0,
      goalComplete: false,

      // Auto-reset goal
      arProgress: 0,        // tokens toward current cycle
      arCount: 0,           // cycles completed
      arLastTime: null,     // Date of last reset
      arFinale: false,      // grand finale fired

      // Live tier range overrides
      tierOverrides: { 1: null, 2: null, 3: null, 4: null, 5: null },

      // Connection state
      connected: false,

      // Built tier definitions (5-tier objects)
      tiers: [],
    };

    // ─── Settings with defaults (matching CB app) ────────────────────
    this.settings = {
      // Vibration Tiers
      tier1_label: 'Tease',
      tier1_min: 1,
      tier1_max: 24,
      tier1_vibe: 3,
      tier1_secs: 3,

      tier2_label: 'Feel It',
      tier2_min: 25,
      tier2_max: 74,
      tier2_vibe: 8,
      tier2_secs: 6,

      tier3_label: 'Intense',
      tier3_min: 75,
      tier3_max: 149,
      tier3_vibe: 13,
      tier3_secs: 10,

      tier4_label: 'Wild',
      tier4_min: 150,
      tier4_max: 299,
      tier4_vibe: 17,
      tier4_secs: 15,

      tier5_label: 'MAX POWER',
      tier5_min: 300,
      tier5_max: 999999,
      tier5_vibe: 20,
      tier5_secs: 25,

      // Special Commands
      enable_earthquake: 'yes',
      earthquake_tokens: 100,
      earthquake_secs: 15,

      enable_fireworks: 'yes',
      fireworks_tokens: 150,
      fireworks_secs: 20,

      enable_wave: 'yes',
      wave_tokens: 50,
      wave_secs: 10,

      enable_pulse: 'yes',
      pulse_tokens: 75,
      pulse_secs: 12,

      enable_control: 'yes',
      control_tokens: 200,
      control_secs: 60,

      enable_pause: 'yes',
      pause_tokens: 25,
      pause_secs: 10,

      // Auto-Reset Tip Goal
      enable_auto_reset: 'yes',
      ar_tokens: 200,
      ar_desc: 'Tip goal — toy bursts on reset!',
      ar_reward: 'fireworks',
      ar_reward_secs: 20,
      ar_update_subject: 'yes',
      ar_max: 0, // 0 = unlimited

      ar_finale_desc: 'ALL GOALS COMPLETE! Thank you everyone! 🏆',

      // One-Time Session Goal
      enable_goal: 'no',
      goal_tokens: 1000,
      goal_desc: 'Toy goes MAX for 60 seconds!',

      // Display
      menu_interval: 5,
      show_queue: 'yes',
      show_leaderboard: 'yes',
      combo_bonus: 'yes',
      toy_name: 'Lush',
      toy_emoji: '💗',
      welcome_msg: 'Tip to vibe my toy {toy_emoji}! /menu for tiers | /reset for goal',
    };

    // Auto-bind methods so they can be passed as callbacks
    this.processQueue = this.processQueue.bind(this);
    this.executeJob = this.executeJob.bind(this);
  }

  /**
   * Apply settings, rebuild tier definitions.
   */
  configure(settings) {
    if (settings) {
      Object.assign(this.settings, settings);
    }
    this.buildTiers();
  }

  /**
   * Build tier definitions from settings, respecting runtime overrides.
   * Sets this.state.tiers to the 5 tier objects.
   */
  buildTiers() {
    const defs = [
      {
        id: 1,
        label: this.settings.tier1_label,
        min: this.settings.tier1_min,
        max: this.settings.tier1_max,
        vibe: this.settings.tier1_vibe,
        secs: this.settings.tier1_secs,
        emoji: '🔵',
      },
      {
        id: 2,
        label: this.settings.tier2_label,
        min: this.settings.tier2_min,
        max: this.settings.tier2_max,
        vibe: this.settings.tier2_vibe,
        secs: this.settings.tier2_secs,
        emoji: '💜',
      },
      {
        id: 3,
        label: this.settings.tier3_label,
        min: this.settings.tier3_min,
        max: this.settings.tier3_max,
        vibe: this.settings.tier3_vibe,
        secs: this.settings.tier3_secs,
        emoji: '💗',
      },
      {
        id: 4,
        label: this.settings.tier4_label,
        min: this.settings.tier4_min,
        max: this.settings.tier4_max,
        vibe: this.settings.tier4_vibe,
        secs: this.settings.tier4_secs,
        emoji: '🔥',
      },
      {
        id: 5,
        label: this.settings.tier5_label,
        min: this.settings.tier5_min,
        max: this.settings.tier5_max,
        vibe: this.settings.tier5_vibe,
        secs: this.settings.tier5_secs,
        emoji: '⚡',
      },
    ];

    // Apply runtime overrides
    for (let i = 0; i < defs.length; i++) {
      const ov = this.state.tierOverrides[defs[i].id];
      if (ov) {
        defs[i].min = ov.min;
        defs[i].max = ov.max;
        defs[i].overridden = true;
      }
    }

    this.state.tiers = defs;
  }

  /**
   * Get effective {min, max} for a tier id (1–5).
   * Checks runtime overrides first, falls back to configured settings.
   */
  getEffectiveRange(tierId) {
    if (this.state.tierOverrides[tierId]) {
      return this.state.tierOverrides[tierId];
    }
    const defaults = [
      null,
      { min: this.settings.tier1_min, max: this.settings.tier1_max },
      { min: this.settings.tier2_min, max: this.settings.tier2_max },
      { min: this.settings.tier3_min, max: this.settings.tier3_max },
      { min: this.settings.tier4_min, max: this.settings.tier4_max },
      { min: this.settings.tier5_min, max: this.settings.tier5_max },
    ];
    return defaults[tierId];
  }

  /**
   * Auto-fix adjacent tier range overlaps.
   * Forward cascade: if tier[i].max >= tier[i+1].min → push tier[i+1].min up
   * Backward cascade: if tier[i].min <= tier[i-1].max → pull tier[i-1].max down
   * Returns array of human-readable notes describing adjustments.
   */
  cascadeOverlaps(changedTierId) {
    const notes = [];
    const em = { 1: '🔵', 2: '💜', 3: '💗', 4: '🔥', 5: '⚡' };

    // Forward cascade
    for (let i = changedTierId; i <= 4; i++) {
      const curr = this.getEffectiveRange(i);
      const next = this.getEffectiveRange(i + 1);
      if (parseInt(curr.max, 10) >= parseInt(next.min, 10)) {
        const newMin = parseInt(curr.max, 10) + 1;
        // Safety: don't collapse the next tier
        if (newMin > parseInt(next.max, 10)) {
          notes.push(
            `⚠️ Tier ${i + 1} ${em[i + 1]} would collapse — cascade stopped. Adjust manually.`
          );
          break;
        }
        const prevMin = next.min;
        this.state.tierOverrides[i + 1] = { min: newMin, max: parseInt(next.max, 10) };
        notes.push(`↳ Tier ${i + 1} ${em[i + 1]} min: ${prevMin} → ${newMin}`);
      } else {
        break;
      }
    }

    // Backward cascade
    for (let j = changedTierId; j >= 2; j--) {
      const curr2 = this.getEffectiveRange(j);
      const prev = this.getEffectiveRange(j - 1);
      if (parseInt(curr2.min, 10) <= parseInt(prev.max, 10)) {
        const newMax = parseInt(curr2.min, 10) - 1;
        // Safety: don't collapse the previous tier
        if (newMax < parseInt(prev.min, 10)) {
          notes.push(
            `⚠️ Tier ${j - 1} ${em[j - 1]} would collapse — cascade stopped. Adjust manually.`
          );
          break;
        }
        const prevMax = prev.max;
        this.state.tierOverrides[j - 1] = { min: parseInt(prev.min, 10), max: newMax };
        notes.push(`↳ Tier ${j - 1} ${em[j - 1]} max: ${prevMax} → ${newMax}`);
      } else {
        break;
      }
    }

    return notes;
  }

  /**
   * Find matching tier for a tip amount.
   * Checks tiers from highest to lowest (5 down to 1).
   */
  getTier(amount) {
    const tiers = this.state.tiers.length > 0 ? this.state.tiers : this.buildTiers();
    for (let i = tiers.length - 1; i >= 0; i--) {
      const t = tiers[i];
      if (amount >= parseInt(t.min, 10) && amount <= parseInt(t.max, 10)) {
        return t;
      }
    }
    return null;
  }

  /**
   * Check for exact special pattern match.
   */
  getSpecial(amount) {
    const s = this.settings;
    const amt = parseInt(amount, 10);

    if (s.enable_earthquake === 'yes' && amt === parseInt(s.earthquake_tokens, 10))
      return { type: 'earthquake', secs: s.earthquake_secs, vibeLevel: 20, emoji: '🌋', label: 'EARTHQUAKE' };

    if (s.enable_fireworks === 'yes' && amt === parseInt(s.fireworks_tokens, 10))
      return { type: 'fireworks', secs: s.fireworks_secs, vibeLevel: 20, emoji: '🎆', label: 'FIREWORKS' };

    if (s.enable_wave === 'yes' && amt === parseInt(s.wave_tokens, 10))
      return { type: 'wave', secs: s.wave_secs, vibeLevel: 12, emoji: '🌊', label: 'WAVE' };

    if (s.enable_pulse === 'yes' && amt === parseInt(s.pulse_tokens, 10))
      return { type: 'pulse', secs: s.pulse_secs, vibeLevel: 15, emoji: '💓', label: 'PULSE' };

    if (s.enable_control === 'yes' && amt === parseInt(s.control_tokens, 10))
      return { type: 'giveControl', secs: s.control_secs, vibeLevel: 0, emoji: '🎮', label: 'GIVE CONTROL' };

    if (s.enable_pause === 'yes' && amt === parseInt(s.pause_tokens, 10))
      return { type: 'pause', secs: s.pause_secs, vibeLevel: 0, emoji: '⏸', label: 'PAUSE' };

    return null;
  }

  /**
   * Main entry point: process a tip.
   * Updates leaderboard, checks auto-reset, checks session goal,
   * routes to tier/special, enqueues job.
   */
  handleTip(user, amount) {
    const amountInt = parseInt(amount, 10);

    this.state.sessionTokens += amountInt;
    this.updateLeaderboard(user, amountInt);

    // Goal systems (both independent, both run on every tip)
    this.handleAutoReset(user, amountInt);
    this.handleSessionGoal(amountInt, user);

    // Vibration routing
    const combo = this.checkCombo(user);
    const special = this.getSpecial(amountInt);
    const tier = this.getTier(amountInt);

    if (special) {
      this.state.tipQueue.push({
        user,
        amount: amountInt,
        pattern: special.type,
        vibeLevel: special.vibeLevel,
        secs: special.secs,
        tierLabel: `${special.emoji} ${special.label}`,
        combo,
      });
    } else if (tier) {
      this.state.tipQueue.push({
        user,
        amount: amountInt,
        pattern: 'vibrate',
        vibeLevel: tier.vibe,
        secs: tier.secs,
        tierLabel: `${tier.emoji} ${tier.label}`,
        combo,
      });
    } else {
      this.emit('notice', {
        msg: `${this.settings.toy_emoji} Thank you ${user} for ${amountInt} tokens! 💖`,
        user: '',
        bg: '#1a0a2e',
        fg: '#d4a8ff',
        weight: 'normal',
      });
    }

    if (!this.state.processing) {
      this.processQueue();
    }

    // Show leaderboard on high tier tips if enough top tippers
    if (tier && tier.id >= 4 && this.state.leaderboard.length >= 3) {
      setTimeout(() => this.showLeaderboard(), 3000);
    }

    this.emit('queueUpdate', {
      length: this.state.tipQueue.length,
      processing: this.state.processing,
    });
  }

  /**
   * Track consecutive tips within 30s window.
   * Returns combo multiplier (1, 2, 3, etc.).
   */
  checkCombo(user) {
    if (this.settings.combo_bonus !== 'yes') return 1;

    const now = Date.now();
    if (!this.state.comboTracker[user]) {
      this.state.comboTracker[user] = { count: 1, lastTime: now };
      return 1;
    }

    const t = this.state.comboTracker[user];
    if (now - t.lastTime <= this.state.comboWindow) {
      t.count++;
      t.lastTime = now;
      return t.count;
    }

    t.count = 1;
    t.lastTime = now;
    return 1;
  }

  /**
   * Dequeue and execute jobs serially.
   */
  processQueue() {
    if (this.state.tipQueue.length === 0) {
      this.state.processing = false;
      this.emit('queueUpdate', { length: 0, processing: false });
      return;
    }

    this.state.processing = true;
    const job = this.state.tipQueue.shift();
    this.executeJob(job);
  }

  /**
   * Execute a single queued job.
   * Applies combo bonus (+25% per hit, capped at 3×).
   * Emits vibration command with final duration.
   * Schedules next job after delay.
   */
  executeJob(job) {
    let duration = parseInt(job.secs, 10);

    // Combo bonus: +25% per extra hit, capped at 3×
    if (job.combo > 1 && !job.isReset) {
      const bonus = Math.floor(duration * 0.25 * (job.combo - 1));
      duration = Math.min(duration + bonus, duration * 3);
    }

    // Emit vibration command (matches [PS_CMD] JSON schema from CB app)
    const psCmd = {
      app: 'apexsensations',
      event: 'tip',
      user: job.user,
      amount: job.amount,
      pattern: job.pattern,
      vibe: job.vibeLevel,
      rotate: job.rotate || 0,
      pump: job.pump || 0,
      secs: duration,
      combo: job.combo,
    };

    this.emit('vibrate', psCmd);

    // Room-visible notice (skipped for reset reward)
    if (!job.isReset) {
      const comboStr =
        job.combo > 1
          ? ` 🔥 x${job.combo} COMBO! +${duration - parseInt(job.secs, 10)}s!`
          : '';

      let roomMsg;
      if (job.pattern === 'giveControl') {
        roomMsg = `🎮 ${job.user} has CONTROL of my ${this.settings.toy_name} for ${duration}s!`;
      } else if (job.pattern === 'pause') {
        roomMsg = `⏸ ${job.user} paused my toy for ${duration}s`;
      } else if (['earthquake', 'fireworks', 'wave', 'pulse'].includes(job.pattern)) {
        const pEmoji = {
          earthquake: '🌋',
          fireworks: '🎆',
          wave: '🌊',
          pulse: '💓',
        }[job.pattern];
        roomMsg =
          `${pEmoji} ${job.user} triggered ${job.pattern.toUpperCase()}` +
          ` on my ${this.settings.toy_name} for ${duration}s!${comboStr}`;
      } else {
        roomMsg =
          `${this.settings.toy_emoji} ${job.user} tipped ${job.amount}` +
          ` tkns → ${job.tierLabel}` +
          ` (Lvl ${job.vibeLevel}/20 • ${duration}s)${comboStr}`;
      }

      this.emit('notice', {
        msg: roomMsg,
        user: '',
        bg: '#1a0a2e',
        fg: '#f0d6ff',
        weight: 'bold',
      });
    }

    // Queue depth notice
    if (
      this.settings.show_queue === 'yes' &&
      this.state.tipQueue.length > 0
    ) {
      const next = [];
      for (let i = 0; i < Math.min(this.state.tipQueue.length, 3); i++) {
        next.push(`${this.state.tipQueue[i].user} (${this.state.tipQueue[i].amount})`);
      }
      this.emit('notice', {
        msg: `⏳ Queue: ${next.join(' → ')}`,
        user: '',
        bg: '#0d0820',
        fg: '#9b72cf',
        weight: 'normal',
      });
    }

    // Schedule next job
    setTimeout(this.processQueue, (duration + 1) * 1000);
  }

  /**
   * Check if current cycle completes on this tip, handle overflow.
   */
  handleAutoReset(user, amount) {
    if (this.settings.enable_auto_reset !== 'yes') return;
    if (this.state.arFinale) return;

    this.state.arProgress += amount;

    if (this.state.arProgress >= parseInt(this.settings.ar_tokens, 10)) {
      this.fireAutoReset(user);
    }

    if (this.settings.ar_update_subject === 'yes') {
      this.updateSubject();
    }
  }

  /**
   * Process one or more completed cycles from a single tip.
   * A large tip can push through multiple cycle thresholds.
   */
  fireAutoReset(user) {
    const arTokens = parseInt(this.settings.ar_tokens, 10);
    const maxCycles = parseInt(this.settings.ar_max, 10) || 0;
    const cyclesThisTip = Math.floor(this.state.arProgress / arTokens);

    for (let i = 0; i < cyclesThisTip; i++) {
      if (maxCycles > 0 && this.state.arCount >= maxCycles) break;

      this.state.arCount++;
      this.state.arProgress -= arTokens;
      this.state.arLastTime = new Date();

      // Reward emoji map
      const rEmoji = {
        fireworks: '🎆',
        earthquake: '🌋',
        wave: '🌊',
        pulse: '💓',
        maxvibe: '⚡',
        none: '✅',
      }[this.settings.ar_reward] || '🎆';

      const cycleLabel = this.ordinal(this.state.arCount);

      // Room-wide announcement
      const msg =
        '╔══════════════════════════════════╗\n' +
        `║  🔄 GOAL HIT — ${cycleLabel} TIME!  ║\n` +
        `║  ${this.settings.ar_desc}\n` +
        `║  ${user} tipped the final tokens!\n` +
        `║  ${rEmoji} Toy reward: ${this.settings.ar_reward} for ${this.settings.ar_reward_secs}s\n` +
        '╚══════════════════════════════════╝';

      this.emit('notice', {
        msg,
        user: '',
        bg: '#0a1a0a',
        fg: '#6aff6a',
        weight: 'bold',
      });
      this.emit('autoReset', { cycle: this.state.arCount, user });

      // Priority-inject toy reward into front of queue
      if (this.settings.ar_reward !== 'none') {
        const rewardPatterns = {
          fireworks: { type: 'fireworks', vibe: 20 },
          earthquake: { type: 'earthquake', vibe: 20 },
          wave: { type: 'wave', vibe: 14 },
          pulse: { type: 'pulse', vibe: 16 },
          maxvibe: { type: 'vibrate', vibe: 20 },
        };
        const rp = rewardPatterns[this.settings.ar_reward] || rewardPatterns['fireworks'];

        this.state.tipQueue.unshift({
          user: `🔄 RESET #${this.state.arCount}`,
          amount: arTokens,
          pattern: rp.type,
          vibeLevel: rp.vibe,
          secs: parseInt(this.settings.ar_reward_secs, 10),
          tierLabel: `${rEmoji} RESET REWARD`,
          combo: 1,
          isReset: true,
        });

        if (!this.state.processing) {
          this.processQueue();
        }
      }

      // Grand finale check
      if (maxCycles > 0 && this.state.arCount >= maxCycles) {
        this.state.arFinale = true;
        setTimeout(
          () => this.fireGrandFinale(),
          (parseInt(this.settings.ar_reward_secs, 10) + 3) * 1000
        );
        break;
      }

      // Post-reset refresh notice (delayed)
      ((count) => {
        setTimeout(() => {
          if (!this.state.arFinale) {
            const remaining = this.arRemaining();
            const msg =
              `🔄 Goal reset! ${remaining} tkns to next cycle\n` +
              this.progressBar(this.state.arProgress, arTokens, 16);

            this.emit('notice', {
              msg,
              user: '',
              bg: '#0a0a1a',
              fg: '#72c4f0',
              weight: 'normal',
            });

            if (this.settings.ar_update_subject === 'yes') {
              this.updateSubject();
            }
          }
        }, 4000);
      })(this.state.arCount);
    }
  }

  /**
   * Emit grand finale notification.
   */
  fireGrandFinale() {
    const msg =
      `🎉🏆🎉 ${this.settings.ar_finale_desc} 🎉🏆🎉\n` +
      `${this.state.arCount} cycles completed this session!\n` +
      `Total tipped: ${this.state.sessionTokens} tokens — LEGENDARY!`;

    this.emit('notice', {
      msg,
      user: '',
      bg: '#2a1a00',
      fg: '#ffd700',
      weight: 'bold',
    });

    this.emit('vibrate', {
      app: 'apexsensations',
      event: 'grandFinale',
      pattern: 'fireworks',
      vibe: 20,
      secs: 60,
    });

    this.emit('grandFinale', { cycles: this.state.arCount });
  }

  /**
   * Update room subject with tokens remaining (if enabled).
   */
  updateSubject() {
    if (
      this.settings.enable_auto_reset !== 'yes' ||
      this.settings.ar_update_subject !== 'yes'
    )
      return;

    const remaining = this.arRemaining();
    const cycleInfo =
      this.state.arCount > 0
        ? ` | 🔄 Cycle #${this.state.arCount + 1}: ${remaining} tkns to reset`
        : ` | 🔄 ${remaining} tkns to first goal`;

    this.emit('subjectUpdate', {
      subject: this.settings.ar_desc + cycleInfo,
    });
  }

  /**
   * Handle one-time session goal.
   */
  handleSessionGoal(amount, user) {
    if (this.settings.enable_goal !== 'yes' || this.state.goalComplete) return;

    this.state.goalProgress += amount;

    const milestones = [0.25, 0.5, 0.75];
    const pct = this.state.goalProgress / parseInt(this.settings.goal_tokens, 10);
    const prevPct =
      (this.state.goalProgress - amount) /
      parseInt(this.settings.goal_tokens, 10);

    for (let i = 0; i < milestones.length; i++) {
      if (prevPct < milestones[i] && pct >= milestones[i]) {
        const msg =
          `🎯 SESSION GOAL ${Math.round(milestones[i] * 100)}%!\n` +
          this.progressBar(
            this.state.goalProgress,
            this.settings.goal_tokens,
            16
          );

        this.emit('notice', {
          msg,
          user: '',
          bg: '#1a2a00',
          fg: '#b8ff6a',
          weight: 'bold',
        });
        this.emit('goalReached', {
          milestone: Math.round(milestones[i] * 100),
          progress: this.state.goalProgress,
        });
      }
    }

    if (
      this.state.goalProgress >=
      parseInt(this.settings.goal_tokens, 10)
    ) {
      this.state.goalComplete = true;

      const msg =
        '🎉🎉 SESSION GOAL REACHED! 🎉🎉\n' +
        `${this.settings.goal_desc}\n` +
        `Thanks to ${user} for the final push!`;

      this.emit('notice', {
        msg,
        user: '',
        bg: '#2a1a00',
        fg: '#ffd700',
        weight: 'bold',
      });

      this.emit('vibrate', {
        app: 'apexsensations',
        event: 'goalReached',
        pattern: 'fireworks',
        vibe: 20,
        secs: 60,
      });

      this.emit('goalReached', {
        milestone: 100,
        progress: this.state.goalProgress,
        complete: true,
      });
    }
  }

  /**
   * Update leaderboard with new tip.
   */
  updateLeaderboard(user, amount) {
    let found = false;
    for (let i = 0; i < this.state.leaderboard.length; i++) {
      if (this.state.leaderboard[i].user === user) {
        this.state.leaderboard[i].total += amount;
        found = true;
        break;
      }
    }
    if (!found) {
      this.state.leaderboard.push({ user, total: amount });
    }
    this.state.leaderboard.sort((a, b) => b.total - a.total);
    if (this.state.leaderboard.length > 10) {
      this.state.leaderboard = this.state.leaderboard.slice(0, 10);
    }

    this.emit('leaderboardUpdate', { leaderboard: this.state.leaderboard });
  }

  /**
   * Get top N tippers.
   */
  getLeaderboard(count = 5) {
    return this.state.leaderboard.slice(0, count);
  }

  /**
   * Show leaderboard (emit event).
   */
  showLeaderboard() {
    if (
      this.settings.show_leaderboard !== 'yes' ||
      this.state.leaderboard.length === 0
    )
      return;

    const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣'];
    const lines = [`╔═ ${this.settings.toy_emoji} TOP TIPPERS ════════════╗`];
    const top = this.state.leaderboard.slice(0, 5);
    for (let i = 0; i < top.length; i++) {
      lines.push(
        `║ ${medals[i]} ${top[i].user} — ${top[i].total} tkns`
      );
    }
    lines.push('╚════════════════════════════════╝');

    this.emit('notice', {
      msg: lines.join('\n'),
      user: '',
      bg: '#0a1a2e',
      fg: '#72c4f0',
      weight: 'bold',
    });
  }

  // ─────────────────────────────────────────────
  //  HELPER METHODS
  // ─────────────────────────────────────────────

  ordinal(n) {
    const str = String(n);
    const last = str.charAt(str.length - 1);
    const mod100 = n % 100;
    if (last === '1' && mod100 !== 11) return n + 'st';
    if (last === '2' && mod100 !== 12) return n + 'nd';
    if (last === '3' && mod100 !== 13) return n + 'rd';
    return n + 'th';
  }

  arRemaining() {
    const r =
      parseInt(this.settings.ar_tokens, 10) - this.state.arProgress;
    return r < 0 ? 0 : r;
  }

  progressBar(current, total, bars = 20) {
    const filled = Math.round(
      Math.min(current / total, 1) * bars
    );
    let bar = '';
    for (let i = 0; i < bars; i++) {
      bar += i < filled ? '█' : '░';
    }
    return `[${bar}] ${current}/${total}`;
  }

  minutesAgo(date) {
    return Math.floor(
      ((new Date()).getTime() - date.getTime()) / 60000
    );
  }

  // ─────────────────────────────────────────────
  //  PUBLIC API FOR DESKTOP INTEGRATION
  // ─────────────────────────────────────────────

  /**
   * Get current state snapshot.
   */
  getState() {
    return {
      tipQueue: this.state.tipQueue.slice(),
      processing: this.state.processing,
      sessionTokens: this.state.sessionTokens,
      leaderboard: this.state.leaderboard.slice(),
      arProgress: this.state.arProgress,
      arCount: this.state.arCount,
      arLastTime: this.state.arLastTime,
      arFinale: this.state.arFinale,
      goalProgress: this.state.goalProgress,
      goalComplete: this.state.goalComplete,
      connected: this.state.connected,
    };
  }

  /**
   * Get current settings.
   */
  getSettings() {
    return { ...this.settings };
  }

  /**
   * Get configured tiers array.
   */
  getTiers() {
    return this.state.tiers.slice();
  }

  /**
   * Get queue status.
   */
  getQueueStatus() {
    const current = this.state.tipQueue.length > 0 ? this.state.tipQueue[0] : null;
    return {
      length: this.state.tipQueue.length,
      processing: this.state.processing,
      current,
    };
  }

  /**
   * Adjust a tier's field (min, max, vibe, secs, label) with cascade.
   */
  adjustTier(tierNum, field, value) {
    if (field === 'min' || field === 'max') {
      if (!this.state.tierOverrides[tierNum]) {
        const range = this.getEffectiveRange(tierNum);
        this.state.tierOverrides[tierNum] = {
          min: range.min,
          max: range.max,
        };
      }
      this.state.tierOverrides[tierNum][field] = parseInt(value, 10);
      const cascadeNotes = this.cascadeOverlaps(tierNum);
      this.buildTiers();
      this.emit('tierChange', {
        tier: tierNum,
        field,
        value,
        cascadeNotes,
      });
    } else {
      // Direct setting field (vibe, secs, label)
      const settingKey = `tier${tierNum}_${field}`;
      if (this.settings.hasOwnProperty(settingKey)) {
        this.settings[settingKey] = value;
        this.buildTiers();
        this.emit('tierChange', {
          tier: tierNum,
          field,
          value,
        });
      }
    }
  }

  /**
   * Reset session state.
   */
  resetSession() {
    this.state.sessionTokens = 0;
    this.state.leaderboard = [];
    this.state.arProgress = 0;
    this.state.arCount = 0;
    this.state.arLastTime = null;
    this.state.arFinale = false;
    this.state.goalProgress = 0;
    this.state.goalComplete = false;
    this.state.tipQueue = [];
    this.state.processing = false;
    this.state.comboTracker = {};
    this.emit('notice', {
      msg: '🔄 Session state reset.',
      user: '',
      bg: '#1a0a1a',
      fg: '#fff',
      weight: 'normal',
    });
  }

  /**
   * Update toy connection state.
   */
  setToyConnected(connected) {
    this.state.connected = connected;
    this.emit('connectionChange', { connected });
  }
}

module.exports = SensationsService;
