import { randomUUID } from 'node:crypto';
import { sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/schema.js';
import { logger } from '../../log.js';
import type { Session, SessionManager, SpawnOptions } from '../../session/manager.js';
import type { UserStore } from '../../users/store.js';
import { listHistory, resolveHistoryScope } from '../history.js';
import type { IdempotencyStore} from '../idempotency.js';
import { hashBody, isValidIdempotencyKey } from '../idempotency.js';
import type { ResolveProjectStore } from './projects.js';
import {
  buildSessionRuntimeOverlay,
  buildThemeEnv,
  type SessionContainerDeps,
} from './session-runtime.js';

export interface SessionRoutesOptions {
  readonly historyRoot?: string;
  readonly idempotencyStore?: IdempotencyStore;
  /** m-multi-user: optional during step-4 rollout; required once wired. */
  readonly userStore?: UserStore;
  /**
   * #46: when true (default), append `--session-id <uuid>` to cc args in
   * create mode so cc-id == ccanywhere-id. Tests using `sh` MUST pass
   * `false` because sh rejects `--session-id`.
   */
  readonly injectCcSessionId?: boolean;
  /**
   * m-user-shared-container C5: effective per-user runtime (from
   * resolveIsolation). Lookup by username; missing = host.
   */
  readonly perUserRuntime?: ReadonlyMap<string, 'host' | 'shared-container'>;
  /**
   * m-user-shared-container C5: shared container + token issuer +
   * user-sync deps for shared-container path. undefined ⇒ host-only
   * even when perUserRuntime says container.
   */
  readonly containerDeps?: SessionContainerDeps;
  /** m-host-credentials-share B26: per-user claudeRoot for resume listHistory. */
  readonly userClaudeRoot?: string;
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

export async function registerSessionRoutes(
  app: FastifyInstance,
  config: Config,
  manager: SessionManager,
  resolveStore: ResolveProjectStore,
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
    // m-user-symmetric: per-user store resolution. cwd guard 仍保留作
    // defense-in-depth — store 隔离已是 first line。
    const project = resolveStore(req.user).get(body.projectId);
    if (project && options.userStore !== undefined && req.user !== undefined) {
      const root = options.userStore.projectsRootFor(req.user);
      if (!isWithinSubtree(project.cwd, root)) {
        await sendErr(403, 'forbidden', 'project cwd not in user projects root');
        return;
      }
    }
    if (!project) {
      await sendErr(404, 'not_found', 'project not found');
      return;
    }

    // #46 quota: in create mode, pre-generate the session uuid and pass it
    // to cc via `--session-id <uuid>` so that cc writes its jsonl as
    // `<uuid>.jsonl` — same id as ccanywhere's SessionInfo.id. This lets
    // the quota hook locate the jsonl deterministically. Resume mode reuses
    // cc's existing jsonl (named after the resumed cc id), so we don't
    // force a new --session-id there.
    const args: string[] = [];
    let forcedSessionId: string | undefined;
    if (body.mode === 'resume') {
      // B26: shared-container cc writes jsonl under encoded CONTAINER cwd; translate.
      const u = req.user?.username;
      const ha = resolveHistoryScope({ username: u, hostCwd: project.cwd, runtime: u !== undefined ? options.perUserRuntime?.get(u) ?? 'host' : 'host', userClaudeRoot: options.userClaudeRoot, hostWorkspace: options.containerDeps?.hostWorkspace, containerWorkspacePath: options.containerDeps?.containerWorkspacePath, defaultHistoryRoot: options.historyRoot });
      const history = ha.historyRoot === undefined ? await listHistory(ha.cwd) : await listHistory(ha.cwd, ha.historyRoot);
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
    } else if (options.injectCcSessionId !== false) {
      forcedSessionId = randomUUID();
      args.push('--session-id', forcedSessionId);
    }

    const themeEnv = buildThemeEnv(body.webTheme);
    const userId = req.user?.id ?? 'legacy-no-user';
    // m-user-shared-container C5+D9: host vs shared-container dispatch.
    const overlay = await buildSessionRuntimeOverlay(
      req.user, options.perUserRuntime, options.containerDeps, themeEnv, project.cwd,
    );
    const baseSpawn = {
      projectId: project.id,
      cwd: project.cwd,
      command: overlay.command ?? config.claudeBin,
      args,
      scrollbackBytes: config.scrollbackBytes,
      mode: body.mode,
      userId,
      ...(forcedSessionId !== undefined ? { forcedSessionId } : {}),
      ...(overlay.env !== undefined ? { env: overlay.env } : {}),
      ...(overlay.runtime !== undefined ? { runtime: overlay.runtime } : {}),
      ...(overlay.container !== undefined ? { container: overlay.container } : {}),
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
    // m-session-persistence: DELETE must work for both active sessions
    // and dead stubs (user purging a row left over from a prior restart).
    // findRow merges both maps; manager.markDeleted dispatches to the
    // right path (kill PTY for active, just-stamp + persist for dead).
    const row = manager.findRow(req.params.id);
    if (!row) {
      logger.debug({ id: req.params.id }, 'delete session: not found');
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    // m-multi-user: only the owning user may DELETE.
    if (req.user !== undefined && row.info.userId !== req.user.id) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    manager.markDeleted(req.params.id);
    logger.debug(
      { id: req.params.id, deviceId: req.authDevice?.id },
      'session deleted',
    );
    await reply.code(204).send();
  });
}
