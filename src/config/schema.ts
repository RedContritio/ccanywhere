import { z } from 'zod';

export const TokenSchema = z.object({
  label: z.string().min(1),
  token: z.string().min(16),
  createdAt: z.string().datetime().optional(),
  lastUsedAt: z.string().datetime().optional(),
});
export type Token = z.infer<typeof TokenSchema>;

export const ProjectSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9-]*$/, 'project id must be kebab-case'),
  name: z.string().min(1),
  cwd: z.string().min(1),
});
export type Project = z.infer<typeof ProjectSchema>;

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
  tokens: z.array(TokenSchema).min(1, 'at least one token must be configured'),
  projects: z.array(ProjectSchema).min(1, 'at least one project must be configured'),
});
export type Config = z.infer<typeof ConfigSchema>;
