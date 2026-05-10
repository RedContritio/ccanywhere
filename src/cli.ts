#!/usr/bin/env node
import { stdout } from 'node:process';
import { runApprove } from './cli/approve.js';
import { runDevices } from './cli/devices.js';
import { runRevoke } from './cli/revoke.js';
import { runServe } from './cli/serve.js';
import { logger } from './log.js';

const HELP = `ccanywhere — cc CLI exposed over the web

usage:
  ccanywhere [serve] [--config <path>]    start the HTTP/WS server (default)
  ccanywhere approve [--config <path>]    interactively approve pending device pair requests
  ccanywhere devices [--config <path>]    list registered devices
  ccanywhere revoke [--config <path>] <device-id>
                                          revoke a device (drops sessions, blocks future logins)
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

void dispatch(process.argv.slice(2)).catch((err: unknown) => {
  logger.fatal({ err }, 'fatal cli error');
  process.exit(1);
});
