import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as credentialModule from '../devices/credential.js';
import { SessionManager } from '../session/manager.js';
import { pendingCredentials } from './routes/auth-webauthn.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

/**
 * Webauthn 5-route envelope + state-machine coverage (m-webauthn-routes-test).
 *
 * What's covered: body validation, state-machine transitions, dangling
 * userId guard, downstream side-effects after a (mocked) verify pass —
 * session issuance, cookie set, counter bump, pendingCredentials store.
 *
 * What's NOT covered: real cryptographic happy path. `verifyRegistration`
 * / `verifyAuthentication` need an actual authenticator signature to
 * return `verified: true`; no way to fabricate one in-process. Those
 * paths are owned by playwright e2e against a real device.
 *
 * Mock granularity: ONLY verifyRegistration + verifyAuthentication.
 * `makeRegistrationOptions` / `makeAuthenticationOptions` / `deriveRpInfo`
 * / `CredentialError` run for real so options-generation correctness +
 * error class identity stay covered.
 */
vi.mock('../devices/credential.js', async () => {
  const actual = await vi.importActual<typeof credentialModule>(
    '../devices/credential.js',
  );
  return {
    ...actual,
    verifyRegistration: vi.fn(),
    verifyAuthentication: vi.fn(),
  };
});

// Import after mock so we get the mocked refs.
import * as credential from '../devices/credential.js';

const mockedVerifyRegistration = vi.mocked(credential.verifyRegistration);
const mockedVerifyAuthentication = vi.mocked(credential.verifyAuthentication);

describe('REST API: webauthn 5 routes (m-webauthn-routes-test)', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    app = await buildServer({
      config: { ...baseConfig, workspace: env.workspace },
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      userStore: env.userStore,
      tokenStore: env.tokenStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir: null,
      injectCcSessionId: false,
    });
    mockedVerifyRegistration.mockReset();
    mockedVerifyAuthentication.mockReset();
    pendingCredentials.clear();
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  // ─── register-init ──────────────────────────────────────────────────

  it('register-init: valid body → 201 + pendingId + pending in store', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'macbook' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { pendingId: string; options: { challenge: string } };
    expect(typeof body.pendingId).toBe('string');
    expect(body.pendingId.length).toBeGreaterThan(0);
    expect(typeof body.options.challenge).toBe('string');
    const pending = env.deviceStore.getPending(body.pendingId);
    expect(pending).not.toBeNull();
    expect(pending?.status).toBe('awaiting-registration');
  });

  it('register-init: missing label → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── register-complete ──────────────────────────────────────────────

  it('register-complete: pendingId not found → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId: 'does-not-exist', attestation: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('register-complete: pending already approved → 409 invalid_state', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'mac' },
    });
    const { pendingId } = initRes.json() as { pendingId: string };
    mockedVerifyRegistration.mockResolvedValueOnce({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });
    // First complete moves to awaiting-approval.
    await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    // Approve via store (simulates CLI approve route).
    env.deviceStore.approvePending(pendingId, {
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    expect(res.statusCode).toBe(409);
  });

  it('register-complete: verify throws CredentialError → 400 verification_failed', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'mac' },
    });
    const { pendingId } = initRes.json() as { pendingId: string };
    mockedVerifyRegistration.mockRejectedValueOnce(
      new credential.CredentialError('bad attestation'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('verification_failed');
  });

  it('register-complete: verify passes (mocked) → 200 + status awaiting-approval + pendingCredentials filled', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'mac' },
    });
    const { pendingId } = initRes.json() as { pendingId: string };
    mockedVerifyRegistration.mockResolvedValueOnce({
      credentialId: 'cred-xyz',
      publicKey: 'pk-xyz',
      counter: 0,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    expect(res.statusCode).toBe(200);
    expect(env.deviceStore.getPending(pendingId)?.status).toBe('awaiting-approval');
    expect(pendingCredentials.get(pendingId)?.credentialId).toBe('cred-xyz');
  });

  // ─── register-status ────────────────────────────────────────────────

  it('register-status: pending awaiting-approval → 200 + no Set-Cookie', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'mac' },
    });
    const { pendingId } = initRes.json() as { pendingId: string };
    mockedVerifyRegistration.mockResolvedValueOnce({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/register-status?pendingId=${pendingId}`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { status: string }).status).toBe('awaiting-approval');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('register-status: pending approved + issuedSessionId → 200 + Set-Cookie + deviceId', async () => {
    const initRes = await app.inject({
      method: 'POST',
      url: '/api/auth/register-init',
      headers: { 'content-type': 'application/json' },
      payload: { label: 'mac' },
    });
    const { pendingId } = initRes.json() as { pendingId: string };
    mockedVerifyRegistration.mockResolvedValueOnce({
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });
    await app.inject({
      method: 'POST',
      url: '/api/auth/register-complete',
      headers: { 'content-type': 'application/json' },
      payload: { pendingId, attestation: {} },
    });
    env.deviceStore.approvePending(pendingId, {
      credentialId: 'cred-1',
      publicKey: 'pk-1',
      counter: 0,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/api/auth/register-status?pendingId=${pendingId}`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { status: string; deviceId: string };
    expect(body.status).toBe('approved');
    expect(typeof body.deviceId).toBe('string');
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    expect(cookieHeader).toContain(`${baseConfig.cookieName}=`);
  });

  it('register-status: missing pendingId query → 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/auth/register-status',
    });
    expect(res.statusCode).toBe(400);
  });

  // ─── login-init ─────────────────────────────────────────────────────

  it('login-init: device not found → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-init',
      headers: { 'content-type': 'application/json' },
      payload: { deviceId: 'does-not-exist' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('login-init: device revoked → 404', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-revoke');
    env.deviceStore.revokeDevice(device.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-init',
      headers: { 'content-type': 'application/json' },
      payload: { deviceId: device.id },
    });
    expect(res.statusCode).toBe(404);
  });

  it('login-init: dangling userId (m-user-symmetric) → 403 forbidden', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-dangle');
    // Force device.userId to point at a non-existent user.
    (device as { userId: string }).userId = 'no-such-user';
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-init',
      headers: { 'content-type': 'application/json' },
      payload: { deviceId: device.id },
    });
    expect(res.statusCode).toBe(403);
  });

  it('login-init: owner device → 200 + tempId + options.challenge', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-owner');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-init',
      headers: { 'content-type': 'application/json' },
      payload: { deviceId: device.id },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { tempId: string; options: { challenge: string } };
    expect(typeof body.tempId).toBe('string');
    expect(typeof body.options.challenge).toBe('string');
  });

  // ─── login-complete ─────────────────────────────────────────────────

  it('login-complete: tempId not found or expired → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-complete',
      headers: { 'content-type': 'application/json' },
      payload: { tempId: 'does-not-exist', assertion: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  it('login-complete: device revoked between init and complete → 404', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-late-revoke');
    const lc = env.deviceStore.createLoginChallenge(device.id, 'chal');
    env.deviceStore.revokeDevice(device.id);
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-complete',
      headers: { 'content-type': 'application/json' },
      payload: { tempId: lc.tempId, assertion: {} },
    });
    expect(res.statusCode).toBe(404);
  });

  it('login-complete: verify throws CredentialError → 401', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-bad-sig');
    const lc = env.deviceStore.createLoginChallenge(device.id, 'chal');
    mockedVerifyAuthentication.mockRejectedValueOnce(
      new credential.CredentialError('bad assertion'),
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-complete',
      headers: { 'content-type': 'application/json' },
      payload: { tempId: lc.tempId, assertion: {} },
    });
    expect(res.statusCode).toBe(401);
  });

  it('login-complete: verify passes (mocked) → 200 + counter bumped + Set-Cookie + issued session', async () => {
    const { device } = env.deviceStore.__seedActiveDevice('mac', 'cred-good');
    const lc = env.deviceStore.createLoginChallenge(device.id, 'chal');
    mockedVerifyAuthentication.mockResolvedValueOnce({ newCounter: 42 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login-complete',
      headers: { 'content-type': 'application/json' },
      payload: { tempId: lc.tempId, assertion: {} },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; deviceId: string };
    expect(body.ok).toBe(true);
    expect(body.deviceId).toBe(device.id);
    const bumped = env.deviceStore.getDevice(device.id);
    expect(bumped?.counter).toBe(42);
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    expect(cookieHeader).toContain(`${baseConfig.cookieName}=`);
  });

  // ─── logout ─────────────────────────────────────────────────────────

  it('logout: with valid cookie → 204 + Set-Cookie clears + session revoked', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(204);
    const setCookie = res.headers['set-cookie'];
    const cookieHeader = Array.isArray(setCookie) ? setCookie.join('; ') : setCookie ?? '';
    // clearCookie sets the cookie to empty + Expires in the past
    expect(cookieHeader).toContain(`${baseConfig.cookieName}=`);
    expect(cookieHeader).toMatch(/Expires=|Max-Age=0/i);
    // Session should be revoked: cookie sessionId no longer resolves to a device.
    expect(env.deviceStore.authenticateSession(env.sessionId)).toBeNull();
  });

  it('logout: no cookie → 401 (gated by hookEarlyAuth like all non-public auth routes)', async () => {
    // /api/auth/logout is NOT in AUTH_PUBLIC_PREFIXES — caller must
    // already have a session cookie. Proposal task listed 204
    // (assuming idempotent) but actual behavior is 401-gate which is
    // safer (no info leak about session presence to unauth callers).
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
    });
    expect(res.statusCode).toBe(401);
  });
});
