/**
 * Apex Revenue Auth Service
 * AWS Cognito authentication for Electron main process
 */

const Store = require('electron-store');

// Built-in JWT decoder (no external dependency needed)
function jwt_decode(token) {
  try {
    const payload = token.split('.')[1];
    const decoded = Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    return JSON.parse(decoded);
  } catch (e) {
    return {};
  }
}

// AWS Cognito Configuration
const COGNITO_CONFIG = {
  clientId: '2q57i2f3sl6lcl8rlu7tt3dgdf',
  region: 'us-east-1',
  endpoint: 'https://cognito-idp.us-east-1.amazonaws.com',
  issuer: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EjYUEgmKm',
  userPoolId: 'us-east-1_EjYUEgmKm'
};

const API_ENDPOINT = 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod';

class AuthService {
  constructor() {
    this.store = new Store({
      name: 'apex-auth',
      encryptionKey: 'apex-revenue-secret'
    });
    this.tokens = this.store.get('tokens') || {};
    this.user = this.store.get('user') || null;
    this.listeners = [];
  }

  // ──────────────────────────────────────────────
  // SIGN UP
  // ──────────────────────────────────────────────

  async signup(email, password) {
    try {
      const response = await fetch(`${API_ENDPOINT}/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Signup failed');
      }

      // Store tokens
      this.tokens = {
        accessToken: data.accessToken,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn
      };
      this.store.set('tokens', this.tokens);

      // Parse and store user info
      this.user = this.parseTokenUser(data.idToken);
      this.store.set('user', this.user);

      this.notifyListeners(this.user);

      return {
        success: true,
        user: this.user,
        tokens: this.tokens
      };
    } catch (error) {
      console.error('Signup error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ──────────────────────────────────────────────
  // SIGN IN
  // ──────────────────────────────────────────────

  async login(email, password) {
    try {
      const response = await fetch(`${API_ENDPOINT}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Login failed');
      }

      // Store tokens
      this.tokens = {
        accessToken: data.accessToken,
        idToken: data.idToken,
        refreshToken: data.refreshToken,
        expiresIn: data.expiresIn
      };
      this.store.set('tokens', this.tokens);

      // Parse and store user info
      this.user = this.parseTokenUser(data.idToken);
      this.store.set('user', this.user);

      this.notifyListeners(this.user);

      return {
        success: true,
        user: this.user,
        tokens: this.tokens
      };
    } catch (error) {
      console.error('Login error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ──────────────────────────────────────────────
  // SIGN OUT
  // ──────────────────────────────────────────────

  async logout() {
    try {
      // Optionally call backend to invalidate tokens
      if (this.tokens.accessToken) {
        await fetch(`${API_ENDPOINT}/auth/logout`, {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${this.tokens.accessToken}`,
            'Content-Type': 'application/json'
          }
        }).catch(() => {}); // Ignore errors
      }

      // Clear local storage
      this.tokens = {};
      this.user = null;
      this.store.delete('tokens');
      this.store.delete('user');

      this.notifyListeners(null);

      return { success: true };
    } catch (error) {
      console.error('Logout error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ──────────────────────────────────────────────
  // TOKEN REFRESH
  // ──────────────────────────────────────────────

  async refreshTokens() {
    if (!this.tokens.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: this.tokens.refreshToken })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Token refresh failed');
      }

      this.tokens.accessToken = data.accessToken;
      this.tokens.idToken = data.idToken;
      this.store.set('tokens', this.tokens);

      return { success: true, tokens: this.tokens };
    } catch (error) {
      console.error('Token refresh error:', error);
      // Clear tokens on refresh failure
      this.tokens = {};
      this.user = null;
      this.store.delete('tokens');
      this.store.delete('user');
      this.notifyListeners(null);
      return { success: false, error: error.message };
    }
  }

  // ──────────────────────────────────────────────
  // GET SESSION
  // ──────────────────────────────────────────────

  getSession() {
    return {
      user: this.user,
      tokens: this.tokens,
      isAuthenticated: !!this.user && !!this.tokens.accessToken
    };
  }

  // ──────────────────────────────────────────────
  // GET USER
  // ──────────────────────────────────────────────

  getUser() {
    return this.user;
  }

  // ──────────────────────────────────────────────
  // LINK PLATFORM ACCOUNT
  // ──────────────────────────────────────────────

  async linkPlatform(platform, username) {
    if (!this.tokens.accessToken) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/auth/link-platform`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tokens.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ platform, username })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to link platform');
      }

      // Update user with linked platforms
      if (this.user) {
        this.user.linkedPlatforms = data.linkedPlatforms || [];
        this.store.set('user', this.user);
      }

      this.notifyListeners(this.user);

      return {
        success: true,
        platforms: data.linkedPlatforms || []
      };
    } catch (error) {
      console.error('Platform link error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ──────────────────────────────────────────────
  // UNLINK PLATFORM ACCOUNT
  // ──────────────────────────────────────────────

  async unlinkPlatform(platform) {
    if (!this.tokens.accessToken) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      const response = await fetch(`${API_ENDPOINT}/auth/unlink-platform`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.tokens.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ platform })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || 'Failed to unlink platform');
      }

      // Update user
      if (this.user) {
        this.user.linkedPlatforms = data.linkedPlatforms || [];
        this.store.set('user', this.user);
      }

      this.notifyListeners(this.user);

      return {
        success: true,
        platforms: data.linkedPlatforms || []
      };
    } catch (error) {
      console.error('Platform unlink error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  // ──────────────────────────────────────────────
  // ADMIN CHECK
  // ──────────────────────────────────────────────

  isAdmin() {
    if (!this.user) return false;
    return this.user.groups?.includes('admin') || false;
  }

  // ──────────────────────────────────────────────
  // TOKEN PARSING
  // ──────────────────────────────────────────────

  parseTokenUser(idToken) {
    try {
      const decoded = jwt_decode(idToken);
      return {
        id: decoded.sub,
        email: decoded.email,
        username: decoded['cognito:username'],
        emailVerified: decoded.email_verified,
        groups: decoded['cognito:groups'] || [],
        linkedPlatforms: decoded.linked_platforms || [],
        attributes: {
          givenName: decoded.given_name,
          familyName: decoded.family_name,
          picture: decoded.picture
        }
      };
    } catch (error) {
      console.error('Error parsing token:', error);
      return null;
    }
  }

  // ──────────────────────────────────────────────
  // EVENT LISTENERS
  // ──────────────────────────────────────────────

  onAuthChange(listener) {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  notifyListeners(user) {
    this.listeners.forEach(listener => {
      try {
        listener(user);
      } catch (error) {
        console.error('Error in auth listener:', error);
      }
    });
  }

  // ──────────────────────────────────────────────
  // TOKEN MANAGEMENT
  // ──────────────────────────────────────────────

  getAccessToken() {
    return this.tokens.accessToken;
  }

  getIdToken() {
    return this.tokens.idToken;
  }

  isTokenExpired() {
    if (!this.tokens.accessToken) return true;

    try {
      const decoded = jwt_decode(this.tokens.accessToken);
      const expiresAt = decoded.exp * 1000;
      return Date.now() >= expiresAt;
    } catch (error) {
      return true;
    }
  }

  async ensureValidToken() {
    if (this.isTokenExpired()) {
      return await this.refreshTokens();
    }
    return { success: true, tokens: this.tokens };
  }
}

module.exports = AuthService;
