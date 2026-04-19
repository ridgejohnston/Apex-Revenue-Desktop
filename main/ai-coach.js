/**
 * Apex Revenue — AI Coach (main-process service)
 *
 * Multi-turn conversational coach for live cam performers. Differs from
 * the existing AI Prompt Engine (main/aws-services.js generatePrompt):
 *   • The Prompt Engine is single-shot — algorithmic trigger → one-line
 *     tip like "Ask for 50 tokens because…". No memory, no dialog.
 *   • This Coach is a back-and-forth chat. The performer asks open
 *     questions ("my chat is dead, what do I do?") and gets situationally
 *     aware, conversational guidance that builds on prior turns.
 *
 * Design:
 *   • One in-memory conversation per app session, keyed nothing — single
 *     active coach per renderer. Clears on app restart or Reset.
 *   • History capped at 20 messages (10 user/assistant pairs). Beyond
 *     that, oldest pairs get dropped — keeps context small + cheap.
 *   • Each call injects live session stats (viewers, tokens, platform,
 *     elapsed minutes) into the system prompt so the coach has current
 *     context without bloating the conversation with every tick of
 *     stats as separate messages.
 *   • Model: Claude 3 Haiku via Bedrock — same client the Prompt Engine
 *     uses. Fast (~500 ms typical), cheap, and plenty for chat. If
 *     someone wants richer reasoning later, bump the modelId to
 *     Sonnet — same code path.
 *
 * Safety framing: the performer's work is NSFW adult streaming. The
 * coach treats it as the professional field it is — no moralizing,
 * no refusals for legitimate work advice. Claude handles this well
 * at the system-prompt level; no extra escape hatches needed.
 */

const { REGION, BEDROCK_MODEL_ID } = require('../shared/aws-config');

// Hard cap on conversation size. Beyond this we drop the oldest
// user/assistant pair (keeps pair boundaries intact so Claude's
// turn-taking doesn't get confused).
const MAX_HISTORY_MESSAGES = 20;

// Response length — coaching answers should be 2-4 sentences, but
// we allow headroom for the occasional longer answer ("walk me through
// a full session plan"). Longer than the 300 the prompt engine uses
// because chat responses are genuinely more verbose than trigger tips.
const COACH_MAX_TOKENS = 600;

const COACH_SYSTEM_PROMPT = `You are an AI coach for live cam performers on platforms like Chaturbate, Stripchat, MyFreeCams, and Xtease. You help them:

  • Strategize session energy and engagement
  • Respond to chat patterns (dead air, whale tips, low viewership, goals)
  • Plan content, themes, and upcoming sessions
  • Process difficult situations emotionally and professionally — haters, slow nights, burnout
  • Optimize earnings through pacing, tip-ask timing, viewer management, and platform-specific tactics
  • Troubleshoot streaming setup, lighting, audio, and visuals

Your audience is pros running a business. Treat them that way. Be direct, practical, and warm without being saccharine. Give concrete, actionable advice — not platitudes. If they vent, acknowledge briefly then pivot to what they can actually do right now.

When session stats are provided, reference them only when genuinely relevant (low viewer count, tip rate dropping, specific fan activity). Don't quote numbers unnecessarily or open every message with "I see you have X viewers".

Keep responses concise: 2-4 sentences for most questions, longer only when asked for a plan or analysis. Ask a clarifying question only when you truly need more context — otherwise give your best answer with stated assumptions.

If asked something outside streaming/camming — tax advice, medical advice, relationship drama unrelated to work — briefly acknowledge and redirect to streaming.`;

class AiCoach {
  constructor(bedrockClient) {
    this.bedrock = bedrockClient;
    // messages: Array<{ role: 'user'|'assistant', content: string, ts: number }>
    this.messages = [];
  }

  /**
   * Send a user message and return the assistant's response.
   *
   * @param {string} userText        The performer's message.
   * @param {object} liveContext     Live session stats injected into the
   *                                 system prompt for this call only.
   *   { viewers, tipsToday, topFan, platform, sessionMinutes, plan, username }
   * @returns {Promise<string>}      The assistant's response text.
   */
  async sendMessage(userText, liveContext = {}) {
    if (!this.bedrock) throw new Error('Bedrock client not initialized');
    if (!userText || typeof userText !== 'string') {
      throw new Error('Empty message');
    }

    // Append user turn first so history survives even if Bedrock fails
    this.messages.push({
      role: 'user',
      content: userText.slice(0, 4000), // safety clamp on absurdly long input
      ts: Date.now(),
    });
    this._trimHistory();

    const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

    const systemPromptWithContext = this._buildSystemPrompt(liveContext);

    const body = JSON.stringify({
      anthropic_version: 'bedrock-2023-05-31',
      max_tokens: COACH_MAX_TOKENS,
      system: systemPromptWithContext,
      // Bedrock Claude Messages API doesn't want the ts field; strip it
      messages: this.messages.map((m) => ({ role: m.role, content: m.content })),
    });

    const cmd = new InvokeModelCommand({
      modelId: BEDROCK_MODEL_ID,
      contentType: 'application/json',
      accept: 'application/json',
      body,
    });

    try {
      const response = await this.bedrock.send(cmd);
      const result = JSON.parse(new TextDecoder().decode(response.body));
      const text = result.content?.[0]?.text || '';
      this.messages.push({ role: 'assistant', content: text, ts: Date.now() });
      this._trimHistory();
      return text;
    } catch (err) {
      // If the call failed, don't leave the user turn dangling with no
      // reply — the UI would show the user message alone with nothing
      // to acknowledge the failure. Bubble the error up so the IPC
      // handler can surface it.
      throw err;
    }
  }

  /**
   * Drop oldest user/assistant pairs until history fits under the cap.
   * Keeps pairs together so we never leave an orphan assistant message
   * that would confuse Claude's turn-taking logic.
   */
  _trimHistory() {
    while (this.messages.length > MAX_HISTORY_MESSAGES) {
      // Drop the first two (oldest user + its assistant reply)
      this.messages.splice(0, 2);
    }
  }

  _buildSystemPrompt(ctx) {
    // Inject a compact session-snapshot at the end of the base prompt
    // so the coach sees current state without bloating the messages
    // array with repeated stat dumps.
    const lines = [COACH_SYSTEM_PROMPT];

    const facts = [];
    if (ctx.username)  facts.push(`Username: ${ctx.username}`);
    if (ctx.platform)  facts.push(`Platform: ${ctx.platform}`);
    if (ctx.plan)      facts.push(`Tier: ${ctx.plan}`);
    if (typeof ctx.viewers === 'number')        facts.push(`Current viewers: ${ctx.viewers}`);
    if (typeof ctx.tipsToday === 'number')      facts.push(`Tokens earned this session: ${ctx.tipsToday}`);
    if (typeof ctx.sessionMinutes === 'number') facts.push(`Elapsed session time: ${ctx.sessionMinutes} min`);
    if (ctx.topFan)                             facts.push(`Top fan present: ${ctx.topFan}`);

    if (facts.length > 0) {
      lines.push('');
      lines.push('Current session snapshot:');
      lines.push(facts.map((f) => `  • ${f}`).join('\n'));
    }

    return lines.join('\n');
  }

  reset() {
    this.messages = [];
  }

  getHistory() {
    // Return a shallow copy so the renderer can't mutate our state
    return this.messages.map((m) => ({ ...m }));
  }
}

module.exports = { AiCoach };
