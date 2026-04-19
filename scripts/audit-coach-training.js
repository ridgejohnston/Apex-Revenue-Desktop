#!/usr/bin/env node
/**
 * Apex Revenue — Coach Training Audit
 *
 * Development-side script. Ridge runs this locally to inspect the Coach's
 * training data (both shipped baseline and whatever he's added via
 * /research) and identify candidates to promote into the `coach-knowledge-
 * shipped/` directory for the next installer release.
 *
 * The core question this script answers:
 *   "Which topics has the Coach been taught, how often, and with what
 *    content — and which of those should I bake into the next release
 *    so all users benefit without each having to /research them?"
 *
 * Usage:
 *   node scripts/audit-coach-training.js                 # default: local userData
 *   node scripts/audit-coach-training.js --dir <path>    # audit a specific directory (e.g. imported from a user's export bundle)
 *   node scripts/audit-coach-training.js --format md     # markdown report (default: console pretty-print)
 *   node scripts/audit-coach-training.js --format json   # raw JSON dump (pipe to jq, etc.)
 *   node scripts/audit-coach-training.js --since 2026-03-01   # only entries after given date
 *   node scripts/audit-coach-training.js --promote         # emit a shipped-artifact template for each promotion candidate
 *
 * Data sources:
 *   • coach-knowledge-shipped/       — curated baseline (repo-local)
 *   • <userData>/coach-knowledge/    — per-install user artifacts
 *   Paths resolve automatically for the platform the script runs on.
 *
 * The script does NOT call the network, does NOT touch Bedrock, does NOT
 * modify any files — it's a pure audit tool. Safe to run repeatedly.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Argument parsing ───────────────────────────────
const args = process.argv.slice(2);
const opts = {
  dir: null,
  format: 'console',  // console | md | json
  since: null,        // ISO date string
  promote: false,
};
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--dir')       opts.dir = args[++i];
  else if (a === '--format')  opts.format = args[++i];
  else if (a === '--since')   opts.since = args[++i];
  else if (a === '--promote') opts.promote = true;
  else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
}

function printHelp() {
  console.log(`
Apex Revenue — Coach Training Audit

Usage: node scripts/audit-coach-training.js [options]

Options:
  --dir <path>        Directory containing knowledge JSON files to audit.
                      Default: resolves to platform userData/coach-knowledge
                      (Windows: %APPDATA%/Apex Revenue/coach-knowledge)
  --format <type>     Output format: console (default), md, json
  --since <date>      Only include entries created on/after this date (YYYY-MM-DD)
  --promote           Include promotion-candidate templates in the output
  -h, --help          Show this help
`);
}

// ─── Source directory resolution ────────────────────
// Check three places in order:
//   1. --dir if explicitly provided
//   2. Electron userData on this machine (for testing against local install)
//   3. The repo's coach-knowledge-shipped/ as a sanity fallback
function resolveSources() {
  const sources = [];

  // Repo shipped baseline — always audit this
  const shippedDir = path.resolve(__dirname, '..', 'coach-knowledge-shipped');
  if (fs.existsSync(shippedDir)) {
    sources.push({ label: 'shipped-baseline', dir: shippedDir });
  }

  if (opts.dir) {
    sources.push({ label: 'custom', dir: path.resolve(opts.dir) });
    return sources;
  }

  // Default: try this machine's local userData
  const userDataGuesses = [];
  if (process.platform === 'win32') {
    userDataGuesses.push(path.join(process.env.APPDATA || '', 'Apex Revenue', 'coach-knowledge'));
  } else if (process.platform === 'darwin') {
    userDataGuesses.push(path.join(os.homedir(), 'Library', 'Application Support', 'Apex Revenue', 'coach-knowledge'));
  } else {
    userDataGuesses.push(path.join(os.homedir(), '.config', 'Apex Revenue', 'coach-knowledge'));
  }
  for (const g of userDataGuesses) {
    if (fs.existsSync(g)) sources.push({ label: 'local-user', dir: g });
  }

  return sources;
}

// ─── Artifact loading ───────────────────────────────
function loadArtifacts(sources) {
  const artifacts = [];
  for (const src of sources) {
    let files;
    try {
      files = fs.readdirSync(src.dir).filter((f) => f.endsWith('.json'));
    } catch {
      continue;
    }
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(src.dir, f), 'utf8');
        const obj = JSON.parse(raw);
        artifacts.push({
          ...obj,
          filename: f,
          sourceLabel: src.label,
          sourceDir: src.dir,
        });
      } catch (err) {
        console.warn(`[audit] skipping ${f}: ${err.message}`);
      }
    }
  }
  return artifacts;
}

// ─── Filtering ──────────────────────────────────────
function filterBySince(artifacts, sinceStr) {
  if (!sinceStr) return artifacts;
  const sinceTs = Date.parse(sinceStr);
  if (Number.isNaN(sinceTs)) {
    console.warn(`[audit] invalid --since date: ${sinceStr}, ignoring filter`);
    return artifacts;
  }
  return artifacts.filter((a) => (a.ts || 0) >= sinceTs);
}

// ─── Analysis ───────────────────────────────────────
function analyze(artifacts) {
  const shipped = artifacts.filter((a) => a.sourceLabel === 'shipped-baseline');
  const user = artifacts.filter((a) => a.sourceLabel !== 'shipped-baseline');

  // Topic frequency across user artifacts — high-frequency topics are
  // promotion candidates (if multiple users are researching the same
  // thing, it belongs in the baseline)
  const topicCounts = new Map();
  for (const a of user) {
    const t = (a.topic || 'untitled').trim().toLowerCase();
    if (!topicCounts.has(t)) topicCounts.set(t, { count: 0, samples: [] });
    const rec = topicCounts.get(t);
    rec.count += 1;
    if (rec.samples.length < 3) rec.samples.push(a);
  }

  // Promotion candidates: user-researched topics that appear ≥ 2 times
  // OR have high summary-quality markers (decent summary + keyPoints).
  // This is a heuristic — Ridge makes the final call.
  const promotionCandidates = [];
  for (const [topic, rec] of topicCounts) {
    const sample = rec.samples[0];
    const hasGoodContent = sample.summary && sample.summary.length > 100 &&
      Array.isArray(sample.keyPoints) && sample.keyPoints.length >= 3;
    if (rec.count >= 2 || hasGoodContent) {
      promotionCandidates.push({
        topic,
        occurrences: rec.count,
        sampleArtifact: sample,
        reason: rec.count >= 2 ? `researched ${rec.count} times` : 'quality content',
      });
    }
  }
  promotionCandidates.sort((a, b) => b.occurrences - a.occurrences);

  // Shipped coverage — which topics are already in the baseline?
  const shippedTopics = new Set(shipped.map((a) => (a.topic || '').trim().toLowerCase()));
  const gapsInBaseline = [...topicCounts.keys()].filter((t) => !shippedTopics.has(t));

  // Quality signals
  const emptyKeyPoints = user.filter((a) => !Array.isArray(a.keyPoints) || a.keyPoints.length === 0);
  const noSources = user.filter((a) => !Array.isArray(a.sources) || a.sources.length === 0);

  // Age distribution
  const now = Date.now();
  const ageBuckets = { '< 1 week': 0, '1–4 weeks': 0, '1–3 months': 0, '3+ months': 0 };
  const WEEK_MS = 7 * 86400 * 1000;
  for (const a of user) {
    const age = now - (a.ts || now);
    if      (age < WEEK_MS)         ageBuckets['< 1 week']  += 1;
    else if (age < 4 * WEEK_MS)     ageBuckets['1–4 weeks'] += 1;
    else if (age < 13 * WEEK_MS)    ageBuckets['1–3 months'] += 1;
    else                            ageBuckets['3+ months']  += 1;
  }

  return {
    totals: {
      shipped: shipped.length,
      user: user.length,
      all: artifacts.length,
    },
    topicFrequency: [...topicCounts.entries()]
      .map(([topic, rec]) => ({ topic, count: rec.count }))
      .sort((a, b) => b.count - a.count),
    promotionCandidates,
    gapsInBaseline,
    quality: {
      emptyKeyPoints: emptyKeyPoints.length,
      noSources: noSources.length,
    },
    ageBuckets,
    shippedArtifacts: shipped.map((a) => ({
      topic: a.topic,
      filename: a.filename,
      keyPointCount: Array.isArray(a.keyPoints) ? a.keyPoints.length : 0,
    })),
  };
}

// ─── Output formatters ──────────────────────────────
function renderConsole(report, artifacts) {
  const lines = [];
  lines.push('');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('  APEX REVENUE — COACH TRAINING AUDIT');
  lines.push('═══════════════════════════════════════════════════════════════');
  lines.push('');
  lines.push(`  Total artifacts : ${report.totals.all}`);
  lines.push(`    - shipped     : ${report.totals.shipped}`);
  lines.push(`    - user        : ${report.totals.user}`);
  lines.push('');

  if (report.totals.user > 0) {
    lines.push('  User-artifact age distribution:');
    for (const [bucket, count] of Object.entries(report.ageBuckets)) {
      lines.push(`    ${bucket.padEnd(14)} ${count}`);
    }
    lines.push('');
  }

  if (report.topicFrequency.length > 0) {
    lines.push('  Topic frequency (user-added):');
    for (const t of report.topicFrequency.slice(0, 20)) {
      lines.push(`    ${String(t.count).padStart(3)} × ${t.topic}`);
    }
    lines.push('');
  }

  if (report.promotionCandidates.length > 0) {
    lines.push('  ⭐ PROMOTION CANDIDATES — consider moving to coach-knowledge-shipped/');
    for (const c of report.promotionCandidates.slice(0, 10)) {
      lines.push(`    • ${c.topic}`);
      lines.push(`      └─ ${c.reason}`);
    }
    lines.push('');
  } else {
    lines.push('  (no promotion candidates — need more user-research data)');
    lines.push('');
  }

  if (report.quality.emptyKeyPoints > 0 || report.quality.noSources > 0) {
    lines.push('  Quality concerns:');
    lines.push(`    Empty keyPoints : ${report.quality.emptyKeyPoints}`);
    lines.push(`    No sources      : ${report.quality.noSources}`);
    lines.push('');
  }

  lines.push('  Current shipped baseline:');
  for (const a of report.shippedArtifacts) {
    lines.push(`    ✓ ${a.topic}  (${a.keyPointCount} key points)  [${a.filename}]`);
  }
  lines.push('');

  if (opts.promote && report.promotionCandidates.length > 0) {
    lines.push('  ─── Promotion templates (copy into coach-knowledge-shipped/) ───');
    for (const c of report.promotionCandidates.slice(0, 5)) {
      lines.push('');
      lines.push(`  // Promotion candidate: ${c.topic}`);
      const template = buildPromotionTemplate(c.sampleArtifact);
      lines.push(template.split('\n').map((l) => '  ' + l).join('\n'));
    }
    lines.push('');
  }

  return lines.join('\n');
}

function renderMarkdown(report) {
  const lines = [];
  lines.push('# Apex Revenue — Coach Training Audit');
  lines.push('');
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push('');
  lines.push('## Totals');
  lines.push('');
  lines.push(`- All artifacts: ${report.totals.all}`);
  lines.push(`- Shipped baseline: ${report.totals.shipped}`);
  lines.push(`- User-contributed: ${report.totals.user}`);
  lines.push('');
  if (report.topicFrequency.length > 0) {
    lines.push('## Topic frequency (user-contributed)');
    lines.push('');
    lines.push('| Count | Topic |');
    lines.push('| ---: | --- |');
    for (const t of report.topicFrequency.slice(0, 30)) {
      lines.push(`| ${t.count} | ${t.topic} |`);
    }
    lines.push('');
  }
  if (report.promotionCandidates.length > 0) {
    lines.push('## Promotion candidates');
    lines.push('');
    lines.push('Topics that appear repeatedly in user research OR have quality content — consider moving to `coach-knowledge-shipped/` for the next release so all users benefit.');
    lines.push('');
    for (const c of report.promotionCandidates) {
      lines.push(`### ${c.topic}`);
      lines.push('');
      lines.push(`- Reason: ${c.reason}`);
      lines.push(`- Occurrences: ${c.occurrences}`);
      const s = c.sampleArtifact;
      if (s.summary) { lines.push(`- Sample summary: ${s.summary.slice(0, 300)}${s.summary.length > 300 ? '…' : ''}`); }
      lines.push('');
    }
  }
  lines.push('## Shipped baseline');
  lines.push('');
  for (const a of report.shippedArtifacts) {
    lines.push(`- \`${a.filename}\` — **${a.topic}** (${a.keyPointCount} key points)`);
  }
  return lines.join('\n');
}

function buildPromotionTemplate(sample) {
  // Emit a ready-to-commit shipped-artifact JSON skeleton. Ridge
  // reviews and edits before placing in coach-knowledge-shipped/.
  const today = new Date().toISOString().slice(0, 10);
  const slug = (sample.topic || 'promoted')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);

  return JSON.stringify({
    __proposed_filename: `${today}-${slug}.json`,
    topic: sample.topic,
    summary: sample.summary || '',
    keyPoints: sample.keyPoints || [],
    sources: sample.sources || [],
    qualityNote: 'REVIEW — imported from user-research artifacts; verify and edit before shipping',
    ts: Date.now(),
    source: 'shipped',
  }, null, 2);
}

// ─── Main ───────────────────────────────────────────
function main() {
  const sources = resolveSources();
  if (sources.length === 0) {
    console.error('❌ No knowledge sources found. Specify --dir <path> or ensure coach-knowledge-shipped/ exists in the repo root.');
    process.exit(1);
  }

  let artifacts = loadArtifacts(sources);
  const originalCount = artifacts.length;
  artifacts = filterBySince(artifacts, opts.since);

  const report = analyze(artifacts);

  // Header: where did we look?
  if (opts.format !== 'json') {
    console.error('Sources audited:');
    for (const s of sources) console.error(`  ${s.label}: ${s.dir}`);
    console.error(`Loaded: ${artifacts.length} of ${originalCount} artifacts${opts.since ? ` (--since ${opts.since} filter applied)` : ''}`);
  }

  if (opts.format === 'json') {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else if (opts.format === 'md') {
    process.stdout.write(renderMarkdown(report) + '\n');
  } else {
    process.stdout.write(renderConsole(report, artifacts) + '\n');
  }
}

main();
