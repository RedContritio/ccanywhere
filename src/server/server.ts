import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookiePlugin from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import type { DeviceStore } from '../devices/store.js';
import { logger } from '../log.js';
import type { ProjectStore } from '../projects/store.js';
import type { SessionManager } from '../session/manager.js';
import type { TokenStore } from '../tokens/store.js';
import type { UserStore } from '../users/store.js';
import { registerWebSocketRoutes } from '../ws/server.js';
import { registerAuth } from './auth.js';
import { IdempotencyStore } from './idempotency.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerInternalMultiUserRoutes } from './routes/internal-multi-user.js';
import { registerProjectRoutes } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSessionResumeRoutes } from './routes/sessions-resume.js';
import { registerHookRoutes } from './routes/hook.js';

export interface BuildServerOptions {
  readonly config: Config;
  /**
   * Per-instance state directory (cli-token / devices / projects-state /
   * feedback). Resolved by caller via `resolveConfigDir(config, configPath)`.
   * Optional in tests; falls back to a tmp dir when omitted (then the
   * feedback route writes there too — fine for tests, never for prod).
   */
  readonly configDir?: string | undefined;
  readonly manager: SessionManager;
  readonly projectStore: ProjectStore;
  readonly deviceStore: DeviceStore;
  /**
   * m-multi-user (#44). Optional during the multi-step rollout — wired to
   * routes in step 3 (auth改造). Once wired, fixtures will need to provide
   * a real instance.
   */
  readonly userStore?: UserStore;
  readonly tokenStore?: TokenStore;
  readonly internalHookToken: string;
  readonly cliToken: string;
  readonly historyRoot?: string;
  readonly idempotencyTtlMs?: number;
  /**
   * Override the directory served as the SPA. Defaults to `<repo>/web/dist`
   * resolved relative to this module. Pass `null` to disable static serving
   * (useful in tests that don't want SPA fallback).
   */
  readonly webDistDir?: string | null;
  /**
   * #46 quota: when true (default), `POST /api/sessions` (create mode)
   * appends `--session-id <uuid>` to cc args so cc's jsonl filename
   * matches ccanywhere's SessionInfo.id. Tests that spawn `sh` instead
   * of cc MUST pass `false` — sh rejects `--session-id` as invalid
   * option and the PTY dies before snapshot.
   */
  readonly injectCcSessionId?: boolean;
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
  const serverStartedAt = Date.now();
  const app = Fastify({
    logger: false,
    disableRequestLogging: true,
    forceCloseConnections: true,
    // Trust X-Forwarded-For only when the upstream socket is loopback
    // (frpc terminates TLS on this mac and proxies to 127.0.0.1). Anyone
    // off-host hits via the public origin first, so they can't spoof IPs.
    trustProxy: 'loopback',
  });

  await app.register(cookiePlugin);
  await registerAuth(app, {
    store: opts.deviceStore,
    ...(opts.userStore !== undefined && { userStore: opts.userStore }),
    ...(opts.tokenStore !== undefined && { tokenStore: opts.tokenStore }),
    internalHookToken: opts.internalHookToken,
    cliToken: opts.cliToken,
    cookieName: opts.config.cookieName,
  });
  await registerAuthRoutes(app, {
    store: opts.deviceStore,
    ...(opts.userStore !== undefined && { userStore: opts.userStore }),
    ...(opts.tokenStore !== undefined && { tokenStore: opts.tokenStore }),
    webOrigin: opts.config.webOrigin,
    cookieName: opts.config.cookieName,
  });
  await registerInternalRoutes(app, { store: opts.deviceStore });
  if (opts.userStore !== undefined && opts.tokenStore !== undefined) {
    await registerInternalMultiUserRoutes(app, {
      userStore: opts.userStore,
      tokenStore: opts.tokenStore,
    });
  }
  await registerFeedbackRoutes(app, {
    manager: opts.manager,
    serverStartedAt,
    configDir: opts.configDir,
  });

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
    userStore?: UserStore;
    injectCcSessionId?: boolean;
  } = { idempotencyStore };
  if (opts.historyRoot !== undefined) sessionOpts.historyRoot = opts.historyRoot;
  if (opts.userStore !== undefined) sessionOpts.userStore = opts.userStore;
  if (opts.injectCcSessionId !== undefined) sessionOpts.injectCcSessionId = opts.injectCcSessionId;
  await registerSessionRoutes(app, opts.config, opts.manager, opts.projectStore, sessionOpts);
  await registerSessionResumeRoutes(app, opts.config, opts.manager, opts.projectStore);
  await registerHookRoutes(
    app,
    opts.manager,
    opts.userStore !== undefined ? { userStore: opts.userStore } : {},
  );
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
