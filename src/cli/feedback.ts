import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdout } from 'node:process';
import { ConfigError, defaultConfigPath, loadConfig } from '../config/loader.js';
import { resolveConfigDir } from '../config/paths.js';

interface FeedbackEnvelope {
  readonly id: string;
  readonly submittedAt: number;
  readonly deviceId?: string;
  readonly deviceLabel?: string;
  readonly title: string;
  readonly body?: string;
  readonly ops?: ReadonlyArray<{ readonly kind: string; readonly payload?: unknown }>;
  readonly diag?: {
    readonly term?: {
      readonly rendererKind?: string;
      readonly fontSize?: number;
      readonly cellWidth?: number;
      readonly cellHeight?: number;
    };
    readonly viewport?: {
      readonly cols?: number;
      readonly rows?: number;
      readonly devicePixelRatio?: number;
    };
    readonly env?: { readonly userAgent?: string };
  };
}

interface FeedbackSummary {
  readonly id: string;
  readonly submittedAt: number;
  readonly title: string;
  readonly device: string;
  readonly opsCount: number;
  readonly errorOpsCount: number;
  readonly verbose: {
    readonly renderer?: string;
    readonly fontSize?: number;
    readonly cols?: number;
    readonly rows?: number;
    readonly dpr?: number;
  };
}

function feedbackDir(configPath: string | undefined): string {
  const path = configPath !== undefined ? resolve(configPath) : defaultConfigPath();
  const config = loadConfig(path);
  const dir = join(resolveConfigDir(config, path), 'feedback');
  if (!existsSync(dir)) {
    throw new ConfigError(`feedback dir does not exist: ${dir}`, path);
  }
  return dir;
}

function listFeedbackFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .reverse(); // newest first (timestamp prefix sorts lexicographically)
}

function readEnvelope(dir: string, fileName: string): FeedbackEnvelope | null {
  const path = join(dir, fileName);
  try {
    const raw = readFileSync(path, 'utf8');
    return JSON.parse(raw) as FeedbackEnvelope;
  } catch {
    return null;
  }
}

function summarize(env: FeedbackEnvelope): FeedbackSummary {
  const ops = env.ops ?? [];
  return {
    id: env.id,
    submittedAt: env.submittedAt,
    title: env.title,
    device: env.deviceLabel ?? env.deviceId?.slice(0, 8) ?? '?',
    opsCount: ops.length,
    errorOpsCount: ops.filter((o) => o.kind.endsWith('.error') || o.kind === 'error').length,
    verbose: {
      ...(env.diag?.term?.rendererKind !== undefined
        ? { renderer: env.diag.term.rendererKind }
        : {}),
      ...(env.diag?.term?.fontSize !== undefined
        ? { fontSize: env.diag.term.fontSize }
        : {}),
      ...(env.diag?.viewport?.cols !== undefined ? { cols: env.diag.viewport.cols } : {}),
      ...(env.diag?.viewport?.rows !== undefined ? { rows: env.diag.viewport.rows } : {}),
      ...(env.diag?.viewport?.devicePixelRatio !== undefined
        ? { dpr: env.diag.viewport.devicePixelRatio }
        : {}),
    },
  };
}

function formatTimeAgo(ts: number, now: number = Date.now()): string {
  const diffSec = Math.round((now - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.round(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.round(diffSec / 3600)}h ago`;
  return `${Math.round(diffSec / 86400)}d ago`;
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s.slice(0, n);
  return s + ' '.repeat(n - s.length);
}

export interface FeedbackListOpts {
  readonly verbose?: boolean;
  readonly json?: boolean;
}

export async function runFeedbackList(
  configPath: string | undefined,
  opts: FeedbackListOpts = {},
): Promise<void> {
  const dir = feedbackDir(configPath);
  const summaries: FeedbackSummary[] = [];
  for (const f of listFeedbackFiles(dir)) {
    const env = readEnvelope(dir, f);
    if (env !== null) summaries.push(summarize(env));
  }

  if (opts.json === true) {
    stdout.write(JSON.stringify(summaries, null, 2) + '\n');
    return;
  }
  if (summaries.length === 0) {
    stdout.write('(no feedback)\n');
    return;
  }
  for (const s of summaries) {
    const head = `${pad(formatTimeAgo(s.submittedAt), 8)} ${pad(s.device, 18)} ${pad(s.id.slice(0, 24), 26)} ${s.title}`;
    if (opts.verbose === true) {
      const v = s.verbose;
      const verboseParts: string[] = [`ops=${s.opsCount}`];
      if (s.errorOpsCount > 0) verboseParts.push(`errors=${s.errorOpsCount}`);
      if (v.renderer !== undefined) verboseParts.push(`renderer=${v.renderer}`);
      if (v.fontSize !== undefined) verboseParts.push(`font=${v.fontSize}`);
      if (v.cols !== undefined && v.rows !== undefined) {
        verboseParts.push(`grid=${v.cols}x${v.rows}`);
      }
      if (v.dpr !== undefined) verboseParts.push(`dpr=${v.dpr}`);
      stdout.write(`${head}\n  ${verboseParts.join(' ')}\n`);
    } else {
      stdout.write(`${head}\n`);
    }
  }
}

export interface FeedbackShowOpts {
  readonly full?: boolean;
}

export async function runFeedbackShow(
  configPath: string | undefined,
  idPrefix: string,
  opts: FeedbackShowOpts = {},
): Promise<void> {
  const dir = feedbackDir(configPath);
  const files = listFeedbackFiles(dir);
  const matches = files.filter((f) => f.includes(idPrefix));
  if (matches.length === 0) {
    stdout.write(`no feedback matching id prefix: ${idPrefix}\n`);
    process.exit(1);
  }
  if (matches.length > 1) {
    stdout.write(
      `multiple feedback matching ${idPrefix}; please disambiguate:\n` +
        matches.map((m) => `  ${m}\n`).join(''),
    );
    process.exit(1);
  }
  const fileName = matches[0];
  if (fileName === undefined) {
    stdout.write(`unreachable: matches[0] missing\n`);
    process.exit(1);
  }
  const env = readEnvelope(dir, fileName);
  if (env === null) {
    stdout.write(`failed to parse: ${fileName}\n`);
    process.exit(1);
  }

  if (opts.full === true) {
    stdout.write(JSON.stringify(env, null, 2) + '\n');
    return;
  }

  // Summary: header + body + key diag + ops kind histogram
  const s = summarize(env);
  stdout.write(
    `id:       ${env.id}\n` +
      `time:     ${new Date(env.submittedAt).toISOString()} (${formatTimeAgo(env.submittedAt)})\n` +
      `device:   ${s.device}\n` +
      `title:    ${env.title}\n`,
  );
  if (env.body !== undefined && env.body.length > 0) {
    stdout.write(`body:\n${env.body.split('\n').map((l) => `  ${l}`).join('\n')}\n`);
  }
  if (env.diag?.term !== undefined) {
    const t = env.diag.term;
    const parts: string[] = [];
    if (t.rendererKind !== undefined) parts.push(`renderer=${t.rendererKind}`);
    if (t.fontSize !== undefined) parts.push(`fontSize=${t.fontSize}`);
    if (t.cellWidth !== undefined && t.cellHeight !== undefined) {
      parts.push(`cell=${t.cellWidth.toFixed(2)}x${t.cellHeight.toFixed(2)}`);
    }
    if (parts.length > 0) stdout.write(`term:     ${parts.join(' ')}\n`);
  }
  if (env.diag?.viewport !== undefined) {
    const v = env.diag.viewport;
    const parts: string[] = [];
    if (v.cols !== undefined && v.rows !== undefined) parts.push(`grid=${v.cols}x${v.rows}`);
    if (v.devicePixelRatio !== undefined) parts.push(`dpr=${v.devicePixelRatio}`);
    if (parts.length > 0) stdout.write(`viewport: ${parts.join(' ')}\n`);
  }
  if (env.diag?.env?.userAgent !== undefined) {
    stdout.write(`ua:       ${env.diag.env.userAgent}\n`);
  }
  // Ops histogram
  const ops = env.ops ?? [];
  if (ops.length > 0) {
    const counts: Record<string, number> = {};
    for (const op of ops) counts[op.kind] = (counts[op.kind] ?? 0) + 1;
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    stdout.write(`ops:      ${ops.length} total\n`);
    for (const [kind, n] of sorted.slice(0, 10)) {
      stdout.write(`  ${pad(kind, 28)} ${n}\n`);
    }
    if (sorted.length > 10) {
      stdout.write(`  ... (${sorted.length - 10} more kinds; --full to dump all)\n`);
    }
  }
}
