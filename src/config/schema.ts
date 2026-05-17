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
   * Absolute path to the parent directory of every user's project root
   * (m-user-symmetric). Each user's project root defaults to
   * `<workspace>/<username>/`; an optional `users.<name>.workspace`
   * override (absolute path) supersedes the default for that user. Created
   * (mode 0700) at startup if missing.
   *
   * Replaces the legacy `projectsRoot` (owner-only) +
   * `guestProjectsRoot` (limited-only) pair.
   */
  workspace: z.string().min(1, 'workspace must be set'),
  /**
   * Per-user configuration. Currently only `workspace` override (absolute
   * path) is recognized. owner override is optional — when absent, owner
   * uses the default `<workspace>/owner/` and a startup warning prompts
   * the operator to set it explicitly if they want to point at an
   * existing project repository.
   */
  users: z
    .record(
      z.string().min(1),
      z.object({
        workspace: z.string().optional(),
      }),
    )
    .optional(),
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
  /**
   * m-anthropic-proxy. ccanywhere-anthropic-proxy listen address.
   * Independent process (own LaunchAgent). user containers (Phase 2)
   * point `ANTHROPIC_BASE_URL` here; owner path 完全不经此代理 (D7).
   * Defaults let existing prod config files load without a bump.
   */
  proxy: z
    .object({
      port: z.number().int().min(1).max(65535).default(62276),
      bindHost: z.string().default('127.0.0.1'),
    })
    .default({ port: 62276, bindHost: '127.0.0.1' }),
}).superRefine((cfg, ctx) => {
  // Per-user `workspace` override checks (m-user-symmetric):
  //   1. absolute path
  //   2. any two overrides MUST NOT nest
  //   3. an override MUST NOT collide with `<workspace>/<other-username>`
  //      (would shadow another user's default root)
  if (cfg.users === undefined) return;
  const ws = resolve(cfg.workspace);
  const wsSep = ws.endsWith(sep) ? ws : ws + sep;

  const overrides: Array<{ username: string; absPath: string }> = [];
  for (const [username, userCfg] of Object.entries(cfg.users)) {
    if (userCfg.workspace === undefined) continue;
    const abs = userCfg.workspace;
    // Path absoluteness check via path.resolve fixed-point: an absolute path
    // resolves to itself; a relative path becomes <cwd>/<...>.
    if (resolve(abs) !== abs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `users.${username}.workspace must be an absolute path`,
        path: ['users', username, 'workspace'],
      });
      continue;
    }
    overrides.push({ username, absPath: abs });
  }

  for (const { username, absPath } of overrides) {
    const overrideSep = absPath.endsWith(sep) ? absPath : absPath + sep;
    // Default-collision: override must not point inside <workspace>/<other>/
    // for any other user (covers `<ws>/<username>` for self too — pinning
    // the override to your own default is harmless but oddly redundant; we
    // tolerate it).
    if (overrideSep.startsWith(wsSep)) {
      const tail = absPath.slice(ws.length).replace(/^[\\/]+/, '');
      const firstSeg = tail.split(sep)[0] ?? '';
      if (firstSeg.length > 0 && firstSeg !== username) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `users.${username}.workspace points inside default user slot ` +
            `<workspace>/${firstSeg}/ — would shadow that user's default root`,
          path: ['users', username, 'workspace'],
        });
      }
    }
  }

  // Pairwise nesting check across overrides.
  for (let i = 0; i < overrides.length; i++) {
    for (let j = i + 1; j < overrides.length; j++) {
      const ovI = overrides[i];
      const ovJ = overrides[j];
      if (ovI === undefined || ovJ === undefined) continue;
      const a = ovI.absPath.endsWith(sep) ? ovI.absPath : ovI.absPath + sep;
      const b = ovJ.absPath.endsWith(sep) ? ovJ.absPath : ovJ.absPath + sep;
      if (a === b) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `users.${ovI.username}.workspace and users.${ovJ.username}.workspace ` +
            `MUST differ`,
          path: ['users', ovJ.username, 'workspace'],
        });
        continue;
      }
      if (a.startsWith(b) || b.startsWith(a)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `users.${ovI.username}.workspace and users.${ovJ.username}.workspace ` +
            `MUST NOT nest`,
          path: ['users', ovJ.username, 'workspace'],
        });
      }
    }
  }
});
export type Config = z.infer<typeof ConfigSchema>;
