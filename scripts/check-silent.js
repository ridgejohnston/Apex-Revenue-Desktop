#!/usr/bin/env node
/**
 * Apex Revenue — Silent-in-Chat CI Check
 *
 * Greps the codebase for chat-selector strings paired with Apex-branded
 * content, which would indicate a regression of the Silent-in-Chat policy.
 *
 * Exit 1 (fail CI) if any violations are found.
 *
 * Run:
 *   node scripts/check-silent.js
 *
 * Wired in .husky/pre-commit and .github/workflows/ci.yml.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_DIRS = ['main', 'preload', 'renderer/src', 'shared'];
const IGNORE = new Set(['node_modules', 'dist', '.git', 'renderer/dist']);

const CHAT_SELECTORS = [
  /\[class\*=["']chat[-_]?input/i,
  /textarea[^)]*chat/i,
  /#chat[-_]?box/i,
  /\.chat[-_]?input/i,
  /data-testid=["']chat-input/i,
  /data-testid=["']send-message/i,
];

const APEX_STRINGS = [
  /apex\s*revenue/i,
  /\[apex\]/i,
  /by\s+apex/i,
  /courtesy\s+of\s+apex/i,
  /apexrevenue\.works/i,
];

const CHAT_COMMANDS = [
  /['"]\s*\/msg\s/,
  /['"]\s*\/tip\s/,
  /['"]\s*\/pm\s/,
];

let violations = 0;

function shouldSkip(p) {
  const rel = path.relative(ROOT, p);
  for (const seg of rel.split(path.sep)) {
    if (IGNORE.has(seg)) return true;
  }
  return false;
}

function walk(dir, visit) {
  if (!fs.existsSync(dir)) return;
  if (shouldSkip(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, visit);
    else if (entry.isFile() && /\.(js|jsx|ts|tsx|mjs|cjs)$/.test(entry.name)) visit(full);
  }
}

function checkFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');

  // Skip this module itself and its CI docs — they naturally reference the
  // patterns they are designed to catch.
  const basename = path.basename(filePath);
  if (basename === 'check-silent.js' || basename === 'browser-view-guard.js') return;

  const lines = content.split('\n');
  lines.forEach((line, i) => {
    const hasChatSelector = CHAT_SELECTORS.some((re) => re.test(line));
    const hasApexBrand    = APEX_STRINGS.some((re) => re.test(line));
    const hasChatCommand  = CHAT_COMMANDS.some((re) => re.test(line));

    // Pattern A: chat selector + apex brand on same line = likely violation.
    if (hasChatSelector && hasApexBrand) {
      console.error(`❌  ${path.relative(ROOT, filePath)}:${i + 1}  chat selector paired with Apex branding`);
      console.error(`    ${line.trim().slice(0, 200)}`);
      violations += 1;
    }

    // Pattern B: chat command + apex brand on same line.
    if (hasChatCommand && hasApexBrand) {
      console.error(`❌  ${path.relative(ROOT, filePath)}:${i + 1}  chat command with Apex branding`);
      console.error(`    ${line.trim().slice(0, 200)}`);
      violations += 1;
    }
  });
}

for (const d of SEARCH_DIRS) walk(path.join(ROOT, d), checkFile);

if (violations > 0) {
  console.error(`\n💥  ${violations} Silent-in-Chat violation${violations === 1 ? '' : 's'} detected.`);
  console.error('    Apex must never write its own branding into a platform\'s chat.');
  console.error('    See docs/SILENT_IN_CHAT.md for the policy.\n');
  process.exit(1);
}
console.log('✓ Silent-in-Chat check clean.');
