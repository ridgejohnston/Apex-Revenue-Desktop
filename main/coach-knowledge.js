/**
 * Apex Revenue — Coach Knowledge Base
 *
 * Persistent storage for knowledge the Coach learns over time, via
 * two paths:
 *   1. SHIPPED knowledge — curated research artifacts bundled into
 *      the installer at `<app>/coach-knowledge-shipped/`. Read-only
 *      at runtime; updated by shipping a new app version
 *   2. USER-LEARNED knowledge — on-demand research triggered by
 *      `/research <topic>` commands. Stored under
 *      `<userData>/coach-knowledge/`. Per-install, user-deletable
 *
 * Each knowledge artifact is a JSON file of the shape:
 *   {
 *     topic: "Stripchat cam score optimization",
 *     summary: "...",            // 1-2 paragraph overview
 *     keyPoints: ["...", ...],   // bullet takeaways
 *     sources: [{ title, url }], // research provenance
 *     ts: 1713479820000,         // created-at
 *     source: "user" | "shipped",
 *   }
 *
 * File naming: `YYYY-MM-DD-topic-slug.json` — chronologically sortable
 * and human-readable when the user browses their Training Log.
 *
 * The electron-store vs DynamoDB question from two turns ago lands
 * here at electron-store — specifically, raw files in the userData
 * directory rather than electron-store's indexed JSON because our
 * artifacts are large chunks of text and we want filesystem-level
 * inspectability. Plain files also mean users can back up / share
 * their Coach's knowledge by zipping a directory.
 */

const path = require('path');
const fs = require('fs').promises;

let USER_DIR = null;
let SHIPPED_DIR = null;

/**
 * Bind the knowledge base to Electron app paths. Called once from
 * main.js after app.whenReady() so app.getPath() resolves correctly.
 */
function init(app) {
  USER_DIR = path.join(app.getPath('userData'), 'coach-knowledge');
  // Shipped knowledge lives alongside the app code. In dev this is
  // the repo root; in the packaged app it's inside app.asar or next
  // to it via extraResources (see electron-builder config).
  const candidates = [
    path.join(process.resourcesPath || '', 'coach-knowledge-shipped'),
    path.join(__dirname, '..', 'coach-knowledge-shipped'),
  ];
  SHIPPED_DIR = candidates[0];
  // Resolve lazily when we first read — not all candidates exist
}

async function _ensureUserDir() {
  if (!USER_DIR) throw new Error('coach-knowledge not initialized — call init(app) first');
  await fs.mkdir(USER_DIR, { recursive: true });
}

async function _resolveShipped() {
  // Try candidates in order; return first that exists
  const candidates = [
    path.join(process.resourcesPath || '', 'coach-knowledge-shipped'),
    path.join(__dirname, '..', 'coach-knowledge-shipped'),
  ];
  for (const c of candidates) {
    try {
      await fs.access(c);
      return c;
    } catch {}
  }
  return null;
}

function _slugify(s) {
  return (s || 'untitled')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Persist a freshly-researched knowledge artifact. Returns the
 * filename used so callers can reference it in the UI.
 */
async function save(knowledge) {
  await _ensureUserDir();
  const date = new Date(knowledge.ts || Date.now()).toISOString().slice(0, 10);
  const slug = _slugify(knowledge.topic);
  const filename = `${date}-${slug}.json`;
  const full = path.join(USER_DIR, filename);
  const payload = {
    ...knowledge,
    source: 'user',
    ts: knowledge.ts || Date.now(),
  };
  await fs.writeFile(full, JSON.stringify(payload, null, 2), 'utf8');
  return filename;
}

async function _readDir(dir, source) {
  try {
    const files = await fs.readdir(dir);
    const items = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const raw = await fs.readFile(path.join(dir, f), 'utf8');
        const obj = JSON.parse(raw);
        items.push({ ...obj, filename: f, source });
      } catch { /* skip corrupted files quietly */ }
    }
    return items;
  } catch {
    return []; // directory doesn't exist = empty knowledge base
  }
}

/**
 * Full inventory — shipped + user, sorted most-recent first. Used by
 * the Training Log UI and by the prompt-injection loader.
 */
async function list() {
  const shipped = SHIPPED_DIR ? await _readDir(await _resolveShipped() || '', 'shipped') : [];
  const user = USER_DIR ? await _readDir(USER_DIR, 'user') : [];
  const all = [...shipped, ...user];
  all.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return all;
}

/**
 * Delete a user-learned knowledge artifact. Refuses to delete shipped
 * artifacts — those travel with the installer and the user shouldn't
 * be able to break their Coach's baseline knowledge.
 */
async function remove(filename) {
  if (!USER_DIR) throw new Error('coach-knowledge not initialized');
  // Defense: only delete files under USER_DIR. Path-traversal guard.
  const full = path.resolve(path.join(USER_DIR, filename));
  if (!full.startsWith(path.resolve(USER_DIR))) {
    throw new Error('Invalid knowledge filename');
  }
  try {
    await fs.unlink(full);
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a compact prompt-injection block from the N most recent
 * knowledge artifacts. This is what gets appended to the Coach's
 * system prompt at call time — turns saved research into live
 * intelligence.
 *
 * Kept small intentionally: we grab the summary + top 5 key points
 * from each artifact, not the full body. Haiku's context is ample
 * but bloat slows responses and costs tokens on every message.
 */
async function buildPromptContext({ limit = 8 } = {}) {
  const all = await list();
  if (all.length === 0) return '';

  const recent = all.slice(0, limit);
  const sections = recent.map((k) => {
    const kp = Array.isArray(k.keyPoints) ? k.keyPoints.slice(0, 5) : [];
    const kpStr = kp.length ? '\n  • ' + kp.join('\n  • ') : '';
    return `◆ ${k.topic} [${k.source}, ${new Date(k.ts).toISOString().slice(0, 10)}]\n${k.summary || ''}${kpStr}`;
  });

  return `\n═══════════════════════════════════════════════════════════════\nADDITIONAL LEARNED KNOWLEDGE (most recent ${recent.length} of ${all.length} artifacts)\n═══════════════════════════════════════════════════════════════\n\n${sections.join('\n\n')}`;
}

/**
 * Summary stats for the Training Log UI + intelligence tracker.
 */
async function stats() {
  const all = await list();
  const user = all.filter((k) => k.source === 'user');
  const shipped = all.filter((k) => k.source === 'shipped');
  const totalWords = all.reduce((sum, k) => {
    const s = (k.summary || '') + ' ' + (Array.isArray(k.keyPoints) ? k.keyPoints.join(' ') : '');
    return sum + s.split(/\s+/).filter(Boolean).length;
  }, 0);
  return {
    totalArtifacts: all.length,
    shippedArtifacts: shipped.length,
    userArtifacts: user.length,
    totalWords,
    oldestTs: all.length ? Math.min(...all.map((k) => k.ts || 0)) : null,
    newestTs: all.length ? Math.max(...all.map((k) => k.ts || 0)) : null,
  };
}

module.exports = { init, save, list, remove, buildPromptContext, stats };
