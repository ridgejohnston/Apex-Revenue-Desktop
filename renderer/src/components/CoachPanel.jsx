import React, { useState, useEffect, useRef, useCallback } from 'react';

/**
 * AI Coach chat panel — companion to the one-shot AI Prompt Engine.
 *
 * Lives inside AIPanel as one of two sub-modes (Prompts | Coach). Talks
 * to main via window.electronAPI.coach bridge; the main-process module
 * holds all conversation state.
 *
 * UX decisions:
 *   • No typing indicator — a simple "Thinking…" placeholder is enough
 *     for Haiku's ~500 ms latency; an animated typing bubble looks
 *     over-engineered at this length
 *   • Enter to send, Shift+Enter for newline (standard chat affordance)
 *   • Auto-scroll to bottom only when the user is already near the
 *     bottom — avoids yanking them away if they've scrolled up to
 *     re-read something
 *   • Session stats (viewers, tokens, platform, etc.) are injected by
 *     this component when sending a message — the main process doesn't
 *     know about liveData, so we pass it through every call
 */

// Suggested starter questions. Drawn from the kinds of things cam
// performers actually ask each other in forums + Discord servers.
// Keeps the empty-state useful rather than a staring-at-a-blinking-
// cursor moment.
const STARTER_SUGGESTIONS = [
  'My chat is quiet. How do I get them talking?',
  'I have one whale tipping — how do I keep them engaged?',
  'What should I do in the last 15 min of my session?',
  'Help me plan a 2-hour session for tonight.',
  'I\'m burned out mid-session. Quick pick-me-up?',
];

export default function CoachPanel({ user, liveData, platform, effectivePlan, unlocked, onAuthClick }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const scrollerRef = useRef(null);
  const inputRef = useRef(null);

  // Hydrate conversation history on mount — in case user switched
  // to Prompts mode, chatted with it, and came back
  useEffect(() => {
    (async () => {
      try {
        const hist = await window.electronAPI.coach?.history?.();
        if (Array.isArray(hist)) setMessages(hist);
      } catch {}
    })();
  }, []);

  // Auto-scroll when new messages arrive, but only if user was near
  // the bottom already. scrollHeight - scrollTop - clientHeight ≤ 120
  // is a comfortable "near the bottom" threshold.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, sending]);

  const send = useCallback(async (text) => {
    const trimmed = (text ?? input).trim();
    if (!trimmed || sending) return;

    setError(null);
    setSending(true);

    // Optimistic add: show user message immediately so the input feels snappy
    setMessages((prev) => [...prev, { role: 'user', content: trimmed, ts: Date.now() }]);
    setInput('');

    const liveContext = {
      username: user?.email || user?.username,
      platform,
      plan: effectivePlan,
      viewers:        liveData?.viewers,
      tipsToday:      liveData?.tipsToday,
      topFan:         liveData?.fans?.[0]?.username,
      sessionMinutes: liveData?.startTime
        ? Math.floor((Date.now() - liveData.startTime) / 60000)
        : undefined,
    };

    try {
      const result = await window.electronAPI.coach.sendMessage(trimmed, liveContext);
      if (result?.ok && result.reply) {
        setMessages((prev) => [...prev, { role: 'assistant', content: result.reply, ts: Date.now() }]);
      } else {
        setError(result?.error || 'Something went wrong — try again');
      }
    } catch (err) {
      setError(err?.message || 'Network error');
    } finally {
      setSending(false);
      // Return focus to input for fast follow-up
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, sending, user, platform, effectivePlan, liveData]);

  const handleKey = (e) => {
    // Enter to send, Shift+Enter for newline (standard chat affordance)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const clearConversation = useCallback(async () => {
    try { await window.electronAPI.coach?.reset?.(); } catch {}
    setMessages([]);
    setError(null);
  }, []);

  // ─── Gating states ────────────────────────────────────
  if (!user) {
    return (
      <div style={{ padding: 16, textAlign: 'center' }}>
        <div style={{ fontSize: 24, marginBottom: 8 }}>🔒</div>
        <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
          Sign in to chat with your coach
        </div>
        <button className="btn btn-accent" onClick={onAuthClick}>Sign In</button>
      </div>
    );
  }

  if (!unlocked) {
    return (
      <div style={{ padding: 16 }}>
        <div style={{
          padding: '20px 16px',
          background: 'var(--bg-elevated, #1a1a22)',
          border: '1px solid var(--border, #2a2a35)',
          borderRadius: 6,
          textAlign: 'center',
        }}>
          <div style={{ fontSize: 28, marginBottom: 10 }}>🤖🔒</div>
          <div style={{
            fontSize: 13, fontWeight: 700, color: 'var(--text, #f5f5f5)',
            letterSpacing: 1, textTransform: 'uppercase', marginBottom: 6,
          }}>
            AI Coach
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-dim, #9ca3af)', lineHeight: 1.5, marginBottom: 14 }}>
            Ask your coach anything — session strategy, content planning, pacing advice, bad nights. Aware of your live stats, on-call 24/7.
          </div>
          <div style={{
            display: 'inline-block',
            padding: '8px 20px',
            background: 'var(--accent, #cc0000)',
            color: '#fff',
            fontSize: 10, fontWeight: 700, letterSpacing: 2, textTransform: 'uppercase',
            borderRadius: 4, cursor: 'pointer',
          }}
               onClick={() => window.open('https://apexrevenue.works/billing', '_blank')}>
            Upgrade to Platinum
          </div>
          <div style={{ fontSize: 9, color: 'var(--text-dim, #6b7280)', marginTop: 10 }}>
            Currently on: {effectivePlan?.toUpperCase() || 'FREE'}
          </div>
        </div>
      </div>
    );
  }

  const isEmpty = messages.length === 0;

  // ─── Main chat view ───────────────────────────────────
  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      // Don't require parent to be a flex container with a fixed height.
      // A viewport-relative max keeps the scroll region reasonable on
      // any window size while flex:1 lets us fill the parent when it
      // is a flex column (which AIPanel is).
      flex: 1,
      minHeight: 360,
      maxHeight: 'calc(100vh - 180px)',
    }}>
      {/* Scroll region */}
      <div
        ref={scrollerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: '8px 10px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
        }}
      >
        {isEmpty ? (
          <EmptyState onPick={(q) => send(q)} />
        ) : (
          messages.map((m, i) => <Bubble key={i} msg={m} />)
        )}

        {sending && (
          <div style={{
            alignSelf: 'flex-start',
            padding: '8px 12px',
            fontSize: 11,
            color: 'var(--text-dim, #9ca3af)',
            fontStyle: 'italic',
          }}>
            Coach is thinking…
          </div>
        )}

        {error && (
          <div style={{
            padding: '8px 10px',
            fontSize: 10,
            color: '#ef4444',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.25)',
            borderRadius: 4,
          }}>
            {error}
          </div>
        )}
      </div>

      {/* Composer */}
      <div style={{
        borderTop: '1px solid var(--border, #2a2a35)',
        padding: 8,
        display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKey}
            placeholder="Ask your coach…"
            rows={1}
            disabled={sending}
            style={{
              flex: 1,
              resize: 'none',
              padding: '6px 8px',
              fontSize: 12,
              minHeight: 28,
              maxHeight: 96,
              background: 'var(--bg-elevated, #1a1a22)',
              color: 'var(--text, #f5f5f5)',
              border: '1px solid var(--border, #2a2a35)',
              borderRadius: 4,
              outline: 'none',
              fontFamily: 'inherit',
            }}
          />
          <button
            type="button"
            onClick={() => send()}
            disabled={!input.trim() || sending}
            style={{
              padding: '6px 14px',
              background: input.trim() && !sending ? 'var(--accent, #cc0000)' : 'var(--bg-elevated, #1a1a22)',
              color: input.trim() && !sending ? '#fff' : 'var(--text-dim, #6b7280)',
              border: 'none',
              borderRadius: 4,
              fontSize: 11, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
              cursor: input.trim() && !sending ? 'pointer' : 'not-allowed',
            }}
          >
            Send
          </button>
        </div>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 9, color: 'var(--text-dim, #6b7280)' }}>
            Enter to send · Shift+Enter for newline
          </span>
          {messages.length > 0 && (
            <button
              type="button"
              onClick={clearConversation}
              style={{
                background: 'transparent',
                border: 'none',
                color: 'var(--text-dim, #9ca3af)',
                fontSize: 9, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase',
                cursor: 'pointer',
                textDecoration: 'underline',
                padding: 0,
              }}
            >
              Clear
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function EmptyState({ onPick }) {
  return (
    <div style={{ padding: '20px 8px', textAlign: 'center' }}>
      <div style={{ fontSize: 32, marginBottom: 10 }}>🤖</div>
      <div style={{
        fontSize: 12, fontWeight: 700, color: 'var(--text, #f5f5f5)',
        marginBottom: 4,
      }}>
        Hey — I'm your coach.
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-dim, #9ca3af)', marginBottom: 14 }}>
        Ask me about sessions, pacing, content, tough moments. I can see your live stats.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {STARTER_SUGGESTIONS.map((s, i) => (
          <button
            key={i}
            type="button"
            onClick={() => onPick(s)}
            style={{
              padding: '7px 10px',
              textAlign: 'left',
              fontSize: 10.5,
              background: 'var(--bg-elevated, #1a1a22)',
              color: 'var(--text, #f5f5f5)',
              border: '1px solid var(--border, #2a2a35)',
              borderRadius: 4,
              cursor: 'pointer',
              lineHeight: 1.3,
            }}
          >
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

function Bubble({ msg }) {
  const isUser = msg.role === 'user';
  return (
    <div style={{
      alignSelf: isUser ? 'flex-end' : 'flex-start',
      maxWidth: '88%',
      padding: '7px 11px',
      background: isUser ? 'var(--accent, #cc0000)' : 'var(--bg-elevated, #1a1a22)',
      color: isUser ? '#fff' : 'var(--text, #f5f5f5)',
      border: isUser ? 'none' : '1px solid var(--border, #2a2a35)',
      borderRadius: 8,
      fontSize: 11.5,
      lineHeight: 1.45,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {msg.content}
    </div>
  );
}
