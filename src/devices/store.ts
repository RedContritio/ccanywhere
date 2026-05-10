import { randomBytes, randomUUID } from 'node:crypto';
import { loadPersistedState, savePersistedState } from './persist.js';
import { seedActiveDevice } from './store-test-seed.js';
import type { Device, LoginChallenge, PendingPair, Session } from './types.js';

export class DeviceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceStoreError';
  }
}

export interface DeviceStoreOptions {
  readonly statePath: string;
  /** m-multi-user: owner User.id, used to tag new devices + fallback legacy records. */
  readonly ownerId: string;
  /** Default 30 min. */
  readonly pendingTtlMs?: number;
  /** Default 5 min. */
  readonly loginChallengeTtlMs?: number;
  /** Default 30 days. */
  readonly sessionTtlMs?: number;
  /** Test clock injection; defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOGIN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class DeviceStore {
  private readonly statePath: string;
  private readonly ownerId: string;
  private readonly pendingTtlMs: number;
  private readonly loginChallengeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  private readonly devices = new Map<string, Device>();
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingPair>();
  private readonly loginChallenges = new Map<string, LoginChallenge>();

  constructor(opts: DeviceStoreOptions) {
    this.statePath = opts.statePath;
    this.ownerId = opts.ownerId;
    this.pendingTtlMs = opts.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS;
    this.loginChallengeTtlMs = opts.loginChallengeTtlMs ?? DEFAULT_LOGIN_TTL_MS;
    this.sessionTtlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.now = opts.now ?? (() => Date.now());
    this.load();
  }

  // ------------ devices ------------

  listDevices(includeRevoked = false): Device[] {
    return Array.from(this.devices.values())
      .filter((d) => includeRevoked || d.status === 'active')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  getDevice(id: string): Device | null {
    return this.devices.get(id) ?? null;
  }

  getDeviceByCredentialId(credentialId: string): Device | null {
    for (const d of this.devices.values()) {
      if (d.credentialId === credentialId) return d;
    }
    return null;
  }

  /** Returns true if the device existed and was newly revoked. */
  revokeDevice(id: string): boolean {
    const d = this.devices.get(id);
    if (!d || d.status === 'revoked') return false;
    this.devices.set(id, { ...d, status: 'revoked' });
    for (const [sid, s] of this.sessions) {
      if (s.deviceId === id) this.sessions.delete(sid);
    }
    this.persist();
    return true;
  }

  /** Increments the WebAuthn signature counter; persists. */
  bumpDeviceCounter(id: string, newCounter: number, lastUsedAt: number): void {
    const d = this.devices.get(id);
    if (!d) return;
    this.devices.set(id, { ...d, counter: newCounter, lastUsedAt });
    this.persist();
  }

  // ------------ pending pair ------------

  createPending(input: {
    label: string;
    challenge: string;
    remoteAddr: string | null;
    userAgent: string | null;
  }): PendingPair {
    this.evictExpiredPending();
    const pendingId = randomBytes(16).toString('base64url');
    const rec: PendingPair = {
      pendingId,
      label: input.label,
      challenge: input.challenge,
      status: 'awaiting-registration',
      createdAt: this.now(),
      issuedSessionId: null,
      issuedDeviceId: null,
      remoteAddr: input.remoteAddr,
      userAgent: input.userAgent,
    };
    this.pending.set(pendingId, rec);
    return rec;
  }

  getPending(pendingId: string): PendingPair | null {
    this.evictExpiredPending();
    return this.pending.get(pendingId) ?? null;
  }

  /** Lists pending pairs awaiting CLI approval (after register-complete). */
  listPendingForApproval(): PendingPair[] {
    this.evictExpiredPending();
    return Array.from(this.pending.values())
      .filter((p) => p.status === 'awaiting-approval')
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  /** Mark transition awaiting-registration → awaiting-approval. */
  markPendingAwaitingApproval(pendingId: string): void {
    const rec = this.pending.get(pendingId);
    if (!rec) throw new DeviceStoreError(`pending not found: ${pendingId}`);
    if (rec.status !== 'awaiting-registration') {
      throw new DeviceStoreError(
        `pending ${pendingId} is in status ${rec.status}; cannot transition to awaiting-approval`,
      );
    }
    this.pending.set(pendingId, { ...rec, status: 'awaiting-approval' });
  }

  /** Approves a pending pair: creates Device + Session, marks 'approved'. */
  approvePending(
    pendingId: string,
    deviceInput: { credentialId: string; publicKey: string; counter: number },
  ): { device: Device; sessionId: string } {
    const rec = this.pending.get(pendingId);
    if (!rec) throw new DeviceStoreError(`pending not found: ${pendingId}`);
    if (rec.status !== 'awaiting-approval') {
      throw new DeviceStoreError(
        `pending ${pendingId} is in status ${rec.status}; cannot approve`,
      );
    }
    if (this.getDeviceByCredentialId(deviceInput.credentialId) !== null) {
      throw new DeviceStoreError('credential already registered to another device');
    }
    const now = this.now();
    const device: Device = {
      id: randomUUID(),
      userId: this.ownerId,
      label: rec.label,
      credentialId: deviceInput.credentialId,
      publicKey: deviceInput.publicKey,
      counter: deviceInput.counter,
      createdAt: now,
      lastUsedAt: now,
      status: 'active',
    };
    this.devices.set(device.id, device);
    const sessionId = this.issueSessionInternal(device.id, now);
    this.pending.set(pendingId, {
      ...rec,
      status: 'approved',
      issuedSessionId: sessionId,
      issuedDeviceId: device.id,
    });
    this.persist();
    return { device, sessionId };
  }

  rejectPending(pendingId: string): boolean {
    const rec = this.pending.get(pendingId);
    if (!rec) return false;
    this.pending.set(pendingId, { ...rec, status: 'rejected' });
    return true;
  }

  // ------------ login challenge ------------

  createLoginChallenge(deviceId: string, challenge: string): LoginChallenge {
    this.evictExpiredLoginChallenges();
    const tempId = randomBytes(16).toString('base64url');
    const rec: LoginChallenge = { tempId, deviceId, challenge, createdAt: this.now() };
    this.loginChallenges.set(tempId, rec);
    return rec;
  }

  consumeLoginChallenge(tempId: string): LoginChallenge | null {
    this.evictExpiredLoginChallenges();
    const rec = this.loginChallenges.get(tempId);
    if (!rec) return null;
    this.loginChallenges.delete(tempId);
    return rec;
  }

  // ------------ sessions ------------

  /** Used by login-complete after assertion verification. */
  issueSession(deviceId: string): string {
    const id = this.issueSessionInternal(deviceId, this.now());
    this.persist();
    return id;
  }

  private issueSessionInternal(deviceId: string, now: number): string {
    const sessionId = randomBytes(32).toString('base64url');
    const rec: Session = { sessionId, deviceId, createdAt: now, lastUsedAt: now };
    this.sessions.set(sessionId, rec);
    return sessionId;
  }

  /** Validates session id → bound device; null if unknown/expired/revoked. */
  authenticateSession(sessionId: string): Device | null {
    const sess = this.sessions.get(sessionId);
    if (!sess) return null;
    const now = this.now();
    if (now - sess.lastUsedAt > this.sessionTtlMs) {
      this.sessions.delete(sessionId);
      this.persist();
      return null;
    }
    const device = this.devices.get(sess.deviceId);
    if (!device || device.status !== 'active') {
      this.sessions.delete(sessionId);
      this.persist();
      return null;
    }
    this.sessions.set(sessionId, { ...sess, lastUsedAt: now });
    return device;
  }

  revokeSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.sessions.delete(sessionId);
    this.persist();
    return true;
  }

  // ------------ test seed ------------

  /** @internal — see store-test-seed.ts */
  __seedActiveDevice(label: string, credentialId?: string): { device: Device; sessionId: string } {
    return seedActiveDevice(this, label, credentialId);
  }

  /** @internal — used by store-test-seed.ts only */
  __addForTest(device: Device): { device: Device; sessionId: string } {
    this.devices.set(device.id, device);
    const sessionId = this.issueSessionInternal(device.id, this.now());
    this.persist();
    return { device, sessionId };
  }

  /** @internal */
  __getOwnerIdForTest(): string { return this.ownerId; }

  // ------------ persistence + maintenance ------------

  private load(): void {
    const state = loadPersistedState(this.statePath);
    if (state === null) return;
    // Legacy records pre-multi-user lack `userId`; fall back to ownerId.
    for (const d of state.devices) {
      this.devices.set(d.id, { ...d, userId: d.userId ?? this.ownerId });
    }
    for (const s of state.sessions) this.sessions.set(s.sessionId, s);
  }

  private persist(): void {
    savePersistedState(this.statePath, {
      devices: Array.from(this.devices.values()),
      sessions: Array.from(this.sessions.values()),
    });
  }

  private evictExpiredPending(): void {
    const c = this.now() - this.pendingTtlMs;
    for (const [id, r] of this.pending) if (r.createdAt < c) this.pending.delete(id);
  }

  private evictExpiredLoginChallenges(): void {
    const c = this.now() - this.loginChallengeTtlMs;
    for (const [id, r] of this.loginChallenges) if (r.createdAt < c) this.loginChallenges.delete(id);
  }
}
