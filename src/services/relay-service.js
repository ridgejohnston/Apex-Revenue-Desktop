/**
 * Apex Revenue Relay Service
 * WebSocket relay client for real-time fan control and session management
 * Runs in Electron main process
 */

const WebSocket = require('ws');
const { EventEmitter } = require('events');

const RELAY_URL = 'wss://mr5rjohfed.execute-api.us-east-1.amazonaws.com/production';

class RelayService extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.isConnected = false;
    this.messageQueue = [];
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
    this.reconnectDelay = 5000;
    this.messageHandlers = {};
  }

  // ──────────────────────────────────────────────
  // CONNECTION MANAGEMENT
  // ──────────────────────────────────────────────

  connect(accessToken, username, platform = 'chaturbate') {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(RELAY_URL, {
          headers: {
            'Authorization': `Bearer ${accessToken}`
          }
        });

        this.ws.onopen = () => {
          console.log('[Relay] Connected to relay server');
          this.isConnected = true;
          this.reconnectAttempts = 0;
          this.emit('connected');

          // Register as model
          this.registerModel(username, platform);

          // Process any queued messages
          while (this.messageQueue.length > 0) {
            const msg = this.messageQueue.shift();
            this.send(msg);
          }

          resolve({ success: true });
        };

        this.ws.onmessage = (event) => {
          this.handleMessage(event.data);
        };

        this.ws.onerror = (error) => {
          console.error('[Relay] WebSocket error:', error);
          this.emit('error', error);
          reject(error);
        };

        this.ws.onclose = () => {
          console.log('[Relay] Disconnected from relay server');
          this.isConnected = false;
          this.emit('disconnected');
          this.attemptReconnect(accessToken, username, platform);
        };
      } catch (error) {
        console.error('[Relay] Connection error:', error);
        reject(error);
      }
    });
  }

  disconnect() {
    if (this.ws) {
      this.isConnected = false;
      this.ws.close();
      this.ws = null;
    }
    this.emit('disconnected');
  }

  attemptReconnect(accessToken, username, platform) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[Relay] Max reconnection attempts reached');
      this.emit('reconnectFailed');
      return;
    }

    this.reconnectAttempts++;
    console.log(
      `[Relay] Attempting reconnection (${this.reconnectAttempts}/${this.maxReconnectAttempts}) in ${this.reconnectDelay}ms`
    );

    setTimeout(() => {
      this.connect(accessToken, username, platform).catch((error) => {
        console.error('[Relay] Reconnection attempt failed:', error);
      });
    }, this.reconnectDelay);
  }

  // ──────────────────────────────────────────────
  // MESSAGE HANDLING
  // ──────────────────────────────────────────────

  send(message) {
    if (!this.isConnected || !this.ws) {
      console.warn('[Relay] Not connected, queueing message:', message);
      this.messageQueue.push(message);
      return;
    }

    try {
      const data = typeof message === 'string' ? message : JSON.stringify(message);
      this.ws.send(data);
    } catch (error) {
      console.error('[Relay] Send error:', error);
      this.emit('error', error);
    }
  }

  handleMessage(data) {
    try {
      const message = typeof data === 'string' ? JSON.parse(data) : data;

      console.log('[Relay] Received:', message.type || message);

      // Route to specific handlers
      if (message.type === 'fan_control') {
        this.handleFanControl(message);
      } else if (message.type === 'session_update') {
        this.handleSessionUpdate(message);
      } else if (message.type === 'balance_update') {
        this.handleBalanceUpdate(message);
      } else if (message.type === 'broadcast') {
        this.handleBroadcast(message);
      }

      // Emit generic relay event
      this.emit('relayEvent', message);

      // Call registered handler if exists
      if (message.type && this.messageHandlers[message.type]) {
        this.messageHandlers[message.type](message);
      }
    } catch (error) {
      console.error('[Relay] Message parsing error:', error);
    }
  }

  // ──────────────────────────────────────────────
  // MODEL REGISTRATION
  // ──────────────────────────────────────────────

  registerModel(username, platform) {
    const registration = {
      type: 'register',
      username,
      platform,
      role: 'model',
      timestamp: Date.now()
    };

    this.send(registration);
    this.emit('registered', { username, platform });
  }

  unregisterModel(username) {
    const registration = {
      type: 'unregister',
      username,
      timestamp: Date.now()
    };

    this.send(registration);
  }

  // ──────────────────────────────────────────────
  // FAN CONTROL HANDLING
  // ──────────────────────────────────────────────

  handleFanControl(message) {
    const { fan, action, data } = message;

    console.log(`[Relay] Fan control: ${fan} - ${action}`);

    // Vibe commands
    if (action === 'vibe') {
      this.emit('vibeCommand', {
        fan,
        level: data.level,
        duration: data.duration
      });
    }

    // Other control actions
    this.emit('fanControl', message);
  }

  // ──────────────────────────────────────────────
  // SESSION MANAGEMENT
  // ──────────────────────────────────────────────

  startSession(roomName, settings = {}) {
    const sessionStart = {
      type: 'session_start',
      roomName,
      settings,
      timestamp: Date.now()
    };

    this.send(sessionStart);
    this.emit('sessionStarted', { roomName, settings });
  }

  endSession(roomName) {
    const sessionEnd = {
      type: 'session_end',
      roomName,
      timestamp: Date.now()
    };

    this.send(sessionEnd);
    this.emit('sessionEnded', { roomName });
  }

  extendSession(roomName, duration) {
    const sessionExtend = {
      type: 'session_extend',
      roomName,
      duration,
      timestamp: Date.now()
    };

    this.send(sessionExtend);
  }

  handleSessionUpdate(message) {
    const { sessionId, status, duration, viewers } = message;

    console.log(`[Relay] Session update: ${status}`);

    this.emit('sessionUpdate', {
      sessionId,
      status,
      duration,
      viewers
    });
  }

  // ──────────────────────────────────────────────
  // BALANCE & EARNINGS
  // ──────────────────────────────────────────────

  handleBalanceUpdate(message) {
    const { balance, earned, tips } = message;

    console.log(`[Relay] Balance update: $${balance}`);

    this.emit('balanceUpdate', {
      balance,
      earned,
      tips
    });
  }

  // ──────────────────────────────────────────────
  // BROADCAST MESSAGES
  // ──────────────────────────────────────────────

  broadcastPSCmd(command, data = {}) {
    const broadcast = {
      type: 'ps_cmd',
      command,
      data,
      timestamp: Date.now()
    };

    this.send(broadcast);
  }

  broadcastMessage(message, target = 'all') {
    const broadcast = {
      type: 'broadcast',
      message,
      target,
      timestamp: Date.now()
    };

    this.send(broadcast);
  }

  handleBroadcast(message) {
    const { message: content, sender, target } = message;

    console.log(`[Relay] Broadcast from ${sender}: ${content}`);

    this.emit('broadcast', {
      message: content,
      sender,
      target
    });
  }

  // ──────────────────────────────────────────────
  // MESSAGE HANDLER REGISTRATION
  // ──────────────────────────────────────────────

  onMessageType(type, handler) {
    this.messageHandlers[type] = handler;
  }

  removeMessageHandler(type) {
    delete this.messageHandlers[type];
  }

  // ──────────────────────────────────────────────
  // STATUS
  // ──────────────────────────────────────────────

  getStatus() {
    return {
      connected: this.isConnected,
      reconnectAttempts: this.reconnectAttempts,
      messageQueueLength: this.messageQueue.length
    };
  }

  // ──────────────────────────────────────────────
  // HEALTH CHECK
  // ──────────────────────────────────────────────

  sendHeartbeat() {
    if (!this.isConnected) return;

    this.send({
      type: 'heartbeat',
      timestamp: Date.now()
    });
  }

  startHeartbeat(interval = 30000) {
    setInterval(() => {
      this.sendHeartbeat();
    }, interval);
  }
}

module.exports = RelayService;
