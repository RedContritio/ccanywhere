import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TokenStoreError, type TokenStore } from '../../tokens/store.js';
import { UserStoreError, type UserStore } from '../../users/store.js';

export interface InternalMultiUserRoutesOptions {
  readonly userStore: UserStore;
  readonly tokenStore: TokenStore;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

const CreateUserBodySchema = z.object({
  username: z.string().min(1).max(64),
  ttlMs: z.number().int().min(1).max(SEVEN_DAYS_MS),
  quota: z
    .object({
      cost: z.object({ limitUsd: z.number().min(0).nullable() }).optional(),
      tokens: z.object({ limit: z.number().int().min(0).nullable() }).optional(),
    })
    .optional(),
});

const PatchQuotaSchema = z.object({
  cost: z.number().min(0).nullable().optional(),
  tokens: z.number().int().min(0).nullable().optional(),
  reset: z.boolean().optional(),
});

const IssueTokenSchema = z.object({
  userId: z.string().min(1),
  ttlMs: z.number().int().min(1).max(SEVEN_DAYS_MS),
  label: z.string().max(64).nullable().optional(),
});

/**
 * m-multi-user (#44) internal routes for user + token CRUD. Mounted alongside
 * `registerInternalRoutes` (device/pending) — both rely on the cliToken bearer
 * gate in `server/auth.ts`.
 */
export async function registerInternalMultiUserRoutes(
  app: FastifyInstance,
  opts: InternalMultiUserRoutesOptions,
): Promise<void> {
  const { userStore, tokenStore } = opts;

  app.get('/api/internal/users', async (_req, reply) => {
    const users = userStore.list().map((u) => ({
      id: u.id,
      username: u.username,
      kind: u.kind,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
      quota: u.quota,
    }));
    await reply.send({ users });
  });

  app.post('/api/internal/users', async (req, reply) => {
    const parsed = CreateUserBodySchema.safeParse(req.body);
    if (!parsed.success) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const { username, ttlMs, quota } = parsed.data;
    try {
      const user = userStore.createLimitedUser({
        username,
        costLimitUsd: quota?.cost?.limitUsd ?? null,
        tokensLimit: quota?.tokens?.limit ?? null,
      });
      const issued = tokenStore.issue({ userId: user.id, ttlMs });
      await reply.code(201).send({
        user: { id: user.id, username: user.username, kind: user.kind },
        tokenId: issued.token.id,
        token: issued.plaintext,
        expiresAt: issued.token.expiresAt,
      });
    } catch (err) {
      if (err instanceof UserStoreError || err instanceof TokenStoreError) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: err.message } });
        return;
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/internal/users/:id/quota',
    async (req, reply) => {
      const parsed = PatchQuotaSchema.safeParse(req.body);
      if (!parsed.success) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
        return;
      }
      try {
        const updated = userStore.setQuotaLimit(req.params.id, {
          ...(parsed.data.cost !== undefined ? { costLimitUsd: parsed.data.cost } : {}),
          ...(parsed.data.tokens !== undefined ? { tokensLimit: parsed.data.tokens } : {}),
          ...(parsed.data.reset !== undefined ? { reset: parsed.data.reset } : {}),
        });
        await reply.send({ user: { id: updated.id, quota: updated.quota } });
      } catch (err) {
        if (err instanceof UserStoreError) {
          await reply
            .code(400)
            .send({ error: { code: 'invalid_request', message: err.message } });
          return;
        }
        throw err;
      }
    },
  );

  app.get<{ Querystring: { userId?: string } }>(
    '/api/internal/tokens',
    async (req, reply) => {
      const tokens = tokenStore.list(req.query.userId).map((t) => ({
        id: t.id,
        userId: t.userId,
        label: t.label,
        createdAt: t.createdAt,
        expiresAt: t.expiresAt,
        status: t.status,
      }));
      await reply.send({ tokens });
    },
  );

  app.post('/api/internal/tokens', async (req, reply) => {
    const parsed = IssueTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    try {
      const issued = tokenStore.issue({
        userId: parsed.data.userId,
        ttlMs: parsed.data.ttlMs,
        ...(parsed.data.label !== undefined ? { label: parsed.data.label } : {}),
      });
      await reply.code(201).send({
        tokenId: issued.token.id,
        token: issued.plaintext,
        expiresAt: issued.token.expiresAt,
      });
    } catch (err) {
      if (err instanceof TokenStoreError) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: err.message } });
        return;
      }
      throw err;
    }
  });

  app.delete<{ Params: { id: string } }>(
    '/api/internal/tokens/:id',
    async (req, reply) => {
      const ok = tokenStore.revoke(req.params.id);
      if (!ok) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'token not found or already revoked' } });
        return;
      }
      await reply.code(204).send();
    },
  );
}
