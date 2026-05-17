import Fastify, { type FastifyInstance } from 'fastify';
import type { OwnerCredentials } from './credentials.js';

export interface BuildProxyOptions {
  /**
   * Owner's upstream API credentials. `null` ⇒ start in 503 mode
   * (D5: missing credentials file is non-fatal; admin can configure
   * later without proxy crash-loop, but all forward routes return 503
   * until credentials arrive).
   */
  readonly credentials: OwnerCredentials | null;
}

export async function buildProxyServer(
  opts: BuildProxyOptions,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 10 * 1024 * 1024, // spike F2: claude requests can hit ~150KB+
    disableRequestLogging: true,
    forceCloseConnections: true,
    trustProxy: 'loopback',
  });

  const mode: 'ready' | 'degraded' =
    opts.credentials === null ? 'degraded' : 'ready';

  // spike F5: claude startup hits `HEAD /` as endpoint reachability probe.
  // Always return 200 regardless of mode (probe predates auth).
  app.head('/', (_req, reply) => {
    void reply.code(200).send();
  });

  app.get('/healthz', () => ({ ok: true, mode }));

  app.setErrorHandler((err, _req, reply) => {
    if (reply.statusCode < 400) reply.code(500);
    const message = err instanceof Error ? err.message : 'internal error';
    void reply.send({ error: { code: 'internal', message } });
  });

  app.setNotFoundHandler((_req, reply) => {
    void reply.code(404).send({
      error: { code: 'not_found', message: 'route not implemented' },
    });
  });

  return app;
}
