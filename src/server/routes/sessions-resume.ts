import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/schema.js';
import { logger } from '../../log.js';
import type { ProjectStore } from '../../projects/store.js';
import type { SessionManager } from '../../session/manager.js';
import { buildResumeArgs } from '../../session/resume-args.js';

const ResumeBodySchema = z.object({
  cols: z.number().int().min(1).optional(),
  rows: z.number().int().min(1).optional(),
  webTheme: z.enum(['dark', 'light']).optional(),
});

function buildThemeEnv(
  webTheme: 'dark' | 'light' | undefined,
): Record<string, string> {
  if (webTheme === undefined) return {};
  return webTheme === 'dark'
    ? { COLORFGBG: '15;0' }
    : { COLORFGBG: '0;15' };
}

/**
 * m-session-persistence C4: two endpoints to drive the dead-stub UX.
 *   POST /api/sessions/:id/resume — spawn a new cc PTY reusing the
 *     original ccanywhere id (= cc jsonl filename) so the conversation
 *     continues from where it left off
 *   GET /api/sessions/:id/screen — text/plain dump of the last visible
 *     frame snapshot persisted at PTY exit; the workspace pane shows
 *     this as a readonly preview until the user clicks Resume
 */
export async function registerSessionResumeRoutes(
  app: FastifyInstance,
  config: Config,
  manager: SessionManager,
  projectStore: ProjectStore,
): Promise<void> {
  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/sessions/:id/resume',
    async (req, reply) => {
      const id = req.params.id;
      const stub = manager.getDeadStub(id);
      const userId = req.user?.id;

      // 404 unless we have a dead stub the caller owns. Active rows
      // (manager.get returns defined) reach a different 409 path below.
      if (stub === undefined) {
        if (manager.get(id) !== undefined) {
          await reply.code(409).send({
            error: { code: 'already_active', message: 'session is alive; refresh' },
          });
          return;
        }
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'session not found' } });
        return;
      }
      if (userId !== undefined && stub.info.userId !== userId) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'session not found' } });
        return;
      }
      if (stub.deletedAt !== null) {
        await reply.code(409).send({
          error: { code: 'soft_deleted', message: 'session is soft-deleted' },
        });
        return;
      }

      const parsed = ResumeBodySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
        return;
      }

      const project = projectStore.get(stub.info.projectId);
      if (!project) {
        await reply
          .code(404)
          .send({ error: { code: 'project_gone', message: 'owning project was removed' } });
        return;
      }

      const resumeInput = { webId: id, resumeSessionId: stub.info.resumeSessionId };
      const themeEnv = buildThemeEnv(parsed.data.webTheme);
      try {
        const result = manager.resumeDeadStub(id, {
          command: config.claudeBin,
          args: buildResumeArgs(resumeInput),
          scrollbackBytes: config.scrollbackBytes,
          ...(parsed.data.cols !== undefined ? { cols: parsed.data.cols } : {}),
          ...(parsed.data.rows !== undefined ? { rows: parsed.data.rows } : {}),
          ...(Object.keys(themeEnv).length > 0 ? { env: themeEnv } : {}),
        });

        if (result.kind === 'attached') {
          await reply.code(200).send({
            id: result.existingId,
            projectId: stub.info.projectId,
            mode: 'resume',
            resumeSessionId: id,
            state: 'idle',
            createdAt: stub.info.createdAt,
            deletedAt: null,
          });
          return;
        }
        await reply.code(201).send({
          id: result.session.info.id,
          projectId: result.session.info.projectId,
          mode: result.session.info.mode,
          resumeSessionId: result.session.info.resumeSessionId ?? id,
          state: result.session.state,
          createdAt: result.session.info.createdAt,
          deletedAt: result.session.deletedAt,
        });
      } catch (err) {
        // Per D4: resume spawn failure surfaces as 5xx + log; session
        // stays dead so the user can retry or delete.
        logger.error({ err, id }, 'resume spawn failed');
        await reply.code(500).send({
          error: {
            code: 'resume_failed',
            message: err instanceof Error ? err.message : 'spawn failed',
          },
        });
      }
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/sessions/:id/screen',
    async (req, reply) => {
      const id = req.params.id;
      const stub = manager.getDeadStub(id);
      const userId = req.user?.id;
      if (stub === undefined) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'no snapshot' } });
        return;
      }
      if (userId !== undefined && stub.info.userId !== userId) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'no snapshot' } });
        return;
      }
      await reply
        .header('content-type', 'text/plain; charset=utf-8')
        .code(200)
        .send(stub.lastScreen);
    },
  );
}
