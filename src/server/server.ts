import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import type { SessionManager } from '../session/manager.js';
import { registerAuth } from './auth.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerHookRoutes } from './routes/hook.js';

export interface BuildServerOptions {
  readonly config: Config;
  readonly manager: SessionManager;
  readonly internalHookToken: string;
  readonly historyRoot?: string;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, disableRequestLogging: true });

  await registerAuth(app, opts.config.tokens, opts.internalHookToken);

  app.get('/healthz', () => ({ ok: true }));

  if (opts.historyRoot === undefined) {
    await registerProjectRoutes(app, opts.config.projects);
  } else {
    await registerProjectRoutes(app, opts.config.projects, opts.historyRoot);
  }
  await registerSessionRoutes(app, opts.config, opts.manager);
  await registerHookRoutes(app, opts.manager);

  app.setErrorHandler((err, _req, reply) => {
    if (reply.statusCode < 400) reply.code(500);
    const message = err instanceof Error ? err.message : 'internal error';
    void reply.send({ error: { code: 'internal', message } });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });

  return app;
}
