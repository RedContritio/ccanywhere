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

export const SESSION_COOKIE_NAME = 'ccanywhere_session';

export interface AuthRoutesOptions {
  readonly store: DeviceStore;
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
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'body validation failed' },
      });
      return;
    }
    const { options, challenge } = await makeRegistrationOptions({
      rp,
      // userId is the pendingId once we create it; generate options first
      // with a placeholder, then create pending, then re-emit. Simpler: use
      // a freshly-generated pendingId baked into the options' userID.
      userId: 'placeholder',
      userName: parsed.data.label,
    });
    const pending = opts.store.createPending({
      label: parsed.data.label,
      challenge,
      remoteAddr: req.ip,
      userAgent: req.headers['user-agent'] ?? null,
    });
    // Replace the placeholder user.id in options with pendingId so the
    // browser ties the WebAuthn user record to this pair attempt.
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
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'body validation failed' },
      });
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
    // Stash credential on pending (so approve doesn't have to re-verify).
    // We persist by re-creating pending with these fields, but our types
    // don't include them; do it by closing over via approvePending args.
    // Simpler: store on the pending object using a side map.
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
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'body validation failed' },
      });
      return;
    }
    const device = opts.store.getDevice(parsed.data.deviceId);
    if (!device || device.status !== 'active') {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'device not found or revoked' } });
      return;
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
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'body validation failed' },
      });
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

  app.post('/api/auth/logout', async (req, reply) => {
    const sessionId = req.cookies[cookieName];
    if (typeof sessionId === 'string') opts.store.revokeSession(sessionId);
    void reply.clearCookie(cookieName, { path: '/' });
    await reply.code(204).send();
  });

  app.get('/api/auth/me', async (req, reply) => {
    const device = req.authDevice;
    if (!device) {
      await reply.code(401).send({ error: { code: 'unauthorized', message: 'not logged in' } });
      return;
    }
    await reply
      .code(200)
      .send({ id: device.id, label: device.label, lastUsedAt: device.lastUsedAt });
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
