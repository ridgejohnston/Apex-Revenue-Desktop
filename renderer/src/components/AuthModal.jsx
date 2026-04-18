import React, { useState } from 'react';

/**
 * Sign-in modal — kicks off the Cognito Hosted UI flow.
 *
 * The actual sign-in happens in the user's default browser; this modal
 * just triggers the redirect and waits for the custom-protocol callback
 * to come back into the app (handled in main.js).
 *
 * If the user closes the browser without completing sign-in, the main
 * process times out after 5 minutes. We surface that as a friendly retry.
 */
export default function AuthModal({ onAuthStarted, onClose }) {
  const [status, setStatus] = useState('idle'); // 'idle' | 'waiting' | 'error'
  const [error, setError] = useState('');

  const handleSignIn = async () => {
    setStatus('waiting');
    setError('');
    try {
      const result = await window.electronAPI.auth.hostedUiSignIn();
      if (result.success) {
        // Parent will pick up the new session via onAuthStarted → getSession
        onAuthStarted?.(result);
        onClose?.();
      } else {
        setStatus('error');
        setError(result.error || 'Sign in failed. Please try again.');
      }
    } catch (e) {
      setStatus('error');
      setError(e.message || 'Sign in failed. Please try again.');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ width: 380 }}>
        <div className="modal-title" style={{ textAlign: 'center' }}>
          ⚡ Sign in to Apex Revenue
        </div>

        <div style={{
          padding: '14px 4px',
          fontSize: 11,
          color: 'var(--text-secondary)',
          textAlign: 'center',
          lineHeight: 1.5,
        }}>
          {status === 'waiting' ? (
            <>
              Complete sign-in in your browser.<br/>
              <span style={{ fontSize: 10, color: 'var(--text-dim)' }}>
                Waiting for callback…
              </span>
            </>
          ) : (
            <>Secure sign-in via AWS Cognito.<br/>
            Your browser will open to the Apex Revenue sign-in page.</>
          )}
        </div>

        {error && (
          <div style={{
            padding: 8, marginBottom: 10,
            background: 'var(--live-red-dim)', color: 'var(--live-red)',
            borderRadius: 4, fontSize: 11, textAlign: 'center',
          }}>
            {error}
          </div>
        )}

        <button
          type="button"
          className="btn btn-accent"
          style={{ width: '100%', padding: '10px 12px', fontWeight: 600 }}
          onClick={handleSignIn}
          disabled={status === 'waiting'}
        >
          {status === 'waiting' ? (
            <>⏳ Waiting for browser…</>
          ) : status === 'error' ? (
            <>↻ Retry Sign In</>
          ) : (
            <>🔐 Sign In with Hosted UI</>
          )}
        </button>

        <div style={{ marginTop: 14, textAlign: 'center', fontSize: 10, color: 'var(--text-dim)' }}>
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

        {status === 'waiting' && (
          <div style={{ marginTop: 10, textAlign: 'center' }}>
            <button
              type="button"
              className="btn btn-sm"
              style={{ fontSize: 10 }}
              onClick={() => { setStatus('idle'); onClose?.(); }}
            >
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
