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
   * Public URL the web SPA is served from (e.g.
   * "https://ccanywhere.example.com"). Used to derive WebAuthn `rpID` and
   * to validate origin on register/login. Must be a full URL with scheme.
   */
  webOrigin: z
    .string()
    .url('webOrigin must be a full URL with scheme (e.g. https://...)'),
});
export type Config = z.infer<typeof ConfigSchema>;
