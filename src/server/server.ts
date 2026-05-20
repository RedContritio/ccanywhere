import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookiePlugin from '@fastify/cookie';
import staticPlugin from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from '../config/schema.js';
import type { DeviceStore } from '../devices/store.js';
import { logger } from '../log.js';
import { ensureProjectsRoot, ProjectStore } from '../projects/store.js';
import { QuotaWatcher, type QuotaWatcherOptions } from '../quota/watcher.js';
import type { SessionManager } from '../session/manager.js';
import type { TokenStore } from '../tokens/store.js';
import type { UserStore } from '../users/store.js';
import type { User } from '../users/types.js';
import { registerWebSocketRoutes } from '../ws/server.js';
import { registerAuth } from './auth.js';
import { IdempotencyStore } from './idempotency.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerFeedbackRoutes } from './routes/feedback.js';
import { registerInternalRoutes } from './routes/internal.js';
import { registerInternalMultiUserRoutes } from './routes/internal-multi-user.js';
import { registerProjectRoutes, type ProjectRoutesOptions } from './routes/projects.js';
import { registerSessionRoutes } from './routes/sessions.js';
import { registerSessionResumeRoutes } from './routes/sessions-resume.js';
import { registerShareRoutes } from './routes/share.js';
import type { ShareStore } from '../share/store.js';
import { registerHookRoutes } from './routes/hook.js';
import type { SessionContainerDeps } from './routes/session-runtime.js';

export type { SessionContainerDeps } from './routes/session-runtime.js';

/**
 * /healthz isolation reporting payload.
 * `ready: true` ⇔ every user.runtime in config is honored as-is
 * (host-only mode or strict mode with all host users). `ready: false`
 * + reason ⇔ at least one user requested container runtime but the
 * runtime layer doesn't implement it yet — startup would have
 * fataled in current code path, so seeing ready:false in healthz
 * means a future Phase 2 build is in a transitional state.
 */
export interface IsolationStatus {
  readonly mode: 'strict' | 'fallback' | 'host-only';
  readonly ready: boolean;
  readonly reason?: string;
}

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
   *  (#44). Optional during the multi-step rollout — wired to
   * routes in step 3 (auth改造). Once wired, fixtures will need to provide
   * a real instance.
   */
  readonly userStore?: UserStore;
  readonly tokenStore?: TokenStore;
  /**
   * Optional in tests; production wires the real
   * instance from serve.ts. When undefined the share routes simply
   * aren't registered (cleaner than emitting 503s).
   */
  readonly shareStore?: ShareStore;
  readonly internalHookToken: string;
  readonly cliToken: string;
  /**
   * Isolation status snapshot computed by
   * serve.ts at startup, exposed via `/healthz` so admins / monitoring
   * can verify the running mode without parsing logs. Optional for
   * backwards compat — tests that build server without isolation
   * resolution still get `{ ok: true }`.
   */
  readonly isolation?: IsolationStatus;
  /**
   *  C5: effective per-user runtime map from
   * resolveIsolation. Lookup by username; missing = host. sessions.ts
   * + sessions-resume.ts use this to decide host vs container dispatch.
   */
  readonly perUserRuntime?: ReadonlyMap<string, 'host' | 'shared-container'>;
  /**
   *  C5: deps for shared-container session
   * spawn. undefined = no container path available (sessions degrade
   * to host even if perUserRuntime says shared). C6 wires via serve.ts
   * after docker-detect + SharedContainerManager.ensureRunning.
   */
  readonly containerDeps?: SessionContainerDeps;
  /**  D5: host root mapped to per-user ~/.claude in containers; forwarded to QuotaWatcher. */
  readonly userClaudeRoot?: string;
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

  app.get('/healthz', () =>
    opts.isolation !== undefined
      ? { ok: true, isolation: opts.isolation }
      : { ok: true },
  );

  // per-user ProjectStore lazy 构造。owner 复用注入的单例
  // (caller 用 owner override 或默认 <workspace>/owner 构造)；其他 user 在
  // 首次访问时 mkdir + 构造 ProjectStore 落到自己的 root（hidden state
  // 在 <root>/.projects-state.json，root 自包含与 owner state 路径互不嵌套）。
  // req.user 缺失（老 fixture / 未启 multi-user）时退回单例，保持向后兼容。
  const userProjectStores = new Map<string, ProjectStore>();
  const resolveProjectStore = (user: User | undefined): ProjectStore => {
    if (user === undefined || user.kind === 'owner') return opts.projectStore;
    if (opts.userStore === undefined) return opts.projectStore;
    const cached = userProjectStores.get(user.username);
    if (cached !== undefined) return cached;
    const root = opts.userStore.projectsRootFor(user);
    ensureProjectsRoot(root);
    const store = new ProjectStore({
      projectsRoot: root,
      statePath: join(root, '.projects-state.json'),
    });
    userProjectStores.set(user.username, store);
    return store;
  };

  const prOpts: { -readonly [K in keyof ProjectRoutesOptions]: ProjectRoutesOptions[K] } = {};
  if (opts.historyRoot !== undefined) prOpts.historyRoot = opts.historyRoot;
  if (opts.perUserRuntime !== undefined) prOpts.perUserRuntime = opts.perUserRuntime;
  if (opts.userClaudeRoot !== undefined) prOpts.userClaudeRoot = opts.userClaudeRoot;
  if (opts.containerDeps !== undefined) Object.assign(prOpts, { hostWorkspace: opts.containerDeps.hostWorkspace, containerWorkspacePath: opts.containerDeps.containerWorkspacePath });
  await registerProjectRoutes(app, resolveProjectStore, prOpts);
  const idempotencyStore = new IdempotencyStore(opts.idempotencyTtlMs ?? 60 * 60 * 1000);
  app.addHook('onClose', () => {
    idempotencyStore.close();
  });

  type SOpts = { historyRoot?: string; idempotencyStore: IdempotencyStore; userStore?: UserStore; injectCcSessionId?: boolean; perUserRuntime?: ReadonlyMap<string, 'host' | 'shared-container'>; containerDeps?: SessionContainerDeps; userClaudeRoot?: string; };
  const sessionOpts: SOpts = { idempotencyStore };
  if (opts.historyRoot !== undefined) sessionOpts.historyRoot = opts.historyRoot;
  if (opts.userStore !== undefined) sessionOpts.userStore = opts.userStore;
  if (opts.injectCcSessionId !== undefined) sessionOpts.injectCcSessionId = opts.injectCcSessionId;
  if (opts.perUserRuntime !== undefined) sessionOpts.perUserRuntime = opts.perUserRuntime;
  if (opts.containerDeps !== undefined) sessionOpts.containerDeps = opts.containerDeps;
  if (opts.userClaudeRoot !== undefined) sessionOpts.userClaudeRoot = opts.userClaudeRoot;
  await registerSessionRoutes(app, opts.config, opts.manager, resolveProjectStore, sessionOpts);
  const resumeOpts: {
    perUserRuntime?: ReadonlyMap<string, 'host' | 'shared-container'>;
    containerDeps?: SessionContainerDeps;
    userStore?: UserStore;
  } = {};
  if (opts.perUserRuntime !== undefined) resumeOpts.perUserRuntime = opts.perUserRuntime;
  if (opts.containerDeps !== undefined) resumeOpts.containerDeps = opts.containerDeps;
  if (opts.userStore !== undefined) resumeOpts.userStore = opts.userStore;
  await registerSessionResumeRoutes(app, opts.config, opts.manager, resolveProjectStore, resumeOpts);
  if (opts.shareStore !== undefined) {
    await registerShareRoutes(
      app,
      opts.config,
      opts.shareStore,
      opts.manager,
      resolveProjectStore,
    );
  }
  // hook routes only carry state-machine transitions now.
  await registerHookRoutes(app, opts.manager);
  // per-instance QuotaWatcher as SessionManager lifecycle observer.
  let quotaWatcher: QuotaWatcher | undefined;
  if (opts.userStore !== undefined) {
    type QWMut = { -readonly [K in keyof QuotaWatcherOptions]: QuotaWatcherOptions[K] };
    const qwOpts: QWMut = { userStore: opts.userStore };
    if (opts.perUserRuntime !== undefined) qwOpts.perUserRuntime = opts.perUserRuntime;
    if (opts.userClaudeRoot !== undefined) qwOpts.userClaudeRoot = opts.userClaudeRoot;
    if (opts.containerDeps !== undefined) Object.assign(qwOpts, { hostWorkspace: opts.containerDeps.hostWorkspace, containerWorkspacePath: opts.containerDeps.containerWorkspacePath });
    quotaWatcher = new QuotaWatcher(qwOpts);
    opts.manager.setLifecycleObserver(quotaWatcher);
    app.addHook('onClose', () => quotaWatcher?.closeAll());
  }

  await registerWebSocketRoutes(app, opts.manager, {
    heartbeat: opts.config.wsHeartbeat,
    outputFlushIntervalMs: Math.max(1, Math.round(1000 / opts.config.outputFps)),
    ...(opts.userStore !== undefined ? { userStore: opts.userStore } : {}),
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
