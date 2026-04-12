/**
 * Apex Revenue — Session Earnings Tracker
 */

class EarningsTracker {
  constructor() {
    this.reset();
  }

  reset() {
    this.platform = null;
    this.startTime = null;
    this.totalTokens = 0;
    this.tipEvents = [];
    this.uniqueTippers = new Set();
    this.peakViewers = 0;
    this.viewerSamples = [];
    this.hourlyBreakdown = {};
    this.largestTip = 0;
    this.whales = new Map();
  }

  start(platform) {
    this.reset();
    this.platform = platform;
    this.startTime = Date.now();
  }

  addTip(username, amount, timestamp = Date.now()) {
    this.totalTokens += amount;
    this.uniqueTippers.add(username);
    this.tipEvents.push({ username, amount, timestamp });
    if (amount > this.largestTip) this.largestTip = amount;

    const existing = this.whales.get(username) || 0;
    this.whales.set(username, existing + amount);

    const hour = new Date(timestamp).getHours();
    this.hourlyBreakdown[hour] = (this.hourlyBreakdown[hour] || 0) + amount;
  }

  updateViewers(count) {
    if (count > this.peakViewers) this.peakViewers = count;
    this.viewerSamples.push(count);
  }

  getTokensPerHour() {
    if (!this.startTime) return 0;
    const hours = (Date.now() - this.startTime) / 3600000;
    return hours > 0 ? Math.round(this.totalTokens / hours) : 0;
  }

  getAverageViewers() {
    if (!this.viewerSamples.length) return 0;
    return Math.round(this.viewerSamples.reduce((a, b) => a + b, 0) / this.viewerSamples.length);
  }

  getAverageTip() {
    if (!this.tipEvents.length) return 0;
    return Math.round(this.totalTokens / this.tipEvents.length);
  }

  getConversionRate(currentViewers) {
    if (!currentViewers) return 0;
    return Math.round((this.uniqueTippers.size / currentViewers) * 100 * 10) / 10;
  }

  getTopWhales(limit = 10) {
    return [...this.whales.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([username, total]) => ({ username, total }));
  }

  getSnapshot(currentViewers = 0) {
    return {
      platform: this.platform,
      startTime: this.startTime,
      elapsed: this.startTime ? Date.now() - this.startTime : 0,
      totalTokens: this.totalTokens,
      tokensPerHour: this.getTokensPerHour(),
      viewers: currentViewers,
      peakViewers: this.peakViewers,
      averageViewers: this.getAverageViewers(),
      uniqueTippers: this.uniqueTippers.size,
      averageTip: this.getAverageTip(),
      largestTip: this.largestTip,
      conversionRate: this.getConversionRate(currentViewers),
      whales: this.getTopWhales(),
      recentTips: this.tipEvents.slice(-20).reverse(),
      hourlyBreakdown: { ...this.hourlyBreakdown },
    };
  }
}

module.exports = EarningsTracker;
