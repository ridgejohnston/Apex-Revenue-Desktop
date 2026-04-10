/**
 * Apex Revenue Intelligence Service
 * Manages live session data, earnings tracking, and analytics
 * Runs in Electron main process
 */

const Store = require('electron-store');
const { EventEmitter } = require('events');

const API_ENDPOINT = 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod';

class IntelligenceService extends EventEmitter {
  constructor(authService) {
    super();
    this.authService = authService;
    this.store = new Store({
      name: 'apex-intelligence',
      encryptionKey: 'apex-revenue-intel'
    });

    // Live session data
    this.liveData = {
      sessionId: null,
      earningsPerHour: 0,
      totalEarnings: 0,
      viewers: 0,
      conversionRate: 0,
      whales: [],
      prompts: [],
      heatMap: [],
      priceRecommendation: 0,
      lastUpdate: null
    };

    // Fan data
    this.fanLeaderboard = [];
    this.fanMetrics = {};

    // Session tracking
    this.activeSessions = [];
    this.sessionStartTime = null;
    this.updateInterval = null;
  }

  // ──────────────────────────────────────────────
  // SESSION MANAGEMENT
  // ──────────────────────────────────────────────

  startSession() {
    this.sessionStartTime = Date.now();
    this.liveData.sessionId = this.generateSessionId();
    this.liveData.totalEarnings = 0;
    this.liveData.earningsPerHour = 0;
    this.emit('sessionStarted', this.liveData);
    this.startPeriodicUpdates();
  }

  endSession() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
    }
    const sessionDuration = Date.now() - this.sessionStartTime;
    this.activeSessions.push({
      id: this.liveData.sessionId,
      duration: sessionDuration,
      earnings: this.liveData.totalEarnings,
      maxViewers: Math.max(...this.fanMetrics.viewers || [0])
    });
    this.persistSession();
    this.emit('sessionEnded', this.liveData);
    this.sessionStartTime = null;
  }

  // ──────────────────────────────────────────────
  // LIVE DATA UPDATES
  // ──────────────────────────────────────────────

  async fetchLiveData(accessToken) {
    if (!accessToken) {
      console.error('No access token for live data fetch');
      return;
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/intelligence/live`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch live data:', response.status);
        return;
      }

      const data = await response.json();

      // Update live data
      this.liveData = {
        ...this.liveData,
        ...data,
        lastUpdate: Date.now()
      };

      this.emit('liveUpdate', this.liveData);
    } catch (error) {
      console.error('Live data fetch error:', error);
    }
  }

  // ──────────────────────────────────────────────
  // FAN LEADERBOARD
  // ──────────────────────────────────────────────

  async fetchFanLeaderboard(accessToken) {
    if (!accessToken) return;

    try {
      const response = await fetch(`${API_ENDPOINT}/intelligence/fans`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('Failed to fetch fan leaderboard:', response.status);
        return;
      }

      const data = await response.json();
      this.fanLeaderboard = data.fans || [];
      this.emit('fanUpdate', this.fanLeaderboard);
    } catch (error) {
      console.error('Fan leaderboard fetch error:', error);
    }
  }

  // ──────────────────────────────────────────────
  // EARNINGS TRACKING
  // ──────────────────────────────────────────────

  recordTip(amount, username, platform) {
    const tip = {
      id: this.generateId(),
      amount,
      username,
      platform,
      timestamp: Date.now(),
      sessionId: this.liveData.sessionId
    };

    // Update live earnings
    this.liveData.totalEarnings += amount;
    if (this.sessionStartTime) {
      const elapsedHours = (Date.now() - this.sessionStartTime) / (1000 * 60 * 60);
      this.liveData.earningsPerHour = this.liveData.totalEarnings / elapsedHours;
    }

    // Update fan metrics
    this.updateFanMetrics(username, amount);

    this.emit('tipReceived', tip);
    this.persistEarnings(tip);

    return tip;
  }

  updateFanMetrics(username, amount) {
    if (!this.fanMetrics[username]) {
      this.fanMetrics[username] = {
        totalSpent: 0,
        tipCount: 0,
        lastTip: null
      };
    }

    this.fanMetrics[username].totalSpent += amount;
    this.fanMetrics[username].tipCount += 1;
    this.fanMetrics[username].lastTip = Date.now();
  }

  // ──────────────────────────────────────────────
  // ANALYTICS
  // ──────────────────────────────────────────────

  async getAnalytics(accessToken, timeRange = '7d') {
    if (!accessToken) return null;

    try {
      const response = await fetch(
        `${API_ENDPOINT}/intelligence/analytics?timeRange=${timeRange}`,
        {
          headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (!response.ok) {
        console.error('Failed to fetch analytics:', response.status);
        return null;
      }

      return await response.json();
    } catch (error) {
      console.error('Analytics fetch error:', error);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // SUBSCRIPTION VERIFICATION
  // ──────────────────────────────────────────────

  async checkSubscription(accessToken) {
    if (!accessToken) return null;

    try {
      const response = await fetch(`${API_ENDPOINT}/check-subscription`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        console.error('Failed to check subscription:', response.status);
        return null;
      }

      const data = await response.json();
      return {
        isActive: data.active,
        tier: data.tier,
        expiresAt: data.expiresAt,
        features: data.features || []
      };
    } catch (error) {
      console.error('Subscription check error:', error);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // PERIODIC UPDATES
  // ──────────────────────────────────────────────

  startPeriodicUpdates() {
    // Update live data every 5 seconds
    this.updateInterval = setInterval(async () => {
      const token = this.authService.getAccessToken();
      if (token && !this.authService.isTokenExpired()) {
        await this.fetchLiveData(token);
        await this.fetchFanLeaderboard(token);
      }
    }, 5000);
  }

  stopPeriodicUpdates() {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
  }

  // ──────────────────────────────────────────────
  // DATA PERSISTENCE
  // ──────────────────────────────────────────────

  persistSession() {
    const sessions = this.store.get('sessions', []);
    sessions.push(this.activeSessions[this.activeSessions.length - 1]);
    this.store.set('sessions', sessions);
  }

  persistEarnings(tip) {
    const earnings = this.store.get('earnings', []);
    earnings.push(tip);
    this.store.set('earnings', earnings);
  }

  // ──────────────────────────────────────────────
  // DATA EXPORT & BACKUP
  // ──────────────────────────────────────────────

  exportData() {
    return {
      sessions: this.store.get('sessions', []),
      earnings: this.store.get('earnings', []),
      liveData: this.liveData,
      fanMetrics: this.fanMetrics,
      exportedAt: new Date().toISOString()
    };
  }

  importData(data) {
    if (data.sessions) {
      this.store.set('sessions', data.sessions);
    }
    if (data.earnings) {
      this.store.set('earnings', data.earnings);
    }
    if (data.fanMetrics) {
      this.fanMetrics = data.fanMetrics;
    }
  }

  // ──────────────────────────────────────────────
  // POSTOG EVENT TRACKING
  // ──────────────────────────────────────────────

  captureEvent(eventName, properties = {}) {
    const user = this.authService.getUser();
    if (!user) return;

    // PostHog event capture would go here
    // For now, just log to console
    console.log(`[Analytics] ${eventName}:`, properties);

    this.emit('analyticsEvent', {
      event: eventName,
      properties,
      userId: user.id,
      timestamp: Date.now()
    });
  }

  // ──────────────────────────────────────────────
  // UTILITY METHODS
  // ──────────────────────────────────────────────

  generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  generateId() {
    return `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // ──────────────────────────────────────────────
  // GETTERS
  // ──────────────────────────────────────────────

  getLiveData() {
    return this.liveData;
  }

  getFanLeaderboard() {
    return this.fanLeaderboard;
  }

  getEarnings() {
    return this.store.get('earnings', []);
  }

  getSessions() {
    return this.store.get('sessions', []);
  }

  getTotalEarnings() {
    const earnings = this.getEarnings();
    return earnings.reduce((sum, tip) => sum + tip.amount, 0);
  }

  getSessionStats() {
    const sessions = this.getSessions();
    if (sessions.length === 0) {
      return {
        totalSessions: 0,
        totalEarnings: 0,
        averageEarningsPerSession: 0,
        totalViewers: 0
      };
    }

    const totalEarnings = sessions.reduce((sum, s) => sum + s.earnings, 0);
    const totalViewers = sessions.reduce((sum, s) => sum + s.maxViewers, 0);

    return {
      totalSessions: sessions.length,
      totalEarnings,
      averageEarningsPerSession: totalEarnings / sessions.length,
      totalViewers,
      averageSessionDuration: sessions.reduce((sum, s) => sum + s.duration, 0) / sessions.length
    };
  }
}

module.exports = IntelligenceService;
