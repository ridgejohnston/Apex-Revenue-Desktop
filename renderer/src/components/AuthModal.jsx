import React, { useState } from 'react';

export default function AuthModal({ onSignIn, onClose }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!email || !password) return setError('Please fill in all fields');

    setLoading(true);
    setError('');
    const result = await onSignIn(email, password);
    setLoading(false);

    if (!result.success) {
      setError(result.error || 'Sign in failed');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 340 }}>
        <div className="modal-title" style={{ textAlign: 'center' }}>
          ⚡ Sign in to Apex Revenue
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div style={{
              padding: 6, marginBottom: 8, background: 'var(--live-red-dim)',
              color: 'var(--live-red)', borderRadius: 4, fontSize: 11, textAlign: 'center',
            }}>
              {error}
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Email</label>
            <input
              className="input"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              style={{ width: '100%' }}
              autoFocus
            />
          </div>

          <div style={{ marginBottom: 12 }}>
            <label style={{ fontSize: 10, color: 'var(--text-dim)', display: 'block', marginBottom: 2 }}>Password</label>
            <input
              className="input"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              style={{ width: '100%' }}
            />
          </div>

          <button
            type="submit"
            className="btn btn-accent"
            style={{ width: '100%', padding: '8px 12px' }}
            disabled={loading}
          >
            {loading ? 'Signing in...' : 'Sign In'}
          </button>
        </form>

        <div style={{ marginTop: 12, textAlign: 'center', fontSize: 10, color: 'var(--text-dim)' }}>
          <a href="https://apexrevenue.works" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Create account
          </a>
          {' · '}
          <a href="https://apexrevenue.works/forgot" target="_blank" rel="noreferrer"
            style={{ color: 'var(--accent)', textDecoration: 'none' }}>
            Forgot password
          </a>
        </div>
      </div>
    </div>
  );
}
