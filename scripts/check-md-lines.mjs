#!/usr/bin/env node
/**
 * Markdown line-count guard. Run via `pnpm lint:md`.
 *
 * Threshold: 300 lines per .md file (keeps docs scannable).
 *
 * Usage:
 *   node scripts/check-md-lines.mjs              # scan all tracked .md
 *   node scripts/check-md-lines.mjs FILE [...]   # check given paths only
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const LIMITS = [
  { pattern: /\.md$/, max: 300 },
];

// Phase-1 carve-out for legacy oversized files (cleared in phase 5).
const SKIP_LIST = new Set();

function gatherFiles() {
  if (process.argv.length > 2) return process.argv.slice(2);
  const raw = execSync('git ls-files "*.md"', { encoding: 'utf8' });
  return raw.split('\n').filter((f) => f.length > 0);
}

function limitFor(file) {
  for (const { pattern, max } of LIMITS) {
    if (pattern.test(file)) return max;
  }
  return null;
}

let violations = 0;
for (const file of gatherFiles()) {
  if (SKIP_LIST.has(file)) continue;
  const max = limitFor(file);
  if (max === null) continue;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const lines = raw.split('\n').length;
  if (lines > max) {
    console.error(`${file}:${lines} exceeds ${max}-line limit`);
    violations++;
  }
}

if (violations > 0) {
  console.error(`\n${violations} markdown file(s) exceed line limits`);
  process.exit(1);
}
