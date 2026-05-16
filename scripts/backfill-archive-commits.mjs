#!/usr/bin/env node
// Scan openspec/archive/<date>-<slug>/, for each slug find git commits
// whose subject/body mention the slug (prefix-safe: slug must not be
// followed by [a-zA-Z0-9-] to avoid matching longer slugs that share
// this slug as a prefix), and append a `## Commits` section to tasks.md.
// Idempotent: skips archives that already have `## Commits` heading.

import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ARCHIVE_DIR = 'openspec/archive';
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}-/;

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const entries = readdirSync(ARCHIVE_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && DATE_PREFIX.test(e.name))
  .sort((a, b) => a.name.localeCompare(b.name));

let withCommits = 0;
let empty = 0;
let skipped = 0;
let missingTasks = 0;

for (const entry of entries) {
  const dir = join(ARCHIVE_DIR, entry.name);
  const slug = entry.name.replace(DATE_PREFIX, '');
  const tasksPath = join(dir, 'tasks.md');

  let content;
  try {
    content = readFileSync(tasksPath, 'utf8');
  } catch {
    missingTasks += 1;
    console.log(`[skip:no-tasks] ${entry.name}`);
    continue;
  }

  if (/^## Commits$/m.test(content)) {
    skipped += 1;
    console.log(`[skip:already-has] ${entry.name}`);
    continue;
  }

  let raw = '';
  try {
    raw = execFileSync(
      'git',
      ['log', '--all', '--format=%h%x09%s', `--grep=${slug}`],
      { encoding: 'utf8' },
    );
  } catch (err) {
    console.error(`[err:git-log] ${entry.name}: ${err.message}`);
    continue;
  }

  const boundaryRe = new RegExp(`(?<![a-zA-Z0-9-])${escapeRegex(slug)}(?![a-zA-Z0-9-])`);
  const commits = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t');
      return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
    })
    .filter((c) => boundaryRe.test(c.subject));

  const lines = ['', '## Commits', ''];
  if (commits.length === 0) {
    lines.push('- (no matching commits found in git log)');
    empty += 1;
    console.log(`[add:empty] ${entry.name}`);
  } else {
    for (const c of commits) lines.push(`- ${c.hash} ${c.subject}`);
    withCommits += 1;
    console.log(`[add:${commits.length}] ${entry.name}`);
  }

  const suffix = content.endsWith('\n') ? '' : '\n';
  writeFileSync(tasksPath, content + suffix + lines.join('\n') + '\n');
}

console.log('---');
console.log(`with commits: ${withCommits}`);
console.log(`empty (no match): ${empty}`);
console.log(`skipped (already had ## Commits): ${skipped}`);
console.log(`no tasks.md: ${missingTasks}`);
console.log(`total archives scanned: ${entries.length}`);
