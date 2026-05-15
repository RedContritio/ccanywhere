import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ProjectStore} from '../../projects/store.js';
import { ProjectStoreError } from '../../projects/store.js';
import type { User } from '../../users/types.js';
import { listHistory } from '../history.js';

const CreateBodySchema = z.object({
  name: z.string().min(1).max(255),
});

/**
 * m-user-symmetric: caller injects a per-request store resolver instead
 * of a singleton. Owner → server-injected base store (config.users.owner
 * .workspace or default `<workspace>/owner/`); other users → lazy
 * `<workspace>/<username>/` (or per-user override) store (cached in
 * buildServer). req.user undefined falls back to the base store via the
 * resolver, preserving legacy single-user behavior for fixtures and
 * pre-multi-user setups.
 */
export type ResolveProjectStore = (user: User | undefined) => ProjectStore;

export async function registerProjectRoutes(
  app: FastifyInstance,
  resolveStore: ResolveProjectStore,
  historyRoot?: string,
): Promise<void> {
  app.get('/api/projects', (req) => ({
    projects: resolveStore(req.user).list().map((p) => ({
      id: p.id,
      name: p.name,
      cwd: p.cwd,
      modifiedAt: p.modifiedAt,
    })),
  }));

  app.post('/api/projects', async (req, reply) => {
    const parsed = CreateBodySchema.safeParse(req.body);
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
    const store = resolveStore(req.user);
    let project;
    try {
      project = store.create(parsed.data.name);
    } catch (err) {
      if (err instanceof ProjectStoreError) {
        const code = err.message.includes('already exists')
          ? 'already_exists'
          : err.message.includes('no write permission')
            ? 'forbidden'
            : 'invalid_request';
        const status = code === 'already_exists' ? 409 : code === 'forbidden' ? 403 : 400;
        await reply.code(status).send({
          error: { code, message: err.message },
        });
        return;
      }
      throw err;
    }
    await reply.code(201).send({
      id: project.id,
      name: project.name,
      cwd: project.cwd,
      modifiedAt: project.modifiedAt,
    });
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const id = req.params.id;
    const store = resolveStore(req.user);
    if (store.get(id) === null) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'project not found' } });
      return;
    }
    // hide() is idempotent: re-DELETE returns 204 too. Hidden = soft-delete,
    // directory stays on disk; restore by removing id from projects-state.json.
    store.hide(id);
    await reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/history', async (req, reply) => {
    const proj = resolveStore(req.user).get(req.params.id);
    if (!proj) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'project not found' } });
      return;
    }
    const history =
      historyRoot === undefined
        ? await listHistory(proj.cwd)
        : await listHistory(proj.cwd, historyRoot);
    return { history };
  });
}
