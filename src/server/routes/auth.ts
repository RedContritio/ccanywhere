import type { FastifyInstance } from 'fastify';
import { deriveRpInfo, type RpInfo } from '../../devices/credential.js';
import type { DeviceStore } from '../../devices/store.js';
import type { TokenStore } from '../../tokens/store.js';
import type { UserStore } from '../../users/store.js';
import { registerAuthMultiUserRoutes } from './auth-multi-user.js';
import { registerAuthSessionRoutes } from './auth-session.js';
import { registerAuthWebauthnRoutes } from './auth-webauthn.js';

export const SESSION_COOKIE_NAME = 'ccanywhere_session';

export interface CookieConfig {
  httpOnly: boolean;
  sameSite: 'lax' | 'strict' | 'none';
  secure: boolean;
  path: string;
  maxAge: number;
}

export interface AuthRoutesOptions {
  readonly store: DeviceStore;
  /** : optional during step-3 rollout. */
  readonly userStore?: UserStore;
  readonly tokenStore?: TokenStore;
  readonly webOrigin: string;
  /**
   * If true, sets `Secure` on the session cookie. Defaults to true when
   * webOrigin is https, false otherwise (so 127.0.0.1 dev still works).
   */
  readonly cookieSecure?: boolean;
  /**
   * Optional override for the session cookie name. Defaults to
   * `SESSION_COOKIE_NAME`. Override only for multi-instance same-domain
   * deployments (e.g. staging on a different port) — RFC 6265 cookies
   * ignore port, so reusing the prod name would let staging Set-Cookie
   * evict the user's prod session. See `config/schema.ts` `cookieName`.
   */
  readonly cookieName?: string;
}

function deriveCookieConfig(opts: AuthRoutesOptions): {
  cookieName: string;
  cookieOpts: CookieConfig;
} {
  const cookieSecure = opts.cookieSecure ?? new URL(opts.webOrigin).protocol === 'https:';
  const cookieName = opts.cookieName ?? SESSION_COOKIE_NAME;
  const cookieOpts: CookieConfig = {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    path: '/',
    // 30 days, matches DeviceStore default sessionTtlMs.
    maxAge: 30 * 24 * 60 * 60,
  };
  return { cookieName, cookieOpts };
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const rp: RpInfo = deriveRpInfo(opts.webOrigin);
  const { cookieName, cookieOpts } = deriveCookieConfig(opts);

  await registerAuthWebauthnRoutes(app, {
    store: opts.store,
    ...(opts.userStore !== undefined && { userStore: opts.userStore }),
    rp,
    cookieName,
    cookieOpts,
  });

  if (opts.userStore !== undefined && opts.tokenStore !== undefined) {
    await registerAuthMultiUserRoutes(app, {
      userStore: opts.userStore,
      tokenStore: opts.tokenStore,
      cookieName,
      cookieOpts,
    });
  }

  await registerAuthSessionRoutes(app, {
    store: opts.store,
    ...(opts.userStore !== undefined && { userStore: opts.userStore }),
    cookieName,
    cookieOpts,
  });
}
