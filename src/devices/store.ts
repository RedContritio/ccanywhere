/* eslint-disable max-lines -- TODO(m-lint-cap phase 2): extract persistence helper */
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Device, LoginChallenge, PendingPair, Session } from './types.js';

export class DeviceStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceStoreError';
  }
}

interface PersistedState {
  readonly devices: ReadonlyArray<Device>;
  readonly sessions: ReadonlyArray<Session>;
}

export interface DeviceStoreOptions {
  /** Path to the JSON file that persists devices + sessions. */
  readonly statePath: string;
  /**
   * TTL for a pending pair record (no approval action yet). After expiry the
   * record is dropped from in-memory storage. Default 30 minutes.
   */
  readonly pendingTtlMs?: number;
  /**
   * TTL for a login challenge between login-init and login-complete. The
   * browser is expected to call assertion within seconds; we give 5 minutes
   * to absorb slow networks. Default 300_000.
   */
  readonly loginChallengeTtlMs?: number;
  /**
   * Idle timeout for a session before it's considered expired and pruned.
   * Default 30 days.
   */
  readonly sessionTtlMs?: number;
  /** Clock injection for tests; defaults to `Date.now`. */
  readonly now?: () => number;
}

const DEFAULT_PENDING_TTL_MS = 30 * 60 * 1000;
const DEFAULT_LOGIN_TTL_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export class DeviceStore {
  private readonly statePath: string;
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
    // Drop any sessions for this device immediately.
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

  /**
   * Lists pending pairs awaiting CLI approval (after register-complete).
   * The mac CLI uses this for `ccanywhere approve`.
   */
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

  /**
   * Approves a pending pair: creates the Device, opens a Session, and
   * marks the pending record 'approved' so the polling browser can pick
   * up the issued session id.
   */
  approvePending(
    pendingId: string,
    deviceInput: {
      credentialId: string;
      publicKey: string;
      counter: number;
    },
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

  /**
   * Validates a session id and returns the bound device. Returns null if
   * the session is unknown, expired, or its device is revoked. Side effect:
   * if returned non-null, lastUsedAt is updated and persisted.
   */
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
    // Persist lazily — touching every request would be too chatty. Caller
    // can call persistTouch() periodically; for now we don't auto-persist
    // on every read.
    return device;
  }

  revokeSession(sessionId: string): boolean {
    if (!this.sessions.has(sessionId)) return false;
    this.sessions.delete(sessionId);
    this.persist();
    return true;
  }

  // ------------ test seed ------------

  /**
   * Test-only: create an active device + a usable session id without going
   * through WebAuthn registration. Used by integration tests that need an
   * authenticated request without simulating attestation. NOT a real HTTP
   * surface — there's no route that calls this.
   *
   * @internal
   */
  __seedActiveDevice(label: string, credentialId = `seed-${randomBytes(8).toString('hex')}`): {
    device: Device;
    sessionId: string;
  } {
    const now = this.now();
    const device: Device = {
      id: randomUUID(),
      label,
      credentialId,
      publicKey: '',
      counter: 0,
      createdAt: now,
      lastUsedAt: now,
      status: 'active',
    };
    this.devices.set(device.id, device);
    const sessionId = this.issueSessionInternal(device.id, now);
    this.persist();
    return { device, sessionId };
  }

  // ------------ persistence ------------

  private load(): void {
    if (!existsSync(this.statePath)) return;
    let raw: string;
    try {
      raw = readFileSync(this.statePath, 'utf8');
    } catch {
      return;
    }
    let parsed: Partial<PersistedState>;
    try {
      parsed = JSON.parse(raw) as Partial<PersistedState>;
    } catch {
      return;
    }
    if (Array.isArray(parsed.devices)) {
      for (const d of parsed.devices) {
        if (typeof d?.id === 'string') this.devices.set(d.id, d);
      }
    }
    if (Array.isArray(parsed.sessions)) {
      for (const s of parsed.sessions) {
        if (typeof s?.sessionId === 'string') this.sessions.set(s.sessionId, s);
      }
    }
  }

  private persist(): void {
    const dir = dirname(this.statePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const state: PersistedState = {
      devices: Array.from(this.devices.values()),
      sessions: Array.from(this.sessions.values()),
    };
    writeFileSync(this.statePath, JSON.stringify(state, null, 2), { mode: 0o600 });
  }

  private evictExpiredPending(): void {
    const cutoff = this.now() - this.pendingTtlMs;
    for (const [id, rec] of this.pending) {
      if (rec.createdAt < cutoff) this.pending.delete(id);
    }
  }

  private evictExpiredLoginChallenges(): void {
    const cutoff = this.now() - this.loginChallengeTtlMs;
    for (const [id, rec] of this.loginChallenges) {
      if (rec.createdAt < cutoff) this.loginChallenges.delete(id);
    }
  }
}
