import type { FastifyInstance } from 'fastify';
import type { Project } from '../../config/schema.js';
import { listHistory } from '../history.js';

export async function registerProjectRoutes(
  app: FastifyInstance,
  projects: ReadonlyArray<Project>,
  historyRoot?: string,
): Promise<void> {
  app.get('/api/projects', () => ({
    projects: projects.map((p) => ({ id: p.id, name: p.name, cwd: p.cwd })),
  }));

  app.get<{ Params: { id: string } }>('/api/projects/:id/history', async (req, reply) => {
    const proj = projects.find((p) => p.id === req.params.id);
    if (!proj) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'project not found' } });
      return;
    }
    const history =
      historyRoot === undefined ? await listHistory(proj.cwd) : await listHistory(proj.cwd, historyRoot);
    return { history };
  });
}
