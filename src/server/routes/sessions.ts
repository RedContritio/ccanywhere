import { sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/schema.js';
import { logger } from '../../log.js';
import type { ProjectStore } from '../../projects/store.js';
import type { Session, SessionManager, SpawnOptions } from '../../session/manager.js';
import type { UserStore } from '../../users/store.js';
import { listHistory } from '../history.js';
import type { IdempotencyStore} from '../idempotency.js';
import { hashBody, isValidIdempotencyKey } from '../idempotency.js';

export interface SessionRoutesOptions {
  readonly historyRoot?: string;
  readonly idempotencyStore?: IdempotencyStore;
  /** m-multi-user: optional during step-4 rollout; required once wired. */
  readonly userStore?: UserStore;
}

function isWithinSubtree(child: string, parent: string): boolean {
  if (child === parent) return true;
  const parentWithSep = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(parentWithSep);
}

const CreateBodySchema = z.discriminatedUnion('mode', [
  z.object({
    projectId: z.string().min(1),
    mode: z.literal('create'),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
    webTheme: z.enum(['dark', 'light']).optional(),
  }),
  z.object({
    projectId: z.string().min(1),
    mode: z.literal('resume'),
    sessionId: z.string().min(1),
    cols: z.number().int().min(1).optional(),
    rows: z.number().int().min(1).optional(),
    webTheme: z.enum(['dark', 'light']).optional(),
  }),
]);

/**
 * Build env vars to override on the spawned cc process. Currently only
 * COLORFGBG, which cc reads when its `theme` setting is `"auto"` to pick
 * dark vs light. Format is `<fg>;<bg>` (ANSI color indices); bg=0 means
 * black (=> dark theme), bg=15 means white (=> light theme).
 *
 * cc still falls back to its `~/.claude/settings.json` `theme` field if
 * that's not set to "auto", so users have to opt in once. See README.
 */
function buildThemeEnv(webTheme: 'dark' | 'light' | undefined): Record<string, string> {
  if (webTheme === undefined) return {};
  return webTheme === 'dark'
    ? { COLORFGBG: '15;0' }
    : { COLORFGBG: '0;15' };
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  config: Config,
  manager: SessionManager,
  projectStore: ProjectStore,
  options: SessionRoutesOptions = {},
): Promise<void> {
  app.get('/api/sessions', (req) => {
    const userId = req.user?.id;
    const all = manager.list();
    // m-multi-user: filter by req.user.id once userStore wired; pre-wiring
    // (userId undefined) returns all (legacy / test fixtures).
    const filtered = userId === undefined ? all : all.filter((s) => s.info.userId === userId);
    return {
      sessions: filtered.map((s) => ({
        id: s.info.id,
        projectId: s.info.projectId,
        mode: s.info.mode,
        resumeSessionId: s.info.resumeSessionId ?? null,
        state: s.state,
        createdAt: s.info.createdAt,
        deletedAt: s.deletedAt,
      })),
    };
  });

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
    const scope = req.authDevice?.id ?? req.authTokenLabel ?? '';
    const bodyHash = idempotencyKey !== null ? hashBody(req.body) : '';

    const sendErr = async (code: number, errCode: string, message: string): Promise<void> => {
      const errBody = { error: { code: errCode, message } };
      if (idempotencyKey !== null && store) {
        store.store(scope, idempotencyKey, bodyHash, code, errBody);
        void reply.code(code).header('idempotency-stored', 'true').send(errBody);
      } else {
        await reply.code(code).send(errBody);
      }
    };

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
      await sendErr(400, 'invalid_request', 'body validation failed');
      return;
    }
    const body = parsed.data;
    const project = projectStore.get(body.projectId);
    // m-multi-user: cwd must live inside the user's effective projectsRoot.
    if (project && options.userStore !== undefined && req.user !== undefined) {
      const root = options.userStore.projectsRootFor(req.user, config.projectsRoot);
      if (!isWithinSubtree(project.cwd, root)) {
        await sendErr(403, 'forbidden', 'project cwd not in user projects root');
        return;
      }
    }
    if (!project) {
      await sendErr(404, 'not_found', 'project not found');
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
        await sendErr(
          400,
          'invalid_resume',
          `unknown sessionId for project ${project.id}: ${body.sessionId}`,
        );
        return;
      }
      args.push('--resume', body.sessionId);
    }

    const themeEnv = buildThemeEnv(body.webTheme);
    const userId = req.user?.id ?? 'legacy-no-user';
    const baseSpawn = {
      projectId: project.id,
      cwd: project.cwd,
      command: config.claudeBin,
      args,
      scrollbackBytes: config.scrollbackBytes,
      mode: body.mode,
      userId,
      ...(Object.keys(themeEnv).length > 0 ? { env: themeEnv } : {}),
    };
    const withSize: Pick<SpawnOptions, 'cols' | 'rows'> = {
      ...(body.cols !== undefined ? { cols: body.cols } : {}),
      ...(body.rows !== undefined ? { rows: body.rows } : {}),
    };
    const withResume =
      body.mode === 'resume' ? { resumeSessionId: body.sessionId } : {};

    const spawnResult = manager.spawn({ ...baseSpawn, ...withSize, ...withResume });

    // 200 attach (idempotent resume of an already-active cc-X) vs 201
    // created (spawned a new cc process). Body schema is identical; only
    // the status code distinguishes "attached existing" from "newly created".
    // See openspec/specs/sessions/spec.md "resume 唯一性".
    let session: Session;
    let responseStatus: 200 | 201;
    if (spawnResult.kind === 'attached') {
      const existing = manager.get(spawnResult.existingId);
      if (existing === undefined) {
        // Single-threaded invariant: activeResumeTargets stays consistent
        // with manager.sessions. If we hit this, something has been
        // mutated out-of-band — bail loudly rather than silently mis-route.
        await reply.code(500).send({
          error: {
            code: 'internal',
            message: `resume target ${spawnResult.existingId} missing from manager`,
          },
        });
        return;
      }
      session = existing;
      responseStatus = 200;
    } else {
      session = spawnResult.session;
      responseStatus = 201;
    }

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
      store.store(scope, idempotencyKey, bodyHash, responseStatus, responseBody);
      void reply
        .code(responseStatus)
        .header('idempotency-stored', 'true')
        .send(responseBody);
    } else {
      await reply.code(responseStatus).send(responseBody);
    }
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = manager.get(req.params.id);
    if (!session) {
      logger.debug({ id: req.params.id }, 'delete session: not found');
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    // m-multi-user: only the owning user may DELETE.
    if (req.user !== undefined && session.info.userId !== req.user.id) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    // markDeleted is idempotent: re-DELETE on the same id returns 204 too,
    // and the session row is preserved with deletedAt set.
    session.markDeleted();
    logger.debug(
      { id: req.params.id, deviceId: req.authDevice?.id },
      'session deleted',
    );
    await reply.code(204).send();
  });
}
