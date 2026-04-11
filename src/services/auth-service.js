/**
 * Apex Revenue Auth Service
 * AWS Cognito authentication for Electron main process
 *
 * Talks directly to Cognito's API (cognito-idp) using the
 * X-Amz-Target header — same approach as the Edge extension.
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
  userPoolId: 'us-east-1_EjYUEgmKm'
};

const API_ENDPOINT = 'https://7g6qsxoos3.execute-api.us-east-1.amazonaws.com/prod';

// Fetch with timeout wrapper
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your internet connection.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Low-level Cognito request (matches Edge extension pattern) ──
async function cognitoRequest(action, payload) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000); // 15s timeout

  try {
    console.log(`[Cognito] ${action} request starting...`);
    const res = await fetch(COGNITO_CONFIG.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`
      },
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    const data = await res.json();
    console.log(`[Cognito] ${action} response: ${res.status}`);

    if (!res.ok) {
      const msg = data.message || data.__type || `Cognito error (${res.status})`;
      throw new Error(msg);
    }

    return data;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your internet connection.');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

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
  // SIGN UP (direct Cognito)
  // ──────────────────────────────────────────────

  async signup(email, password) {
    try {
      const data = await cognitoRequest('SignUp', {
        ClientId: COGNITO_CONFIG.clientId,
        Username: email.toLowerCase().trim(),
        Password: password,
        UserAttributes: [
          { Name: 'email', Value: email.toLowerCase().trim() }
        ]
      });

      return {
        success: true,
        userId: data.UserSub,
        confirmed: data.UserConfirmed,
        needsVerification: !data.UserConfirmed
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
  // CONFIRM SIGN UP (verification code)
  // ──────────────────────────────────────────────

  async confirmSignup(email, code) {
    try {
      await cognitoRequest('ConfirmSignUp', {
        ClientId: COGNITO_CONFIG.clientId,
        Username: email.toLowerCase().trim(),
        ConfirmationCode: code.trim()
      });
      return { success: true };
    } catch (error) {
      console.error('Confirm signup error:', error);
      return { success: false, error: error.message };
    }
  }

  // ──────────────────────────────────────────────
  // SIGN IN (direct Cognito InitiateAuth)
  // ──────────────────────────────────────────────

  async login(email, password) {
    console.log('[AuthService] login() called for:', email);
    try {
      const data = await cognitoRequest('InitiateAuth', {
        ClientId: COGNITO_CONFIG.clientId,
        AuthFlow: 'USER_PASSWORD_AUTH',
        AuthParameters: {
          USERNAME: email.toLowerCase().trim(),
          PASSWORD: password
        }
      });

      const result = data.AuthenticationResult;
      if (!result || !result.IdToken) {
        throw new Error('Sign in failed — unexpected response.');
      }

      // Store tokens
      this.tokens = {
        accessToken: result.IdToken,       // IdToken is what API Gateway validates
        idToken: result.IdToken,
        refreshToken: result.RefreshToken,
        expiresIn: result.ExpiresIn
      };
      this.store.set('tokens', this.tokens);

      // Parse and store user info
      this.user = this.parseTokenUser(result.IdToken);
      this.store.set('user', this.user);

      // Fetch linked platform accounts from the server
      await this.getLinkedAccounts().catch(() => {});

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
      // Attempt Cognito global sign out
      if (this.tokens.accessToken) {
        await cognitoRequest('GlobalSignOut', {
          AccessToken: this.tokens.accessToken
        }).catch(() => {});
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
      // Still clear locally even if remote sign-out fails
      this.tokens = {};
      this.user = null;
      this.store.delete('tokens');
      this.store.delete('user');
      this.notifyListeners(null);
      return { success: false, error: error.message };
    }
  }

  // ──────────────────────────────────────────────
  // TOKEN REFRESH (direct Cognito)
  // ──────────────────────────────────────────────

  async refreshTokens() {
    if (!this.tokens.refreshToken) {
      throw new Error('No refresh token available');
    }

    try {
      const data = await cognitoRequest('InitiateAuth', {
        ClientId: COGNITO_CONFIG.clientId,
        AuthFlow: 'REFRESH_TOKEN_AUTH',
        AuthParameters: {
          REFRESH_TOKEN: this.tokens.refreshToken
        }
      });

      const result = data.AuthenticationResult;
      this.tokens.accessToken = result.IdToken;
      this.tokens.idToken = result.IdToken;
      // Cognito doesn't return a new refresh token on refresh
      this.store.set('tokens', this.tokens);

      // Update user from new token
      this.user = this.parseTokenUser(result.IdToken);
      this.store.set('user', this.user);

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
  // GET LINKED ACCOUNTS (via API Gateway)
  // ──────────────────────────────────────────────

  async getLinkedAccounts() {
    try {
      await this.ensureValidToken();

      const response = await fetchWithTimeout(`${API_ENDPOINT}/linked-accounts`, {
        method: 'POST',
        headers: {
          'Authorization': this.tokens.accessToken,
          'Content-Type': 'application/json'
        }
      });

      const data = await response.json();
      const accounts = Array.isArray(data.accounts) ? data.accounts : (Array.isArray(data) ? data : []);

      if (this.user) {
        this.user.linkedPlatforms = accounts;
        this.store.set('user', this.user);
      }

      return accounts;
    } catch (error) {
      console.warn('getLinkedAccounts error:', error.message);
      return this.user?.linkedPlatforms || [];
    }
  }

  // ──────────────────────────────────────────────
  // LINK PLATFORM ACCOUNT (via API Gateway)
  // ──────────────────────────────────────────────

  async linkPlatform(platform, username) {
    if (!this.tokens.accessToken) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      // Ensure token is still valid (Cognito IdTokens expire after 1 hour)
      await this.ensureValidToken();

      const response = await fetchWithTimeout(`${API_ENDPOINT}/link-platform`, {
        method: 'POST',
        headers: {
          'Authorization': this.tokens.accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ platform, username: username.toLowerCase().trim() })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Failed to link platform');
      }

      // Fetch the updated linked accounts list (matches Edge extension pattern)
      const accounts = await this.getLinkedAccounts();

      this.notifyListeners(this.user);

      return {
        success: true,
        platforms: accounts
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
  // UNLINK PLATFORM ACCOUNT (via API Gateway)
  // ──────────────────────────────────────────────

  async unlinkPlatform(platform) {
    if (!this.tokens.accessToken) {
      return { success: false, error: 'Not authenticated' };
    }

    try {
      // Ensure token is still valid (Cognito IdTokens expire after 1 hour)
      await this.ensureValidToken();

      const response = await fetchWithTimeout(`${API_ENDPOINT}/unlink-platform`, {
        method: 'POST',
        headers: {
          'Authorization': this.tokens.accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ platform })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || data.message || 'Failed to unlink platform');
      }

      // Fetch the updated linked accounts list (matches Edge extension pattern)
      const accounts = await this.getLinkedAccounts();

      this.notifyListeners(this.user);

      return {
        success: true,
        platforms: accounts
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
