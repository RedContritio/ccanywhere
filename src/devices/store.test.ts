import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DeviceStore, DeviceStoreError } from './store.js';

describe('DeviceStore', () => {
  let dir: string;
  let statePath: string;
  let store: DeviceStore;
  let now: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccanywhere-devstore-'));
    statePath = join(dir, 'devices.json');
    now = 1_000_000;
    store = new DeviceStore({
      statePath,
      now: () => now,
      pendingTtlMs: 60_000,
      loginChallengeTtlMs: 10_000,
      sessionTtlMs: 100_000,
    });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('seedActiveDevice + sessions', () => {
    it('creates an active device + a usable session id', () => {
      const { device, sessionId } = store.__seedActiveDevice('laptop');
      expect(device.label).toBe('laptop');
      expect(device.status).toBe('active');
      expect(sessionId.length).toBeGreaterThan(20);

      const looked = store.authenticateSession(sessionId);
      expect(looked?.id).toBe(device.id);
    });

    it('persists devices + sessions to disk', () => {
      const { sessionId } = store.__seedActiveDevice('persisted');
      expect(existsSync(statePath)).toBe(true);
      const raw = JSON.parse(readFileSync(statePath, 'utf8')) as {
        devices: { id: string }[];
        sessions: { sessionId: string }[];
      };
      expect(raw.devices).toHaveLength(1);
      expect(raw.sessions.some((s) => s.sessionId === sessionId)).toBe(true);
    });

    it('reloads state on construction', () => {
      const { sessionId } = store.__seedActiveDevice('persisted');
      const fresh = new DeviceStore({ statePath, now: () => now });
      expect(fresh.authenticateSession(sessionId)).not.toBeNull();
    });

    it('authenticateSession returns null for unknown id', () => {
      expect(store.authenticateSession('ghost')).toBeNull();
    });

    it('authenticateSession returns null for expired session', () => {
      const { sessionId } = store.__seedActiveDevice('exp');
      now += 100_001;
      expect(store.authenticateSession(sessionId)).toBeNull();
    });

    it('revokeDevice drops the device, marks revoked, and clears its sessions', () => {
      const { device, sessionId } = store.__seedActiveDevice('soon-gone');
      expect(store.revokeDevice(device.id)).toBe(true);
      expect(store.authenticateSession(sessionId)).toBeNull();
      // listDevices(false) excludes revoked; (true) includes
      expect(store.listDevices(false).map((d) => d.id)).not.toContain(device.id);
      expect(store.listDevices(true).find((d) => d.id === device.id)?.status).toBe('revoked');
    });

    it('revokeDevice is idempotent', () => {
      const { device } = store.__seedActiveDevice('twice');
      expect(store.revokeDevice(device.id)).toBe(true);
      expect(store.revokeDevice(device.id)).toBe(false);
    });

    it('revokeSession only affects the targeted session', () => {
      const { sessionId: s1 } = store.__seedActiveDevice('a');
      const { sessionId: s2 } = store.__seedActiveDevice('b');
      expect(store.revokeSession(s1)).toBe(true);
      expect(store.revokeSession(s1)).toBe(false);
      expect(store.authenticateSession(s1)).toBeNull();
      expect(store.authenticateSession(s2)).not.toBeNull();
    });
  });

  describe('pending pair flow', () => {
    it('createPending → markAwaitingApproval → approve happy path', () => {
      const p = store.createPending({
        label: 'iPhone',
        challenge: 'chal-abc',
        remoteAddr: '192.168.1.10',
        userAgent: 'Mozilla/5.0',
      });
      expect(p.status).toBe('awaiting-registration');
      expect(p.label).toBe('iPhone');

      store.markPendingAwaitingApproval(p.pendingId);
      expect(store.getPending(p.pendingId)?.status).toBe('awaiting-approval');

      const result = store.approvePending(p.pendingId, {
        credentialId: 'cred-id',
        publicKey: 'pubkey-b64',
        counter: 0,
      });
      expect(result.device.label).toBe('iPhone');
      expect(result.device.credentialId).toBe('cred-id');
      expect(result.device.status).toBe('active');
      expect(result.sessionId.length).toBeGreaterThan(20);
      expect(store.authenticateSession(result.sessionId)?.id).toBe(result.device.id);

      const final = store.getPending(p.pendingId);
      expect(final?.status).toBe('approved');
      expect(final?.issuedSessionId).toBe(result.sessionId);
      expect(final?.issuedDeviceId).toBe(result.device.id);
    });

    it('listPendingForApproval only returns awaiting-approval rows', () => {
      const a = store.createPending({
        label: 'A',
        challenge: 'x',
        remoteAddr: null,
        userAgent: null,
      });
      const b = store.createPending({
        label: 'B',
        challenge: 'y',
        remoteAddr: null,
        userAgent: null,
      });
      store.markPendingAwaitingApproval(b.pendingId);
      const list = store.listPendingForApproval();
      expect(list.map((p) => p.pendingId)).toEqual([b.pendingId]);
      expect(list).not.toContainEqual(expect.objectContaining({ pendingId: a.pendingId }));
    });

    it('markPendingAwaitingApproval rejects wrong-state transitions', () => {
      const p = store.createPending({
        label: 'X',
        challenge: 'c',
        remoteAddr: null,
        userAgent: null,
      });
      store.markPendingAwaitingApproval(p.pendingId);
      expect(() => store.markPendingAwaitingApproval(p.pendingId)).toThrow(DeviceStoreError);
    });

    it('approvePending rejects when not in awaiting-approval', () => {
      const p = store.createPending({
        label: 'X',
        challenge: 'c',
        remoteAddr: null,
        userAgent: null,
      });
      // skipped markPendingAwaitingApproval
      expect(() =>
        store.approvePending(p.pendingId, { credentialId: 'a', publicKey: 'b', counter: 0 }),
      ).toThrow(DeviceStoreError);
    });

    it('approvePending rejects duplicate credentialId', () => {
      const a = store.createPending({
        label: 'A',
        challenge: 'c',
        remoteAddr: null,
        userAgent: null,
      });
      store.markPendingAwaitingApproval(a.pendingId);
      store.approvePending(a.pendingId, { credentialId: 'dup', publicKey: 'p', counter: 0 });

      const b = store.createPending({
        label: 'B',
        challenge: 'c2',
        remoteAddr: null,
        userAgent: null,
      });
      store.markPendingAwaitingApproval(b.pendingId);
      expect(() =>
        store.approvePending(b.pendingId, { credentialId: 'dup', publicKey: 'p2', counter: 0 }),
      ).toThrow(/credential already registered/);
    });

    it('rejectPending marks status rejected', () => {
      const p = store.createPending({
        label: 'X',
        challenge: 'c',
        remoteAddr: null,
        userAgent: null,
      });
      expect(store.rejectPending(p.pendingId)).toBe(true);
      expect(store.getPending(p.pendingId)?.status).toBe('rejected');
    });

    it('pending records expire after pendingTtlMs', () => {
      const p = store.createPending({
        label: 'X',
        challenge: 'c',
        remoteAddr: null,
        userAgent: null,
      });
      now += 60_001;
      expect(store.getPending(p.pendingId)).toBeNull();
    });
  });

  describe('login challenge', () => {
    it('createLoginChallenge + consume', () => {
      const { device } = store.__seedActiveDevice('laptop');
      const lc = store.createLoginChallenge(device.id, 'chal');
      expect(lc.deviceId).toBe(device.id);
      expect(lc.challenge).toBe('chal');

      const consumed = store.consumeLoginChallenge(lc.tempId);
      expect(consumed?.challenge).toBe('chal');
      // Single-use
      expect(store.consumeLoginChallenge(lc.tempId)).toBeNull();
    });

    it('login challenge expires', () => {
      const { device } = store.__seedActiveDevice('exp');
      const lc = store.createLoginChallenge(device.id, 'chal');
      now += 10_001;
      expect(store.consumeLoginChallenge(lc.tempId)).toBeNull();
    });
  });

  describe('counter bump', () => {
    it('bumpDeviceCounter persists', () => {
      const { device } = store.__seedActiveDevice('lap');
      store.bumpDeviceCounter(device.id, 7, now + 1);
      const reloaded = new DeviceStore({ statePath, now: () => now });
      const looked = reloaded.getDevice(device.id);
      expect(looked?.counter).toBe(7);
      expect(looked?.lastUsedAt).toBe(now + 1);
    });
  });
});
