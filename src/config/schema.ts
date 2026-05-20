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
  port: z.number().int().min(1).max(65535).default(8081),
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
   * Each user's project root defaults to
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
        /**
         * user's runtime sandbox.
         * - `host`: spawn with owner identity on the mac (admin-
         *   trusted). owner MUST be 'host' (D3).
         * - `shared-container` (default): reflects Phase 2 direction;
         *   rejected in Phase 1.B with explicit error pointing at fix.
         *   Phase 2 implements actual container
         *   spawn. Default reflects target architecture rather than
         *   既有 behavior — admin must explicitly opt to `host` to
         *   keep existing multi-user prod working (D2 amended; see
         *   archive proposal C4 amendment).
         * - `isolated-container`: reserved schema enum; rejected at
         *   parse time (Phase 1 and Phase 2 both don't implement —
         *   needed only for truly untrusted users, BACKLOG long-term).
         */
        runtime: z
          .enum(['host', 'shared-container', 'isolated-container'])
          .default('shared-container'),
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
   * need a schema-bump migration ( D3).
   */
  shareTtlMs: z.number().int().positive().optional(),
  /**
   * ccanywhere-anthropic-proxy listen address.
   * Independent process (own LaunchAgent). user containers (Phase 2)
   * point `ANTHROPIC_BASE_URL` here; owner path 完全不经此代理 (D7).
   * Defaults let existing prod config files load without a bump.
   */
  proxy: z
    .object({
      port: z.number().int().min(1).max(65535).default(8082),
      bindHost: z.string().default('127.0.0.1'),
    })
    .default({ port: 8082, bindHost: '127.0.0.1' }),
  /**
   *  D3: host root directory containing per-user
   * `~/.claude` state (jsonl history under `<root>/<username>/projects/`,
   * settings.json + CLAUDE.md per-user). SharedContainerManager mounts
   * this single root into the container at
   * `/var/lib/ccanywhere/user-claude` (rw); ContainerUserSync.ensureUser
   * mkdirs per-user sub-dirs (chmod 0700 chown <uid>:<gid>) on demand.
   * Defaulted so existing prod configs load without a bump; absolute
   * paths are recommended (relative paths resolve against process cwd).
   * macOS docker desktop note: bind mount inode perms are not enforced
   * (see proposal D4 / spike-results P9 Step A) — inter-user fs
   * isolation under macOS depends on the D2 trust model, not chmod.
   */
  userClaudeRoot: z.string().optional(),
  /**
   * Three-tier isolation policy:
   * - `strict`: per-user `runtime` honored; any non-owner configured
   *   with container runtime causes startup fatal (Phase 2 not ready).
   *   Fail-safe default — owner must explicitly opt into degraded
   *   isolation.
   * - `fallback`: docker availability detection (Phase 2 only) would
   *   degrade to host on detection failure. Phase 1.B equivalent to
   *   strict (no detection yet).
   * - `host-only`: all non-owner user.runtime override 'host' with
   *   audit warn. Use for windows / single-tenant / docker-unavailable
   *   environments.
   */
  isolationPolicy: z
    .enum(['strict', 'fallback', 'host-only'])
    .default('strict'),
}).superRefine((cfg, ctx) => {
  // Reject `runtime: 'isolated-container'` at
  // parse time — schema accepts the enum for forward-compat but no
  // phase implements it. Caller gets a clear message at config load
  // instead of a confused fatal at serve.ts.
  if (cfg.users !== undefined) {
    for (const [username, userCfg] of Object.entries(cfg.users)) {
      if (userCfg.runtime === 'isolated-container') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            `users.${username}.runtime: 'isolated-container' is ` +
            `reserved (Phase 1/2 don't implement). Use 'host' or ` +
            `'shared-container'.`,
          path: ['users', username, 'runtime'],
        });
      }
    }
  }

  // Per-user `workspace` override checks:
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
