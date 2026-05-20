import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  CredentialError,
  makeAuthenticationOptions,
  makeRegistrationOptions,
  verifyAuthentication,
  verifyRegistration,
  type RpInfo,
} from '../../devices/credential.js';
import type { DeviceStore } from '../../devices/store.js';
import type { UserStore } from '../../users/store.js';
import type { CookieConfig } from './auth.js';

export interface AuthWebauthnRoutesOptions {
  readonly store: DeviceStore;
  /** : optional during step-3 rollout. */
  readonly userStore?: UserStore;
  readonly rp: RpInfo;
  readonly cookieName: string;
  readonly cookieOpts: CookieConfig;
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

export async function registerAuthWebauthnRoutes(
  app: FastifyInstance,
  opts: AuthWebauthnRoutesOptions,
): Promise<void> {
  const { store, userStore, rp, cookieName, cookieOpts } = opts;

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
    const pending = store.createPending({
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
    const pending = store.getPending(parsed.data.pendingId);
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
    store.markPendingAwaitingApproval(pending.pendingId);
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
      const pending = store.getPending(pendingId);
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
    const device = store.getDevice(parsed.data.deviceId);
    if (!device || device.status !== 'active') {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'device not found or revoked' } });
      return;
    }
    // only reject dangling device.userId; pair-time
    // policy decides which kind may be paired.
    if (userStore !== undefined && userStore.findById(device.userId) === null) {
      await reply.code(403).send({
        error: { code: 'forbidden', message: 'device.userId is dangling' },
      });
      return;
    }
    const { options, challenge } = await makeAuthenticationOptions({
      rp,
      credentialId: device.credentialId,
    });
    const lc = store.createLoginChallenge(device.id, challenge);
    await reply.code(200).send({ tempId: lc.tempId, options });
  });

  app.post('/api/auth/login-complete', async (req, reply) => {
    const parsed = LoginCompleteSchema.safeParse(req.body);
    if (!parsed.success) {
      await reply.code(400).send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const lc = store.consumeLoginChallenge(parsed.data.tempId);
    if (!lc) {
      await reply.code(400).send({
        error: { code: 'invalid_request', message: 'login challenge not found or expired' },
      });
      return;
    }
    const device = store.getDevice(lc.deviceId);
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
    store.bumpDeviceCounter(device.id, result.newCounter, Date.now());
    const sessionId = store.issueSession(device.id);
    void reply.setCookie(cookieName, sessionId, cookieOpts);
    await reply.code(200).send({ ok: true, deviceId: device.id });
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
