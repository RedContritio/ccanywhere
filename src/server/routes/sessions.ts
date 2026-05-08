import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../../config/schema.js';
import type { SessionManager, SpawnOptions } from '../../session/manager.js';

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
): Promise<void> {
  app.get('/api/sessions', () => ({
    sessions: manager.list().map((s) => ({
      id: s.info.id,
      projectId: s.info.projectId,
      mode: s.info.mode,
      resumeSessionId: s.info.resumeSessionId ?? null,
      state: s.state,
      createdAt: s.info.createdAt,
    })),
  }));

  app.post('/api/sessions', async (req, reply) => {
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
    const body = parsed.data;
    const project = config.projects.find((p) => p.id === body.projectId);
    if (!project) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'project not found' } });
      return;
    }

    const args: string[] = [];
    if (body.mode === 'resume') {
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

    await reply.code(201).send({
      id: session.info.id,
      projectId: session.info.projectId,
      mode: session.info.mode,
      resumeSessionId: session.info.resumeSessionId ?? null,
      state: session.state,
      createdAt: session.info.createdAt,
    });
  });

  app.delete<{ Params: { id: string } }>('/api/sessions/:id', async (req, reply) => {
    const session = manager.get(req.params.id);
    if (!session) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }
    await session.kill();
    await reply.code(204).send();
  });
}
