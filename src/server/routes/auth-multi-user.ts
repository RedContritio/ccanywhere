import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { TokenStore } from '../../tokens/store.js';
import type { UserStore } from '../../users/store.js';
import {
  TOOLBAR_COLS_MAX,
  TOOLBAR_COLS_MIN,
  TOOLBAR_ROWS_MAX,
  TOOLBAR_ROWS_MIN,
  type UserPreferences,
} from '../../users/types.js';

const TokenLoginSchema = z.object({ token: z.string().min(32) });

const ToolbarKeySchema = z.object({
  id: z.string().min(1).max(64),
  label: z.string().min(1).max(16),
  ariaLabel: z.string().max(64).optional(),
  title: z.string().max(128).optional(),
  action: z.enum(['plain', 'ctrl-letter', 'toggle-sticky-ctrl']),
  payload: z.string().max(16),
});

const ToolbarLayoutSchema = z
  .object({
    rows: z.number().int().min(TOOLBAR_ROWS_MIN).max(TOOLBAR_ROWS_MAX),
    cols: z.number().int().min(TOOLBAR_COLS_MIN).max(TOOLBAR_COLS_MAX),
    cells: z.array(ToolbarKeySchema.nullable()),
  })
  .superRefine((v, ctx) => {
    if (v.cells.length !== v.rows * v.cols) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `cells.length must equal rows × cols (${v.rows * v.cols})`,
      });
    }
    const ids = new Set<string>();
    for (const cell of v.cells) {
      if (cell === null) continue;
      if (ids.has(cell.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate cell id: ${cell.id}`,
        });
        return;
      }
      ids.add(cell.id);
      if (cell.action === 'ctrl-letter' && !/^[a-z]$/.test(cell.payload)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `ctrl-letter payload must be a..z (got ${JSON.stringify(cell.payload)})`,
        });
      }
    }
  });

const PreferencesSchema = z.object({
  toolbar: ToolbarLayoutSchema.nullable().optional(),
});

const ActiveSessionSchema = z.object({
  sessionId: z.string().min(1).max(64).nullable(),
});

export interface AuthMultiUserRoutesOptions {
  readonly userStore: UserStore;
  readonly tokenStore: TokenStore;
  readonly cookieName: string;
  readonly cookieOpts: {
    httpOnly: boolean;
    sameSite: 'lax' | 'strict' | 'none';
    secure: boolean;
    path: string;
    maxAge: number;
  };
}

/**
 * m-multi-user (#44) auth routes for token-based user login + the
 * current-user quota endpoint. Mounted by `registerAuthRoutes` only when
 * `userStore` + `tokenStore` are wired.
 */
export async function registerAuthMultiUserRoutes(
  app: FastifyInstance,
  opts: AuthMultiUserRoutesOptions,
): Promise<void> {
  const { userStore, tokenStore, cookieName, cookieOpts } = opts;

  app.post('/api/auth/token', async (req, reply) => {
    const parsed = TokenLoginSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const token = tokenStore.verify(parsed.data.token);
    if (token === null) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'invalid or expired token' } });
      return;
    }
    // m-user-symmetric: token route accepts any user (owner or user kind).
    // Pre-reframe this hardcoded `kind !== 'limited'` to block owner-token
    // login; the data layer is now symmetric — owner can sign and use a
    // self-issued token (admin / automation paths). Webauthn pair remains
    // owner-only via the dedicated policy assert.
    const user = userStore.findById(token.userId);
    if (user === null) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'token user invalid' } });
      return;
    }
    userStore.touchLogin(user.id);
    // Cookie value = token plaintext; re-verifies on every request via
    // tokenStore.verify (constant-time). Cookie ttl ≤ token ttl.
    const ttlSec = Math.max(60, Math.floor((token.expiresAt - Date.now()) / 1000));
    void reply.setCookie(cookieName, parsed.data.token, { ...cookieOpts, maxAge: ttlSec });
    await reply.code(200).send({ ok: true, user: { username: user.username, kind: user.kind } });
  });

  app.get('/api/me/quota', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    await reply.code(200).send({
      kind: user.kind,
      cost: user.quota.cost,
      tokens: user.quota.tokens,
    });
  });

  app.get('/api/me/preferences', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    const prefs = userStore.getPreferences(user.id);
    await reply.code(200).send(prefs ?? {});
  });

  app.put('/api/me/preferences', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    const parsed = PreferencesSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'preferences validation failed',
          details: parsed.error.issues,
        },
      });
      return;
    }
    // toolbar: null clears the override (client falls back to default).
    // toolbar: undefined leaves it unchanged (rare — clients usually send
    // the full prefs object).
    const next: UserPreferences =
      parsed.data.toolbar !== undefined && parsed.data.toolbar !== null
        ? { toolbar: parsed.data.toolbar }
        : {};
    userStore.setPreferences(user.id, next);
    await reply.code(200).send(next);
  });

  app.get('/api/me/active-session', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    await reply.code(200).send({ sessionId: user.lastActiveSessionId });
  });

  app.put('/api/me/active-session', async (req, reply) => {
    const user = req.user;
    if (user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    const parsed = ActiveSessionSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'active-session validation failed',
          details: parsed.error.issues,
        },
      });
      return;
    }
    userStore.setLastActiveSession(user.id, parsed.data.sessionId);
    await reply.code(200).send({ sessionId: parsed.data.sessionId });
  });
}
