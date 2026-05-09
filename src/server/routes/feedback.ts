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

const FeedbackBodySchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().max(10_000).optional(),
  ops: z.array(OpSchema).max(100).optional(),
  diag: DiagSchema.optional(),
});

function feedbackDir(): string {
  return join(homedir(), '.config', 'ccanywhere', 'feedback');
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
    const dir = feedbackDir();
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
