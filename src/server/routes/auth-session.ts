import type { FastifyInstance } from 'fastify';
import type { DeviceStore } from '../../devices/store.js';
import type { UserStore } from '../../users/store.js';
import type { CookieConfig } from './auth.js';

export interface AuthSessionRoutesOptions {
  readonly store: DeviceStore;
  /** : optional during step-3 rollout. */
  readonly userStore?: UserStore;
  readonly cookieName: string;
  readonly cookieOpts: CookieConfig;
}

export async function registerAuthSessionRoutes(
  app: FastifyInstance,
  opts: AuthSessionRoutesOptions,
): Promise<void> {
  const { store, userStore, cookieName, cookieOpts } = opts;

  app.post('/api/auth/logout', async (req, reply) => {
    const sessionId = req.cookies[cookieName];
    if (typeof sessionId === 'string') store.revokeSession(sessionId);
    void reply.clearCookie(cookieName, { path: cookieOpts.path });
    await reply.code(204).send();
  });

  // label = user identity (username); both device and
  // token branches resolve user via userStore so response stays accurate
  // when pairing extends beyond owner.
  app.get('/api/auth/me', async (req, reply) => {
    const device = req.authDevice;
    if (device) {
      const user = userStore?.findById(device.userId);
      const label = user?.username ?? 'owner';
      const kind = user?.kind ?? 'owner';
      await reply
        .code(200)
        .send({ id: device.id, label, kind, lastUsedAt: device.lastUsedAt });
      return;
    }
    const user = req.user;
    if (user) {
      await reply
        .code(200)
        .send({ id: user.id, label: user.username, kind: user.kind, lastUsedAt: user.lastLoginAt });
      return;
    }
    await reply.code(401).send({ error: { code: 'unauthorized', message: 'not logged in' } });
  });
}
