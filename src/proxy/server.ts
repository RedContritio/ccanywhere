import Fastify, { type FastifyInstance } from 'fastify';
import type { OwnerCredentials } from './credentials.js';
import { type ForwardDeps, registerForwardRoutes } from './forward.js';

/**
 * Forward route dependencies sans credentials — buildProxyServer
 * injects credentials from its own opts (single source). C3+ omitted
 * ⇒ /v1/messages stays unregistered (404).
 */
export type ForwardOptions = Omit<ForwardDeps, 'credentials'>;

export interface BuildProxyOptions {
  /**
   * Owner's upstream API credentials. `null` ⇒ start in 503 mode
   * (D5: missing credentials file is non-fatal; admin can configure
   * later without proxy crash-loop, but all forward routes return 503
   * until credentials arrive).
   */
  readonly credentials: OwnerCredentials | null;
  /**
   * Forward route deps. Omit ⇒ /v1/messages stays unregistered (404
   * from setNotFoundHandler). Credentials null also disables
   * registration even if `forward` is provided — degraded mode wins.
   */
  readonly forward?: ForwardOptions;
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

  // C3+: register forward routes only when credentials AND forward deps
  // are both present. Either missing ⇒ degraded mode (404 on /v1/*).
  if (opts.credentials !== null && opts.forward !== undefined) {
    registerForwardRoutes(app, {
      ...opts.forward,
      credentials: opts.credentials,
    });
  }

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
