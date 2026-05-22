#!/usr/bin/env node
// One-shot admin script — bypass POST /api/share (which needs a cookie
// from a real browser login) by calling ShareStore + renderShareHtml
// directly. Picks an existing session's jsonl and mints a share so the
// dev (you) can open the public URL in a fresh incognito.
//
// Usage: pnpm tsx scripts/mint-share.mjs <sessionId>
// or: pnpm tsx scripts/mint-share.mjs (auto-pick first session)

import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { renderShareHtml } from '../src/share/render.js';
import { ShareStore } from '../src/share/store.js';
import { generateShareCode } from '../src/share/code.js';
import { loadConfig, defaultConfigPath } from '../src/config/loader.js';
import { ccJsonlPathOf } from '../src/quota/path.js';

const configPath = defaultConfigPath();
const config = loadConfig(configPath);
const configDir =
  config.configDir ?? join(homedir(), '.config', 'ccanywhere');

const sessionsDir = join(configDir, 'sessions');
const files = readdirSync(sessionsDir).filter((f) => f.endsWith('.json'));

let sessionId = process.argv[2];
if (sessionId === undefined) {
  if (files.length === 0) {
    console.error('No sessions found in', sessionsDir);
    process.exit(1);
  }
  sessionId = files[0].slice(0, -5);
  console.error('No sessionId given; picking first:', sessionId);
}

const meta = JSON.parse(
  readFileSync(join(sessionsDir, `${sessionId}.json`), 'utf8'),
);
const ccId = meta.resumeSessionId ?? meta.id;
const jsonlPath = ccJsonlPathOf(meta.cwd, ccId);
const jsonl = readFileSync(jsonlPath, 'utf8');

const code = generateShareCode();
const projectName = meta.projectId; // 简化 - 直接用 projectId 当 displayed name
const createdBy = 'admin-mint'; // 标记 script-minted
const createdAt = Date.now();

const html = renderShareHtml({
  jsonl,
  projectName,
  createdBy,
  createdAt,
  shareCode: code,
});

const store = new ShareStore(join(configDir, 'shares'));
await store.save(
  {
    code,
    sessionId: meta.id,
    createdBy,
    createdAt,
    expiresAt: null,
    projectName,
  },
  html,
);

const origin = config.webOrigin.replace(/\/$/, '');
console.log('share code:', code);
console.log('share url :', `${origin}/share/${code}`);
console.log('jsonl lines used:', jsonl.split('\n').filter(Boolean).length);
