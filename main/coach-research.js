/**
 * Apex Revenue — Coach Research Engine
 *
 * On-demand deep-research capability for the AI Coach. Workflow:
 *   1. User triggers with `/research <topic>` (detected in ai-coach.js)
 *   2. We search DuckDuckGo's HTML results page (no API key required,
 *      works everywhere, respects rate limits)
 *   3. Fetch the top N result pages, strip HTML to plain text
 *   4. Feed search results + page bodies to Bedrock Claude Haiku
 *      with a synthesis prompt asking for a cam-industry-relevant
 *      knowledge artifact
 *   5. Return structured output { topic, summary, keyPoints, sources }
 *   6. Caller (ai-coach) saves via coach-knowledge.save(), which
 *      merges it into the prompt on subsequent messages
 *
 * Why DuckDuckGo HTML scraping and not a "proper" API:
 *   • Zero config — works the moment the user installs, no API key
 *     shipping / rotation / revocation
 *   • Works across every user's network setup
 *   • DDG specifically publishes a scraping-friendly HTML variant
 *     at html.duckduckgo.com/html/?q=...
 *   • If it ever breaks, we can swap to Brave Search API by editing
 *     ONLY the _searchWeb function — the rest of the pipeline is
 *     backend-agnostic
 *
 * Cost/latency budget: typical research call runs ~15–40 seconds
 * (1 search + 3 page fetches + 1 synthesis call). The UI surfaces
 * progress states so the user doesn't think we've hung.
 */

const MAX_SEARCH_RESULTS = 5;
const MAX_PAGES_TO_FETCH = 3;
const PAGE_CONTENT_CHAR_LIMIT = 8000;  // ~2000 tokens per page, keeps synthesis input bounded
const SYNTHESIS_MAX_TOKENS = 1200;
const FETCH_TIMEOUT_MS = 8000;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0 Safari/537.36';

/**
 * Fetch with a hard timeout — don't let a slow page block the whole
 * research call. Swallows errors and returns null so callers can
 * just filter the failures.
 */
async function _fetchWithTimeout(url, { timeout = FETCH_TIMEOUT_MS, headers = {} } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': USER_AGENT, ...headers },
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/**
 * DuckDuckGo HTML search results scraper. DDG publishes a scraping-
 * friendly HTML page at html.duckduckgo.com — each result is wrapped
 * in a .result container with a title link, URL, and snippet.
 *
 * Regex over proper HTML parsing keeps us dep-free. The structure is
 * stable enough that a regex has worked for years in similar tools.
 * If DDG ever restructures, the failure mode is "no results" — the
 * rest of the pipeline degrades gracefully.
 */
async function _searchWeb(query) {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await _fetchWithTimeout(url, { timeout: 10000 });
  if (!html) return [];

  const results = [];
  // DDG's result block: <a class="result__a" href="/l/?kh=...&uddg=ACTUAL_URL">TITLE</a>
  // followed by <a class="result__snippet">SNIPPET</a>
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null && results.length < MAX_SEARCH_RESULTS) {
    const rawHref = m[1];
    const title = _stripHtml(m[2]).trim();
    const snippet = _stripHtml(m[3]).trim();

    // DDG wraps results in a redirect: /l/?uddg=<actual-url>
    let actualUrl = rawHref;
    const uddgMatch = rawHref.match(/uddg=([^&]+)/);
    if (uddgMatch) {
      try { actualUrl = decodeURIComponent(uddgMatch[1]); } catch {}
    }
    // Skip DDG-internal links or non-http
    if (!/^https?:/.test(actualUrl)) continue;

    results.push({ title, url: actualUrl, snippet });
  }
  return results;
}

/**
 * Quick-and-dirty HTML → text. Doesn't handle every edge case but
 * gets us readable prose from the vast majority of pages without
 * shipping a full HTML parser dep. The output feeds into Bedrock's
 * context so minor noise is fine — the model filters it out during
 * synthesis.
 */
function _stripHtml(html) {
  return (html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

async function _fetchPage(url) {
  const html = await _fetchWithTimeout(url, { timeout: FETCH_TIMEOUT_MS });
  if (!html) return null;
  const text = _stripHtml(html);
  return text.slice(0, PAGE_CONTENT_CHAR_LIMIT);
}

/**
 * Synthesize search results + page bodies into a structured knowledge
 * artifact via Bedrock Claude Haiku. Output is JSON to make it easy to
 * persist and inject into later prompts.
 */
async function _synthesize(topic, searchResults, pages, bedrockClient, modelId) {
  const { InvokeModelCommand } = require('@aws-sdk/client-bedrock-runtime');

  const sourceBlocks = searchResults.map((r, i) => {
    const body = pages[i] ? `\nExcerpt: ${pages[i].slice(0, 3000)}` : '';
    return `[Source ${i + 1}]\nTitle: ${r.title}\nURL: ${r.url}\nSnippet: ${r.snippet}${body}`;
  }).join('\n\n');

  const systemPrompt = `You synthesize research findings into tactical knowledge artifacts for the Apex Revenue AI Coach — an advisor to professional live cam models. Your output is NOT the user-facing answer; it's a persistent knowledge record the Coach will draw on in later conversations.

Goals:
  • Extract concrete, actionable tactics — name specific techniques, numbers, dollar/token amounts, percentages, timings
  • Synthesize across sources, don't just summarize one
  • Skip marketing fluff and recycled generic advice
  • If sources disagree, note the disagreement
  • If sources are weak or off-topic, say so plainly rather than fabricating depth

Output format — STRICT JSON with this exact shape, nothing else before or after:
{
  "topic": "<concise canonical version of the research topic>",
  "summary": "<2-4 sentence distillation of the most important finding>",
  "keyPoints": ["<tactical bullet 1>", "<tactical bullet 2>", ... up to 10 bullets],
  "qualityNote": "<one sentence on source quality — good/mixed/weak and why>"
}`;

  const userMessage = `Research topic: "${topic}"

Sources gathered from web search:

${sourceBlocks}

Synthesize these into a knowledge artifact per the output format. Return ONLY the JSON.`;

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: SYNTHESIS_MAX_TOKENS,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const cmd = new InvokeModelCommand({
    modelId,
    contentType: 'application/json',
    accept: 'application/json',
    body,
  });

  const response = await bedrockClient.send(cmd);
  const result = JSON.parse(new TextDecoder().decode(response.body));
  const text = result.content?.[0]?.text || '';

  // Claude sometimes wraps JSON in markdown fences despite instructions.
  // Strip those defensively before parsing.
  const cleaned = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    // Fallback: salvage what we can so the research doesn't completely fail
    return {
      topic,
      summary: text.slice(0, 500),
      keyPoints: [],
      qualityNote: 'Synthesis output was not valid JSON; saved raw text as summary.',
    };
  }
}

/**
 * Public API: run a full research pass for a topic.
 *
 * @param {string} topic      The user-supplied research subject
 * @param {object} options
 * @param {object} options.bedrockClient  Initialized Bedrock client (from aws-services)
 * @param {string} options.modelId        Bedrock model ID (from shared/aws-config)
 * @param {function} options.onProgress   Called with status strings: 'searching', 'reading', 'synthesizing'
 * @returns {Promise<object>}  The knowledge artifact { topic, summary, keyPoints, sources, ts, qualityNote }
 */
async function researchTopic(topic, { bedrockClient, modelId, onProgress } = {}) {
  if (!topic || typeof topic !== 'string') throw new Error('Invalid research topic');
  if (!bedrockClient) throw new Error('Bedrock client not provided');
  if (!modelId) throw new Error('Model ID not provided');

  onProgress?.('searching');
  const searchResults = await _searchWeb(topic);
  if (searchResults.length === 0) {
    return {
      topic,
      summary: 'Web search returned no usable results for this topic — either the query was too niche or the search backend is temporarily unavailable.',
      keyPoints: [],
      sources: [],
      qualityNote: 'empty',
      ts: Date.now(),
    };
  }

  onProgress?.('reading');
  const pagesToFetch = searchResults.slice(0, MAX_PAGES_TO_FETCH);
  const pages = await Promise.all(pagesToFetch.map((r) => _fetchPage(r.url).catch(() => null)));

  onProgress?.('synthesizing');
  const synthesized = await _synthesize(topic, searchResults, pages, bedrockClient, modelId);

  return {
    topic: synthesized.topic || topic,
    summary: synthesized.summary || '',
    keyPoints: Array.isArray(synthesized.keyPoints) ? synthesized.keyPoints : [],
    qualityNote: synthesized.qualityNote || '',
    sources: searchResults.map((r) => ({ title: r.title, url: r.url })),
    ts: Date.now(),
  };
}

module.exports = { researchTopic };
