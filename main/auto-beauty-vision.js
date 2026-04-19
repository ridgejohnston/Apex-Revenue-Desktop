/**
 * Apex Revenue — Auto-Beauty Vision (main process)
 *
 * Takes a base64 JPEG of the performer's current video frame (delivered
 * from the renderer via IPC) and asks Claude Haiku, running on Bedrock,
 * for the beauty-filter settings that would flatter the subject under
 * their current lighting. Returns a structured JSON object the renderer
 * can merge into the live filter config.
 *
 * WHY VISION INSTEAD OF PIXEL STATS
 *
 * A pixel histogram tells you the frame is dim or bright. Claude Haiku
 * with vision tells you the PERFORMER's skin tone is cool and needs
 * warming, or that the shadows fall unflatteringly across the jawline
 * and a low-light boost would lift them, or that the webcam compression
 * is mushing edge detail and a sharpness nudge would help — judgments
 * that require actually SEEING the person, not computing luma stddev.
 *
 * CADENCE
 *
 * The renderer throttles calls to one every 15 seconds, so at Haiku's
 * input-token price (~$0.00025 per image) a 4-hour stream costs about
 * $0.24 in vision analysis. Cheap enough to leave on indefinitely,
 * substantive enough to meaningfully improve the performer's look.
 *
 * RESPONSE CONTRACT
 *
 * The function returns a plain object with integer values for up to 7
 * slider keys. All keys are optional — if Claude thinks a particular
 * slider is already correct, it just doesn't include that key. The
 * renderer uses EMA + per-tick-delta-clamp so even wild suggestions
 * don't jump the preview.
 *
 *   {
 *     intensity:  int 0..100    // overall beauty blend strength
 *     smoothness: int 0..100    // bilateral skin softening
 *     warmth:     int -100..100 // red↔blue shift (positive = warmer)
 *     brightness: int -100..100 // additive lift/darken
 *     contrast:   int -100..100 // pop shadows vs highlights
 *     saturation: int -100..100 // color richness
 *     lowLight:   int 0..100    // gamma lift in shadows
 *     reason:     string        // 1-sentence natural-language note for debug
 *   }
 */

const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');
const { getBedrockClient } = require('./aws-services');
const { BEDROCK_MODEL_ID } = require('../shared/aws-config');

// Lower temperature → more deterministic suggestions. We don't want
// creative interpretation, we want steady technical tuning.
const AUTO_BEAUTY_TEMPERATURE = 0.2;
// Max tokens in the response. The JSON contract fits in ~120 tokens
// comfortably; 300 leaves headroom for the reason field plus any
// preamble Claude decides to emit before the JSON block.
const AUTO_BEAUTY_MAX_TOKENS  = 300;

const SYSTEM_PROMPT =
`You are a professional streaming video technician tuning a webcam
beauty filter for a live cam performer. You will receive a frame from
their current video output and recommend filter slider values that
would make the performer look more flattering under their current
lighting conditions.

Your recommendations should follow professional beauty-filter best
practices:

• Target gently warm skin (not cool/blue cast). Red should read
  slightly above blue in skin pixels. Warmth nudges in the +5 to
  +25 range are typically enough; going over +30 starts looking
  orange and unnatural.

• Preserve facial detail. The Intensity slider blends the smoothed
  layer with the original — 35-55 is typically flattering for most
  skin types. Going above 65 starts looking waxy and plastic. Below
  25 does nothing visible.

• Smoothness controls skin softening specifically. 40-60 is the
  flattering band. Very smooth (80+) looks fake; very rough (below
  20) defeats the purpose of the filter.

• If the frame is dim and shadows swallow the face, recommend a
  positive Low-Light Boost (30-60). If the frame is well-lit, leave
  it at 0.

• Brightness is a global additive lift. Only push positive if the
  face itself is underexposed. Don't fight the lighting aesthetic.

• Contrast (+15 to +30) helps a flat low-contrast frame pop. Don't
  push contrast on an already-punchy frame — it'll blow out highlights.

• Saturation 0-25 positive if skin looks washed/gray. Negative only
  if colors look oversaturated.

CRITICAL OUTPUT FORMAT:

Respond with exactly ONE valid JSON object and NO other text. No
preamble, no markdown fences, no explanation outside the JSON. Keys
are optional — only include sliders you actually want to change.
All integer values. Example valid response:

{"warmth": 15, "intensity": 45, "lowLight": 20, "contrast": 10, "reason": "Skin reads slightly cool; lifted warmth and added low-light to bring face forward."}

If the image is fully black, corrupt, or the person isn't visible,
respond with: {"reason": "Cannot analyze — frame not usable."}`;

const USER_TEXT =
`Analyze this frame from my live webcam stream. Recommend beauty-filter
slider values that would make me look better under this lighting.
Respond with the JSON object only.`;

/**
 * Invoke Bedrock Haiku with the frame image and parse suggestions.
 *
 * @param {string} base64Jpeg — base64-encoded JPEG bytes (no data: prefix)
 * @returns {Promise<object>} — parsed suggestion object, or { reason } only
 */
async function analyzeFrameForBeauty(base64Jpeg) {
  if (!base64Jpeg || typeof base64Jpeg !== 'string') {
    return { reason: 'no-image' };
  }

  const bedrock = getBedrockClient();

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: AUTO_BEAUTY_MAX_TOKENS,
    temperature: AUTO_BEAUTY_TEMPERATURE,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/jpeg',
              data: base64Jpeg,
            },
          },
          { type: 'text', text: USER_TEXT },
        ],
      },
    ],
  });

  const cmd = new InvokeModelCommand({
    modelId: BEDROCK_MODEL_ID,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  let raw;
  try {
    const response = await bedrock.send(cmd);
    const result = JSON.parse(new TextDecoder().decode(response.body));
    raw = result.content?.[0]?.text || '';
  } catch (err) {
    // Network/Bedrock errors are fatal for THIS tick but non-fatal
    // overall — the renderer just leaves the sliders where they are
    // and tries again in 15 seconds. We return an empty suggestion
    // so the renderer's normal early-return path handles it cleanly.
    return { reason: `bedrock-error: ${err?.message || 'unknown'}` };
  }

  // Extract the JSON blob. Claude sometimes wraps with markdown fences
  // or emits a leading sentence despite the system prompt; be defensive.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return { reason: 'no-json-in-response' };

  let parsed;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return { reason: 'bad-json' };
  }

  // Coerce and clamp each expected key. Silently drop anything we don't
  // recognize — we never want Claude's vision output to write keys
  // outside the sanctioned set.
  const out = {};
  const clampInt = (v, lo, hi) => {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return undefined;
    return Math.max(lo, Math.min(hi, n));
  };
  const keys = [
    ['intensity',  0,    100 ],
    ['smoothness', 0,    100 ],
    ['warmth',     -100, 100 ],
    ['brightness', -100, 100 ],
    ['contrast',   -100, 100 ],
    ['saturation', -100, 100 ],
    ['lowLight',   0,    100 ],
  ];
  for (const [k, lo, hi] of keys) {
    if (parsed[k] !== undefined) {
      const v = clampInt(parsed[k], lo, hi);
      if (v !== undefined) out[k] = v;
    }
  }
  if (typeof parsed.reason === 'string') out.reason = parsed.reason.slice(0, 240);
  return out;
}

module.exports = { analyzeFrameForBeauty };
