import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { logger } from '../../log.js';
import type { SessionManager } from '../../session/manager.js';
import { getCommitSha } from '../version.js';

const OpSchema = z.object({
  ts: z.number().int(),
  kind: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown()).optional(),
});

// `diag` is a free-form blob whose shape is owned by the client. We only
// strongly validate `activeSessionId` because the server uses it to look
// up session state. Other diag fields (viewport / net / app / ws / term /
// memory) ride through with a passthrough record so client and server can
// evolve diag schema independently without breaking validation.
const DiagSchema = z
  .object({
    activeSessionId: z.string().optional(),
  })
  .passthrough();

// Runaway-input guard only. The real bound on submission size is the
// client ring (web/src/state/ops-log.ts `MAX_OPS`, currently derived
// from a 60s retention window × 90 ev/s × 1.2 headroom ≈ 6500). We set
// this an order of magnitude above that so legitimate submissions
// never hit 400, and bumping the client constant doesn't require
// touching this schema in lockstep — only fast-paced abuse trips it.
const FEEDBACK_OPS_RUNAWAY_GUARD = 20_000;
const FeedbackBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional(),
  ops: z.array(OpSchema).max(FEEDBACK_OPS_RUNAWAY_GUARD).optional(),
  diag: DiagSchema.optional(),
});

/**
 * Where feedback JSON files land. Caller (`buildServer`) injects via
 * deps.configDir, which is resolved from the loaded config (see
 * `src/config/paths.ts` `resolveConfigDir`). Falls back to the historical
 * `~/.config/ccanywhere/feedback` only when unset — production wiring
 * always passes configDir, so the fallback is exercised only in tests
 * that don't care about feedback file location.
 */
function feedbackDir(configDir: string | undefined): string {
  const base = configDir ?? join(homedir(), '.config', 'ccanywhere');
  return join(base, 'feedback');
}

function makeFeedbackId(): string {
  // ISO timestamp + 4 random bytes; lexicographically sorted by time which
  // makes `ls feedback/` chronological without extra index.
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = randomBytes(4).toString('hex');
  return `${ts}-${suffix}`;
}

export interface FeedbackRoutesDeps {
  readonly manager: SessionManager;
  readonly serverStartedAt: number;
  /**
   * Per-instance state directory, used to derive `<configDir>/feedback/`
   * for persisted records. Optional in tests (falls back to
   * ~/.config/ccanywhere/feedback). Production wiring sets it from
   * `resolveConfigDir(config, configPath)` so prod / staging instances
   * write to fully separate directories.
   */
  readonly configDir?: string | undefined;
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
  deps: FeedbackRoutesDeps,
): Promise<void> {
  app.post('/api/feedback', async (req, reply) => {
    const parsed = FeedbackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'body validation failed',
          issues: parsed.error.issues,
        },
      });
      return;
    }

    const id = makeFeedbackId();
    const dir = feedbackDir(deps.configDir);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const diag = parsed.data.diag;
    const activeSessionId = diag?.activeSessionId;
    const session =
      typeof activeSessionId === 'string' ? deps.manager.get(activeSessionId) : undefined;

    const record: Record<string, unknown> = {
      id,
      submittedAt: Date.now(),
      deviceId: req.authDevice?.id ?? null,
      deviceLabel: req.authDevice?.label ?? null,
      title: parsed.data.title,
      body: parsed.data.body ?? '',
      ops: parsed.data.ops ?? [],
      userAgent: req.headers['user-agent'] ?? null,
      remoteAddr: req.ip,
      serverInfo: {
        commitSha: getCommitSha(),
        uptimeMs: Date.now() - deps.serverStartedAt,
      },
    };
    if (diag !== undefined) record['diag'] = diag;
    if (session !== undefined) {
      record['serverSession'] = {
        state: session.state,
        headSeq: session.scrollback.headSeq,
        tailSeq: session.scrollback.tailSeq,
        scrollbackBytes: session.scrollback.bytes,
        lastDataAt: session.lastDataAt,
        exitCode: session.exitCode,
        deletedAt: session.deletedAt,
        // Every PTY chunk since session spawn (ts/len/head-32-bytes-hex)
        // so cc's full streaming behavior is cross-referenceable with
        // client trace. Append-only — feedback payload grows with
        // session age, deal with it if a session ever bloats too far.
        recentDataChunks: session.recentDataChunks,
      };
    }

    const path = join(dir, `${id}.json`);
    try {
      writeFileSync(path, JSON.stringify(record, null, 2), { mode: 0o600 });
    } catch (err) {
      logger.error({ err, path }, 'failed to persist feedback');
      await reply.code(500).send({
        error: { code: 'internal', message: 'failed to persist feedback' },
      });
      return;
    }

    logger.info(
      {
        id,
        deviceId: record['deviceId'],
        title: record['title'],
        activeSessionId: activeSessionId ?? null,
        sessionMatched: session !== undefined,
      },
      'feedback received',
    );
    await reply.code(201).send({ id });
  });
}
