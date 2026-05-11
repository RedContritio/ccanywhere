#!/usr/bin/env node
import { stdout } from 'node:process';
import { runApprove } from './cli/approve.js';
import { runDevices } from './cli/devices.js';
import { runFeedbackList, runFeedbackShow } from './cli/feedback.js';
import { runRevoke } from './cli/revoke.js';
import { runServe } from './cli/serve.js';
import { runTokenIssue, runTokenList, runTokenRevoke } from './cli/token.js';
import { runUserCreate, runUserList, runUserQuotaSet } from './cli/user.js';
import { logger } from './log.js';

function parseTtlToMs(s: string): number {
  const m = /^(\d+)([smhd])$/.exec(s);
  if (!m) throw new Error(`invalid ttl: ${s} (expected e.g. 7d, 24h, 30m, 60s)`);
  const v = Number.parseInt(m[1]!, 10);
  switch (m[2]) {
    case 's':
      return v * 1000;
    case 'm':
      return v * 60 * 1000;
    case 'h':
      return v * 60 * 60 * 1000;
    case 'd':
      return v * 24 * 60 * 60 * 1000;
    default:
      throw new Error(`unreachable`);
  }
}

function consumeFlag(args: string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) {
      const v = args[i + 1];
      args.splice(i, 2);
      return v;
    }
  }
  return undefined;
}

function consumeBoolFlag(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i < 0) return false;
  args.splice(i, 1);
  return true;
}

function parseQuotaArg(s: string | undefined): number | null | undefined {
  if (s === undefined) return undefined;
  if (s === 'null' || s === 'none') return null;
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) throw new Error(`invalid quota value: ${s}`);
  return n;
}

const HELP = `ccanywhere — cc CLI exposed over the web

usage:
  ccanywhere [serve] [--config <path>]    start the HTTP/WS server (default)
  ccanywhere approve [--config <path>]    interactively approve pending device pair requests
  ccanywhere devices [--config <path>]    list registered devices
  ccanywhere revoke [--config <path>] <device-id>
                                          revoke a device (drops sessions, blocks future logins)
  ccanywhere feedback list [--verbose] [--json]
                                          list submitted feedback (newest first)
  ccanywhere feedback show <id-prefix> [--full]
                                          show one feedback (summary by default; --full = pretty JSON)
  ccanywhere help                         show this help

Multi-instance same-host deployments (e.g. prod + staging) just hand each
instance its own config.json via --config; per-instance state files
(cli-token, devices.json, projects-state.json, feedback/) live next to
the config (or wherever \`configDir\` in the config points).

Default config: ~/.config/ccanywhere/config.json (or $CCANYWHERE_CONFIG /
$XDG_CONFIG_HOME/ccanywhere/config.json if either env var is set).
`;

interface ParsedArgs {
  readonly cmd: string;
  readonly configPath: string | undefined;
  readonly positional: ReadonlyArray<string>;
}

/**
 * Pulls `--config <path>` (or `--config=<path>`) out of argv regardless
 * of where it sits relative to the subcommand name. Treats anything else
 * as positional. Subcommand is the first non-flag positional, or 'serve'
 * by default. Keep this hand-rolled — pulling in commander/yargs for two
 * options pays for itself never.
 */
function parseArgs(argv: ReadonlyArray<string>): ParsedArgs {
  const positional: string[] = [];
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '--config' || a === '-c') {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('-')) {
        stdout.write(`--config requires a path argument\n`);
        process.exit(2);
      }
      configPath = next;
      i++;
      continue;
    }
    if (a.startsWith('--config=')) {
      configPath = a.slice('--config='.length);
      continue;
    }
    positional.push(a);
  }
  const cmd = positional[0] ?? 'serve';
  return { cmd, configPath, positional: positional.slice(1) };
}

async function dispatch(argv: ReadonlyArray<string>): Promise<void> {
  const { cmd, configPath, positional } = parseArgs(argv);
  switch (cmd) {
    case 'serve':
      return runServe(configPath);
    case 'approve':
      return runApprove(configPath);
    case 'devices':
      return runDevices(configPath);
    case 'revoke':
      return runRevoke(positional[0], configPath);
    case 'user':
      return runUserSubcommand([...positional], configPath);
    case 'token':
      return runTokenSubcommand([...positional], configPath);
    case 'feedback':
      return runFeedbackSubcommand([...positional], configPath);
    case 'help':
    case '--help':
    case '-h':
      stdout.write(HELP);
      return;
    default:
      stdout.write(`unknown subcommand: ${cmd}\n\n${HELP}`);
      process.exit(2);
  }
}

async function runUserSubcommand(args: string[], configPath: string | undefined): Promise<void> {
  const sub = args.shift();
  if (sub === 'create') {
    const username = args.shift();
    if (username === undefined) {
      stdout.write(`usage: ccanywhere user create <username> [--ttl 7d] [--cost-usd N] [--tokens N]\n`);
      process.exit(2);
    }
    const ttl = consumeFlag(args, '--ttl') ?? '7d';
    const cost = parseQuotaArg(consumeFlag(args, '--cost-usd'));
    const tokens = parseQuotaArg(consumeFlag(args, '--tokens'));
    const costLimitUsd = cost === undefined ? null : cost;
    const tokensLimit = tokens === undefined ? null : tokens === null ? null : Math.trunc(tokens);
    return runUserCreate(configPath, {
      username,
      ttlMs: parseTtlToMs(ttl),
      costLimitUsd,
      tokensLimit,
    });
  }
  if (sub === 'list') return runUserList(configPath);
  if (sub === 'quota') {
    const sub2 = args.shift();
    if (sub2 !== 'set') {
      stdout.write(`usage: ccanywhere user quota set <username> [--cost-usd N] [--tokens N] [--reset]\n`);
      process.exit(2);
    }
    const username = args.shift();
    if (username === undefined) {
      stdout.write(`usage: ccanywhere user quota set <username> [--cost-usd N] [--tokens N] [--reset]\n`);
      process.exit(2);
    }
    const cost = parseQuotaArg(consumeFlag(args, '--cost-usd'));
    const tokens = parseQuotaArg(consumeFlag(args, '--tokens'));
    const reset = consumeBoolFlag(args, '--reset');
    return runUserQuotaSet(configPath, {
      username,
      ...(cost !== undefined ? { costLimitUsd: cost } : {}),
      ...(tokens !== undefined
        ? { tokensLimit: tokens === null ? null : Math.trunc(tokens) }
        : {}),
      ...(reset ? { reset: true } : {}),
    });
  }
  stdout.write(`unknown user subcommand: ${sub ?? '(missing)'}\n`);
  process.exit(2);
}

async function runTokenSubcommand(args: string[], configPath: string | undefined): Promise<void> {
  const sub = args.shift();
  if (sub === 'issue') {
    const username = args.shift();
    if (username === undefined) {
      stdout.write(`usage: ccanywhere token issue <username> [--ttl 7d] [--label <s>]\n`);
      process.exit(2);
    }
    const ttl = consumeFlag(args, '--ttl') ?? '7d';
    const label = consumeFlag(args, '--label') ?? null;
    return runTokenIssue(configPath, {
      username,
      ttlMs: parseTtlToMs(ttl),
      label,
    });
  }
  if (sub === 'list') {
    const username = consumeFlag(args, '--user');
    return runTokenList(configPath, username);
  }
  if (sub === 'revoke') {
    const tokenId = args.shift();
    if (tokenId === undefined) {
      stdout.write(`usage: ccanywhere token revoke <token-id>\n`);
      process.exit(2);
    }
    return runTokenRevoke(configPath, tokenId);
  }
  stdout.write(`unknown token subcommand: ${sub ?? '(missing)'}\n`);
  process.exit(2);
}

async function runFeedbackSubcommand(args: string[], configPath: string | undefined): Promise<void> {
  const sub = args.shift();
  if (sub === 'list') {
    const verbose = consumeBoolFlag(args, '--verbose') || consumeBoolFlag(args, '-v');
    const json = consumeBoolFlag(args, '--json');
    return runFeedbackList(configPath, {
      ...(verbose ? { verbose: true } : {}),
      ...(json ? { json: true } : {}),
    });
  }
  if (sub === 'show') {
    const idPrefix = args.shift();
    if (idPrefix === undefined) {
      stdout.write(`usage: ccanywhere feedback show <id-prefix> [--full]\n`);
      process.exit(2);
    }
    const full = consumeBoolFlag(args, '--full');
    return runFeedbackShow(configPath, idPrefix, { ...(full ? { full: true } : {}) });
  }
  stdout.write(`unknown feedback subcommand: ${sub ?? '(missing)'}\n`);
  process.exit(2);
}

void dispatch(process.argv.slice(2)).catch((err: unknown) => {
  logger.fatal({ err }, 'fatal cli error');
  process.exit(1);
});
