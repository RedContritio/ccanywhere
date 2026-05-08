import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/schema.js';
import type { SessionManager, SpawnOptions } from '../../session/manager.js';
import { listHistory } from '../history.js';
import { hashBody, IdempotencyStore, isValidIdempotencyKey } from '../idempotency.js';

export interface SessionRoutesOptions {
  readonly historyRoot?: string;
  readonly idempotencyStore?: IdempotencyStore;
}

const CreateBodySchema = z.discriminatedUnion('mode', [
  z.object({
    projectId: z.string().min(1),
    mode: z.literal('fresh'),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
  }),
  z.object({
    projectId: z.string().min(1),
    mode: z.literal('resume'),
    sessionId: z.string().min(1),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
  }),
]);

export async function registerSessionRoutes(
  app: FastifyInstance,
  config: Config,
  manager: SessionManager,
  options: SessionRoutesOptions = {},
): Promise<void> {
  app.get('/api/sessions', () => ({
    sessions: manager.list().map((s) => ({
      id: s.info.id,
      projectId: s.info.projectId,
      mode: s.info.mode,
      resumeSessionId: s.info.resumeSessionId ?? null,
      state: s.state,
      createdAt: s.info.createdAt,
      deletedAt: s.deletedAt,
    })),
  }));

  app.post('/api/sessions', async (req, reply) => {
    const idempotencyKey = (() => {
      const h = req.headers['idempotency-key'];
      if (typeof h === 'string') return h;
      if (Array.isArray(h) && typeof h[0] === 'string') return h[0];
      return null;
    })();

    if (idempotencyKey !== null && !isValidIdempotencyKey(idempotencyKey)) {
      await reply.code(400).send({
        error: {
          code: 'invalid_idempotency_key',
          message: 'Idempotency-Key must match /^[A-Za-z0-9_-]{1,255}$/',
        },
      });
      return;
    }

    const store = options.idempotencyStore;
    const scope = req.authTokenLabel ?? '';
    const bodyHash = idempotencyKey !== null ? hashBody(req.body) : '';

    if (idempotencyKey !== null && store) {
      const result = store.lookup(scope, idempotencyKey, bodyHash);
      if (result.kind === 'replay') {
        void reply
          .code(result.status)
          .header('idempotency-replayed', 'true')
          .send(result.body);
        return;
      }
      if (result.kind === 'conflict') {
        await reply.code(409).send({
          error: {
            code: 'idempotency_conflict',
            message: 'Idempotency-Key reused with a different request body',
          },
        });
        return;
      }
    }

    const parsed = CreateBodySchema.safeParse(req.body);
    if (!parsed.success) {
      const errBody = {
        error: {
          code: 'invalid_request',
          message: 'body validation failed',
          issues: parsed.error.issues,
        },
      };
      if (idempotencyKey !== null && store) {
        store.store(scope, idempotencyKey, bodyHash, 400, errBody);
        void reply
          .code(400)
          .header('idempotency-stored', 'true')
          .send(errBody);
      } else {
        await reply.code(400).send(errBody);
      }
      return;
    }
    const body = parsed.data;
    const project = config.projects.find((p) => p.id === body.projectId);
    if (!project) {
      const errBody = { error: { code: 'not_found', message: 'project not found' } };
      if (idempotencyKey !== null && store) {
        store.store(scope, idempotencyKey, bodyHash, 404, errBody);
        void reply
          .code(404)
          .header('idempotency-stored', 'true')
          .send(errBody);
      } else {
        await reply.code(404).send(errBody);
      }
      return;
    }

    const args: string[] = [];
    if (body.mode === 'resume') {
      const history =
        options.historyRoot === undefined
          ? await listHistory(project.cwd)
          : await listHistory(project.cwd, options.historyRoot);
      const known = history.some((h) => h.sessionId === body.sessionId);
      if (!known) {
        const errBody = {
          error: {
            code: 'invalid_resume',
            message: `unknown sessionId for project ${project.id}: ${body.sessionId}`,
          },
        };
        if (idempotencyKey !== null && store) {
          store.store(scope, idempotencyKey, bodyHash, 400, errBody);
          void reply
            .code(400)
            .header('idempotency-stored', 'true')
            .send(errBody);
        } else {
          await reply.code(400).send(errBody);
        }
        return;
      }
      args.push('--resume', body.sessionId);
    }

    const baseSpawn = {
      projectId: project.id,
      cwd: project.cwd,
      command: config.claudeBin,
      args,
      scrollbackBytes: config.scrollbackBytes,
      mode: body.mode,
    };
    const withSize: Pick<SpawnOptions, 'cols' | 'rows'> = {
      ...(body.cols !== undefined ? { cols: body.cols } : {}),
      ...(body.rows !== undefined ? { rows: body.rows } : {}),
    };
    const withResume =
      body.mode === 'resume' ? { resumeSessionId: body.sessionId } : {};

    const session = manager.spawn({ ...baseSpawn, ...withSize, ...withResume });

    const responseBody = {
      id: session.info.id,
      projectId: session.info.projectId,
      mode: session.info.mode,
      resumeSessionId: session.info.resumeSessionId ?? null,
      state: session.state,
      createdAt: session.info.createdAt,
      deletedAt: session.deletedAt,
    };

    if (idempotencyKey !== null && store) {
      store.store(scope, idempotencyKey, bodyHash, 201, responseBody);
      void reply
        .code(201)
        .header('idempotency-stored', 'true')
        .send(responseBody);
    } else {
      await reply.code(201).send(responseBody);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = manager.get(req.params.id);
    if (!session) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    // markDeleted is idempotent: re-DELETE on the same id returns 204 too,
    // and the session row is preserved with deletedAt set.
    session.markDeleted();
    await reply.code(204).send();
  });
}
