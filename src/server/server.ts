import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import { logger } from '../log.js';
import type { ProjectStore } from '../projects/store.js';
import type { SessionManager } from '../session/manager.js';
import { registerWebSocketRoutes } from '../ws/server.js';
import { registerAuth } from './auth.js';
import { IdempotencyStore } from './idempotency.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerHookRoutes } from './routes/hook.js';

export interface BuildServerOptions {
  readonly config: Config;
  readonly manager: SessionManager;
  readonly projectStore: ProjectStore;
  readonly internalHookToken: string;
  readonly historyRoot?: string;
  readonly idempotencyTtlMs?: number;
  /**
   * Override the directory served as the SPA. Defaults to `<repo>/web/dist`
   * resolved relative to this module. Pass `null` to disable static serving
   * (useful in tests that don't want SPA fallback).
   */
  readonly webDistDir?: string | null;
}

function defaultWebDistDir(): string | null {
  // Candidates ordered by likelihood:
  // 1. cwd/web/dist  — production: launchd / systemd sets WorkingDirectory to repo root
  // 2. <cli.js>/../web/dist  — bundled output: dist/cli.js → repo/web/dist
  // 3. <server.ts>/../../web/dist  — dev (tsx): src/server/server.ts → repo/web/dist
  const candidates = [
    resolve(process.cwd(), 'web/dist'),
    resolve(fileURLToPath(import.meta.url), '../../web/dist'),
    resolve(fileURLToPath(import.meta.url), '../../../web/dist'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

export async function buildServer(opts: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    forceCloseConnections: true,
  });

  await registerAuth(app, opts.config.tokens, opts.internalHookToken);

  app.get('/healthz', () => ({ ok: true }));

  if (opts.historyRoot === undefined) {
    await registerProjectRoutes(app, opts.projectStore);
  } else {
    await registerProjectRoutes(app, opts.projectStore, opts.historyRoot);
  }
  const idempotencyStore = new IdempotencyStore(opts.idempotencyTtlMs ?? 60 * 60 * 1000);
  app.addHook('onClose', () => {
    idempotencyStore.close();
  });

  const sessionOpts: {
    historyRoot?: string;
    idempotencyStore: IdempotencyStore;
  } = { idempotencyStore };
  if (opts.historyRoot !== undefined) sessionOpts.historyRoot = opts.historyRoot;
  await registerSessionRoutes(app, opts.config, opts.manager, opts.projectStore, sessionOpts);
  await registerHookRoutes(app, opts.manager);
  await registerWebSocketRoutes(app, opts.manager, {
    heartbeat: opts.config.wsHeartbeat,
    outputFlushIntervalMs: Math.max(1, Math.round(1000 / opts.config.outputFps)),
  });

  const webDist =
    opts.webDistDir === null
      ? null
      : (opts.webDistDir ?? defaultWebDistDir());
  if (webDist !== null) {
    await app.register(staticPlugin, {
      root: webDist,
      prefix: '/',
    });
    logger.info({ webDist }, 'serving SPA from web/dist');
  }

  app.setErrorHandler((err, _req, reply) => {
    if (reply.statusCode < 400) reply.code(500);
    const message = err instanceof Error ? err.message : 'internal error';
    void reply.send({ error: { code: 'internal', message } });
  });

  app.setNotFoundHandler((req, reply) => {
    // SPA fallback: any GET that isn't /api/* or /ws/* and isn't a file in
    // web/dist gets the SPA's index.html so client-side routing can take over.
    if (
      webDist !== null &&
      req.method === 'GET' &&
      !req.url.startsWith('/api/') &&
      !req.url.startsWith('/ws/') &&
      !req.url.startsWith('/healthz')
    ) {
      void reply.sendFile('index.html', webDist);
      return;
    }
    void reply.code(404).send({ error: { code: 'not_found', message: 'route not found' } });
  });

  return app;
}
