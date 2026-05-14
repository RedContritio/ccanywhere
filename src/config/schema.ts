import { resolve, sep } from 'node:path';
import { z } from 'zod';

export const WsHeartbeatSchema = z
  .object({
    intervalMs: z.number().int().min(1_000).default(30_000),
    timeoutMs: z.number().int().min(2_000).default(60_000),
  })
  .default({ intervalMs: 30_000, timeoutMs: 60_000 })
  .refine((v) => v.timeoutMs > v.intervalMs, {
    message: 'wsHeartbeat.timeoutMs must be strictly greater than intervalMs',
  });
export type WsHeartbeat = z.infer<typeof WsHeartbeatSchema>;

export const ConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(62275),
  bindHost: z.string().default('127.0.0.1'),
  claudeBin: z.string().default('claude'),
  scrollbackBytes: z.number().int().min(64 * 1024).default(1024 * 1024),
  deletedSessionTtlMs: z.number().int().min(60_000).default(600_000),
  wsHeartbeat: WsHeartbeatSchema,
  /**
   * Upper bound on PTY output frame rate over WebSocket. Each session's
   * trailing-flush window equals 1000/outputFps ms. Lower fps = fewer
   * frames + more batching (good for very thin links); higher fps = more
   * responsive (good for local / fat links). Leading-edge first-byte
   * flush is unaffected — keyboard echo always immediate.
   */
  outputFps: z.number().int().min(1).max(240).default(60),
  /**
   * Absolute path to a directory whose direct subdirectories are exposed
   * as projects. Created at startup if missing; readable and (preferably)
   * writable. Replaces the old `projects[]` array config.
   */
  projectsRoot: z.string().min(1, 'projectsRoot must be set'),
  /**
   * Absolute path to the parent directory under which each limited user
   * gets `<guestProjectsRoot>/<username>/` as their project sandbox
   * (m-multi-user). MUST differ from and MUST NOT nest with `projectsRoot`
   * — owner uses `projectsRoot`, limited users use this. Created (mode
   * 0700) at startup if missing.
   */
  guestProjectsRoot: z.string().min(1, 'guestProjectsRoot must be set'),
  /**
   * Public URL the web SPA is served from (e.g.
   * "https://ccanywhere.example.com"). Used to derive WebAuthn `rpID` and
   * to validate origin on register/login. Must be a full URL with scheme.
   */
  webOrigin: z
    .string()
    .url('webOrigin must be a full URL with scheme (e.g. https://...)'),
  /**
   * Cookie name for the session credential. Default 'ccanywhere_session'.
   * Override only when running multiple instances on the same domain (RFC
   * 6265 cookies ignore port — same-host different-port instances would
   * otherwise overwrite each other's cookies). Staging instance running
   * on a different port (e.g. cc.example.com:7443) MUST set this to
   * something distinct (e.g. 'ccanywhere_session_e2e') to avoid evicting
   * the user's prod session cookie.
   */
  cookieName: z.string().min(1).default('ccanywhere_session'),
  /**
   * Optional. Where this instance keeps its per-instance state files
   * (cli-token, devices.json, projects-state.json, feedback/). When
   * unset, falls back to the directory containing this config file —
   * so dropping `config.json` in a fresh dir is enough to spin up an
   * isolated instance. Set explicitly when state should live somewhere
   * other than the config file's home (rare).
   */
  configDir: z.string().optional(),
  /**
   * Optional TTL (ms) for shared session HTML exports. Default 7d
   * applied in the route handler when unset; explicit body `ttlMs:
   * null` on POST /api/share bypasses both this default and the
   * per-share cap. Kept optional so existing prod config files don't
   * need a schema-bump migration (m-share-static-export D3).
   */
  shareTtlMs: z.number().int().positive().optional(),
}).superRefine((cfg, ctx) => {
  const a = resolve(cfg.projectsRoot);
  const b = resolve(cfg.guestProjectsRoot);
  if (a === b) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'projectsRoot and guestProjectsRoot must differ',
      path: ['guestProjectsRoot'],
    });
    return;
  }
  const aWithSep = a.endsWith(sep) ? a : a + sep;
  const bWithSep = b.endsWith(sep) ? b : b + sep;
  if (aWithSep.startsWith(bWithSep) || bWithSep.startsWith(aWithSep)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'projectsRoot and guestProjectsRoot must not nest',
      path: ['guestProjectsRoot'],
    });
  }
});
export type Config = z.infer<typeof ConfigSchema>;
