import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CredentialError,
  deriveRpInfo,
  makeAuthenticationOptions,
  makeRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type RpInfo,
} from '../../devices/credential.js';
import type { DeviceStore } from '../../devices/store.js';
import type { TokenStore } from '../../tokens/store.js';
import type { UserStore } from '../../users/store.js';
import { registerAuthMultiUserRoutes } from './auth-multi-user.js';

export const SESSION_COOKIE_NAME = 'ccanywhere_session';

export interface AuthRoutesOptions {
  readonly store: DeviceStore;
  /** m-multi-user: optional during step-3 rollout. */
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

const RegisterInitSchema = z.object({
  label: z.string().min(1).max(64),
});

const RegisterCompleteSchema = z.object({
  pendingId: z.string().min(1),
  // attestation passes through to @simplewebauthn; we don't shape-check.
  attestation: z.unknown(),
});

const LoginInitSchema = z.object({
  deviceId: z.string().min(1),
});

const LoginCompleteSchema = z.object({
  tempId: z.string().min(1),
  assertion: z.unknown(),
});

export async function registerAuthRoutes(
  app: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const rp: RpInfo = deriveRpInfo(opts.webOrigin);
  const cookieSecure = opts.cookieSecure ?? new URL(opts.webOrigin).protocol === 'https:';
  const cookieName = opts.cookieName ?? SESSION_COOKIE_NAME;
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: cookieSecure,
    path: '/',
    // 30 days, matches DeviceStore default sessionTtlMs.
    maxAge: 30 * 24 * 60 * 60,
  };

  app.post('/api/auth/register-init', async (req, reply) => {
    const parsed = RegisterInitSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const { options, challenge } = await makeRegistrationOptions({
      rp,
      // placeholder swapped for pendingId below
      userId: 'placeholder',
      userName: parsed.data.label,
    });
    const pending = opts.store.createPending({
      label: parsed.data.label,
      challenge,
      remoteAddr: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    const optsWithUserId = {
      ...options,
      user: {
        ...options.user,
        id: Buffer.from(pending.pendingId).toString('base64url'),
      },
    };
    await reply.code(201).send({ pendingId: pending.pendingId, options: optsWithUserId });
  });

  app.post('/api/auth/register-complete', async (req, reply) => {
    const parsed = RegisterCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const pending = opts.store.getPending(parsed.data.pendingId);
    if (!pending) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'pending pair not found or expired' } });
      return;
    }
    if (pending.status !== 'awaiting-registration') {
      await reply.code(409).send({
        error: { code: 'invalid_state', message: `pending is in status ${pending.status}` },
      });
      return;
    }
    let credential;
    try {
      credential = await verifyRegistration({
        rp,
        expectedChallenge: pending.challenge,
        // Cast: zod gave us unknown, simplewebauthn types it more strictly;
        // any mismatch surfaces as CredentialError below.
        attestation: parsed.data.attestation as never,
      });
    } catch (err) {
      if (err instanceof CredentialError) {
        await reply
          .code(400)
          .send({ error: { code: 'verification_failed', message: err.message } });
        return;
      }
      throw err;
    }
    // Side map keeps credential keyed by pendingId so CLI approve doesn't
    // re-verify attestation.
    pendingCredentials.set(pending.pendingId, credential);
    opts.store.markPendingAwaitingApproval(pending.pendingId);
    await reply.code(200).send({ status: 'awaiting-approval' });
  });

  app.get<{ Querystring: { pendingId?: string } }>(
    '/api/auth/register-status',
    async (req, reply) => {
      const pendingId = req.query.pendingId;
      if (typeof pendingId !== 'string' || pendingId.length === 0) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_request', message: 'pendingId required' } });
        return;
      }
      const pending = opts.store.getPending(pendingId);
      if (!pending) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'pending pair not found or expired' } });
        return;
      }
      if (pending.status === 'approved' && pending.issuedSessionId !== null) {
        // One-shot: set the cookie and return device id. Subsequent polls
        // will still hit this branch (we don't auto-purge approved records;
        // pendingTtlMs takes care of cleanup).
        void reply.setCookie(cookieName, pending.issuedSessionId, cookieOpts);
        await reply
          .code(200)
          .send({ status: 'approved', deviceId: pending.issuedDeviceId });
        return;
      }
      await reply.code(200).send({ status: pending.status });
    },
  );

  app.post('/api/auth/login-init', async (req, reply) => {
    const parsed = LoginInitSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const device = opts.store.getDevice(parsed.data.deviceId);
    if (!device || device.status !== 'active') {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'device not found or revoked' } });
      return;
    }
    // m-multi-user: webauthn login only for owner kind. v12 invariant says
    // every device.userId points at the owner; this check defensively rejects
    // if a legacy / misowned device record sneaks in.
    if (opts.userStore !== undefined) {
      const user = opts.userStore.findById(device.userId);
      if (user === null || user.kind !== 'owner') {
        await reply.code(403).send({
          error: { code: 'forbidden', message: 'webauthn login only for owner' },
        });
        return;
      }
    }
    const { options, challenge } = await makeAuthenticationOptions({
      rp,
      credentialId: device.credentialId,
    });
    const lc = opts.store.createLoginChallenge(device.id, challenge);
    await reply.code(200).send({ tempId: lc.tempId, options });
  });

  app.post('/api/auth/login-complete', async (req, reply) => {
    const parsed = LoginCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const lc = opts.store.consumeLoginChallenge(parsed.data.tempId);
    if (!lc) {
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'login challenge not found or expired' },
      });
      return;
    }
    const device = opts.store.getDevice(lc.deviceId);
    if (!device || device.status !== 'active') {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'device not found or revoked' } });
      return;
    }
    let result;
    try {
      result = await verifyAuthentication({
        rp,
        expectedChallenge: lc.challenge,
        device,
        assertion: parsed.data.assertion as never,
      });
    } catch (err) {
      if (err instanceof CredentialError) {
        await reply
          .code(401)
          .send({ error: { code: 'verification_failed', message: err.message } });
        return;
      }
      throw err;
    }
    opts.store.bumpDeviceCounter(device.id, result.newCounter, Date.now());
    const sessionId = opts.store.issueSession(device.id);
    void reply.setCookie(cookieName, sessionId, cookieOpts);
    await reply.code(200).send({ ok: true, deviceId: device.id });
  });

  if (opts.userStore !== undefined && opts.tokenStore !== undefined) {
    await registerAuthMultiUserRoutes(app, {
      userStore: opts.userStore,
      tokenStore: opts.tokenStore,
      cookieName,
      cookieOpts,
    });
  }

  app.post('/api/auth/logout', async (req, reply) => {
    const sessionId = req.cookies[cookieName];
    if (typeof sessionId === 'string') opts.store.revokeSession(sessionId);
    void reply.clearCookie(cookieName, { path: '/' });
    await reply.code(204).send();
  });

  // label = user identity (owner / limited username), not device label.
  app.get('/api/auth/me', async (req, reply) => {
    const device = req.authDevice;
    if (device) {
      const label = opts.userStore?.getOwner().username ?? 'owner';
      await reply
        .code(200)
        .send({ id: device.id, label, kind: 'owner', lastUsedAt: device.lastUsedAt });
      return;
    }
    const user = req.user;
    if (user && user.kind === 'limited') {
      await reply
        .code(200)
        .send({ id: user.id, label: user.username, kind: 'limited', lastUsedAt: user.lastLoginAt });
      return;
    }
    await reply.code(401).send({ error: { code: 'unauthorized', message: 'not logged in' } });
  });
}

/**
 * Side-channel storage for verified WebAuthn registration results. We keep
 * them in memory keyed by pendingId so `approvePending` (called from the
 * CLI route) can finalize the device without re-running attestation
 * verification. Sized to TTL of pending records — same lifecycle.
 */
export const pendingCredentials = new Map<
  string,
  { credentialId: string; publicKey: string; counter: number }
>();
