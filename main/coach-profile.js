/**
 * Apex Revenue — Coach Profile
 *
 * Persistent, structured profile of the individual performer. Distinct
 * from coach-knowledge.js:
 *
 *   • coach-knowledge = WORLD facts (researched strategies, performance
 *     craft, industry norms). Applies to all users. Many files.
 *   • coach-profile   = SELF facts (this performer's niche, platform,
 *     goals, regulars, hard NOs, style prefs). Specific to this install.
 *     One file.
 *
 * Storage decision: electron-store pattern (plain JSON file under
 * Electron's userData directory). NOT DynamoDB. Rationale:
 *
 *   1. PRIVACY — performer profile data is the most sensitive in the
 *      app. Niche, hard NOs, whale names, comfort boundaries. Every
 *      byte in AWS is a breach surface. Local-only is genuinely safer.
 *   2. COST — avoids a DynamoDB read on every coach message. Coach
 *      hits this file as a local disk read (~ms) on each call.
 *   3. OFFLINE — hotel wifi blocking AWS? Coach still works.
 *   4. PATTERN CONSISTENCY — beauty config, session tokens, KB all
 *      live locally. Cloud state just for profile would be anomalous.
 *   5. MIGRATION COST — cheap to add opt-in cloud backup later by
 *      uploading this JSON as an encrypted blob keyed on Cognito sub.
 *
 * Tradeoff accepted: reinstall = lose profile. Mitigated by the
 * existing /export command which already covers training data; we
 * add the profile to the export bundle so a user can snapshot it.
 *
 * File location: <userData>/coach-profile.json
 * Schema version: 1
 */

const fs = require('fs').promises;
const path = require('path');

let PROFILE_PATH = null;

// Soft caps — prevent pathological growth. Profile is meant to be
// compact; users dumping novels in should be redirected to /learn
// (which goes into the knowledge base, not the profile).
const MAX_STRING       = 500;
const MAX_NOTES        = 50;
const MAX_REGULARS     = 100;
const MAX_HARD_NOS     = 30;
const MAX_OTHER_PLATS  = 10;

function init(app) {
  PROFILE_PATH = path.join(app.getPath('userData'), 'coach-profile.json');
}

function _emptyProfile() {
  return {
    version: 1,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    // Identity
    stageName: null,
    primaryPlatform: null,      // 'chaturbate' | 'stripchat' | 'mfc' | 'xtease' | 'bongacams' | null
    otherPlatforms: [],
    // Niche / persona
    niche: {
      archetype: null,           // free-text: 'goth domme', 'GFE girl-next-door', 'cosplay kink', etc.
      style: null,               // free-text finer description
      signature: null,           // signature gesture / catchphrase / prop
    },
    // Comfort / boundaries
    hardNos: [],                 // Array<string> — never suggest these regardless of context
    // Goals
    goals: {
      weeklyRevenueUSD: null,    // number
      sessionHours: null,        // number
      daysPerWeek: null,         // number
      topOfMind: null,           // free-text current focus ("private conversion rate")
    },
    // Regulars worth remembering by name
    regulars: [],                // Array<{ id, name, note, firstSeen }>
    // Free-form performer notes (catch-all for /remember)
    notes: [],                   // Array<{ id, content, createdAt }>
    // Coach style preferences
    preferences: {
      tone: null,                // 'direct' | 'warm' | 'playful' | null
      length: null,              // 'brief' | 'standard' | 'detailed' | null
    },
  };
}

function _assertInitialized() {
  if (!PROFILE_PATH) {
    throw new Error('coach-profile not initialized — call init(app) first');
  }
}

async function get() {
  _assertInitialized();
  try {
    const raw = await fs.readFile(PROFILE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    // Merge with defaults so partial/old profiles get missing fields
    // filled in without mutation on disk (happens on next save).
    const defaults = _emptyProfile();
    return {
      ...defaults,
      ...parsed,
      niche:       { ...defaults.niche,       ...(parsed.niche       || {}) },
      goals:       { ...defaults.goals,       ...(parsed.goals       || {}) },
      preferences: { ...defaults.preferences, ...(parsed.preferences || {}) },
      hardNos:     Array.isArray(parsed.hardNos)        ? parsed.hardNos        : [],
      regulars:    Array.isArray(parsed.regulars)       ? parsed.regulars       : [],
      notes:       Array.isArray(parsed.notes)          ? parsed.notes          : [],
      otherPlatforms: Array.isArray(parsed.otherPlatforms) ? parsed.otherPlatforms : [],
    };
  } catch (err) {
    if (err.code === 'ENOENT') return _emptyProfile();
    console.warn('[coach-profile] load failed, returning empty:', err.message);
    return _emptyProfile();
  }
}

async function _writeAtomic(profile) {
  const tmp = PROFILE_PATH + '.tmp';
  const payload = JSON.stringify({ ...profile, updatedAt: Date.now() }, null, 2);
  await fs.mkdir(path.dirname(PROFILE_PATH), { recursive: true });
  await fs.writeFile(tmp, payload, 'utf8');
  await fs.rename(tmp, PROFILE_PATH);
}

/**
 * Replace the full profile. Used for imports / resets. Prefer update()
 * for patch-style edits.
 */
async function set(profile) {
  _assertInitialized();
  await _writeAtomic(profile);
}

/**
 * Shallow patch. Top-level keys are replaced; nested objects (niche,
 * goals, preferences) are merged rather than replaced so a caller
 * setting just `niche.archetype` doesn't wipe `niche.style`.
 */
async function update(patch = {}) {
  _assertInitialized();
  const cur = await get();
  const next = {
    ...cur,
    ...patch,
    niche:       { ...cur.niche,       ...(patch.niche       || {}) },
    goals:       { ...cur.goals,       ...(patch.goals       || {}) },
    preferences: { ...cur.preferences, ...(patch.preferences || {}) },
  };
  await _writeAtomic(next);
  return next;
}

// ─── Convenience mutators for common ops ────────────────

async function addHardNo(text) {
  if (!text || typeof text !== 'string') return { error: 'hard-no text required' };
  const trimmed = text.trim().slice(0, MAX_STRING);
  if (!trimmed) return { error: 'empty hard-no' };
  const cur = await get();
  if (cur.hardNos.length >= MAX_HARD_NOS) return { error: `Hard-no list at capacity (${MAX_HARD_NOS}).` };
  if (cur.hardNos.some((h) => h.toLowerCase() === trimmed.toLowerCase())) {
    return { error: `"${trimmed}" is already on your hard-no list.` };
  }
  cur.hardNos.push(trimmed);
  await _writeAtomic(cur);
  return { ok: true, added: trimmed };
}

async function removeHardNo(text) {
  const cur = await get();
  const before = cur.hardNos.length;
  cur.hardNos = cur.hardNos.filter((h) => h.toLowerCase() !== (text || '').trim().toLowerCase());
  if (cur.hardNos.length === before) return { error: `"${text}" not found on hard-no list.` };
  await _writeAtomic(cur);
  return { ok: true, removed: text };
}

async function addRegular(name, note) {
  if (!name || typeof name !== 'string') return { error: 'regular name required' };
  const cur = await get();
  if (cur.regulars.length >= MAX_REGULARS) return { error: `Regulars list at capacity (${MAX_REGULARS}).` };
  const nameTrimmed = name.trim().slice(0, 80);
  const noteTrimmed = (note || '').trim().slice(0, MAX_STRING);
  const entry = {
    id: 'reg_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    name: nameTrimmed,
    note: noteTrimmed,
    firstSeen: Date.now(),
  };
  cur.regulars.push(entry);
  await _writeAtomic(cur);
  return { ok: true, entry };
}

async function removeRegular(nameOrId) {
  const cur = await get();
  const q = (nameOrId || '').trim().toLowerCase();
  const before = cur.regulars.length;
  cur.regulars = cur.regulars.filter((r) => {
    if (r.id === nameOrId) return false;
    if (r.id.startsWith(nameOrId)) return false;
    if (r.name.toLowerCase() === q) return false;
    return true;
  });
  if (cur.regulars.length === before) return { error: `No regular matching "${nameOrId}".` };
  await _writeAtomic(cur);
  return { ok: true, removed: nameOrId };
}

async function addNote(content) {
  if (!content || typeof content !== 'string') return { error: 'note content required' };
  const cur = await get();
  if (cur.notes.length >= MAX_NOTES) {
    return { error: `Notes at capacity (${MAX_NOTES}). Remove some or move them into the knowledge base with /learn.` };
  }
  const trimmed = content.trim().slice(0, MAX_STRING);
  if (!trimmed) return { error: 'empty note' };
  const entry = {
    id: 'note_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    content: trimmed,
    createdAt: Date.now(),
  };
  cur.notes.push(entry);
  await _writeAtomic(cur);
  return { ok: true, entry };
}

async function removeNote(idPrefix) {
  const cur = await get();
  const q = (idPrefix || '').trim();
  const match = cur.notes.find((n) => n.id === q || n.id.startsWith(q));
  if (!match) return { error: `No note matching "${idPrefix}".` };
  cur.notes = cur.notes.filter((n) => n.id !== match.id);
  await _writeAtomic(cur);
  return { ok: true, removed: match.id };
}

async function clear() {
  _assertInitialized();
  await _writeAtomic(_emptyProfile());
}

/**
 * Render the profile as prompt context. Returns empty string if the
 * profile is empty (avoid adding meaningless scaffolding to the
 * system prompt for first-run users).
 */
async function buildPromptContext() {
  const p = await get();
  const lines = [];

  const hasIdentity = p.stageName || p.primaryPlatform || p.niche.archetype;
  const hasGoals    = p.goals.weeklyRevenueUSD || p.goals.topOfMind;
  const hasLists    = p.hardNos.length || p.regulars.length || p.notes.length;
  const hasPrefs    = p.preferences.tone || p.preferences.length;

  if (!hasIdentity && !hasGoals && !hasLists && !hasPrefs) return '';

  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('PERFORMER PROFILE (persistent, this specific performer)');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push('Apply this profile as context for every response. Adapt recommendations to their niche and platform. NEVER suggest anything on the hard-nos list, regardless of tip amount or conversational context. Reference regulars by name when discussing those specific fans. Do NOT recite the profile back at the user — just use it.');
  lines.push('');

  if (hasIdentity) {
    if (p.stageName)          lines.push(`  Stage name: ${p.stageName}`);
    if (p.primaryPlatform)    lines.push(`  Primary platform: ${p.primaryPlatform}`);
    if (p.otherPlatforms.length) lines.push(`  Also streams on: ${p.otherPlatforms.join(', ')}`);
    if (p.niche.archetype)    lines.push(`  Niche archetype: ${p.niche.archetype}`);
    if (p.niche.style)        lines.push(`  Style: ${p.niche.style}`);
    if (p.niche.signature)    lines.push(`  Signature: ${p.niche.signature}`);
    lines.push('');
  }

  if (p.hardNos.length) {
    lines.push('  HARD NOS — never suggest these, no matter the tip amount:');
    for (const h of p.hardNos) lines.push(`    ✗ ${h}`);
    lines.push('');
  }

  if (hasGoals) {
    lines.push('  Goals:');
    if (p.goals.weeklyRevenueUSD)  lines.push(`    • Weekly revenue target: $${p.goals.weeklyRevenueUSD}`);
    if (p.goals.sessionHours)      lines.push(`    • Typical session: ${p.goals.sessionHours} hours`);
    if (p.goals.daysPerWeek)       lines.push(`    • Days per week: ${p.goals.daysPerWeek}`);
    if (p.goals.topOfMind)         lines.push(`    • Top of mind: ${p.goals.topOfMind}`);
    lines.push('');
  }

  if (p.regulars.length) {
    lines.push(`  Regulars (${p.regulars.length}) — know these by name:`);
    for (const r of p.regulars.slice(0, 20)) {
      lines.push(`    • ${r.name}${r.note ? ' — ' + r.note : ''}`);
    }
    if (p.regulars.length > 20) lines.push(`    …and ${p.regulars.length - 20} more`);
    lines.push('');
  }

  if (p.notes.length) {
    lines.push(`  Notes (${p.notes.length}) — context the performer has shared:`);
    for (const n of p.notes.slice(-10)) {  // latest 10
      lines.push(`    • ${n.content}`);
    }
    lines.push('');
  }

  if (hasPrefs) {
    const parts = [];
    if (p.preferences.tone)   parts.push(`tone: ${p.preferences.tone}`);
    if (p.preferences.length) parts.push(`length: ${p.preferences.length}`);
    lines.push(`  Coach style preference: ${parts.join(', ')}`);
    lines.push('');
  }

  return lines.join('\n');
}

module.exports = {
  init,
  get,
  set,
  update,
  addHardNo,
  removeHardNo,
  addRegular,
  removeRegular,
  addNote,
  removeNote,
  clear,
  buildPromptContext,
};
