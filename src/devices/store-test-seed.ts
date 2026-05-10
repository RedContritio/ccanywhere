import { randomBytes, randomUUID } from 'node:crypto';
import type { DeviceStore } from './store.js';
import type { Device } from './types.js';

/**
 * Test-only: create an active device + a usable session id without going
 * through WebAuthn registration. Used by integration tests that need an
 * authenticated request without simulating attestation. NOT a real HTTP
 * surface — there's no route that calls this.
 *
 * @internal
 */
export function seedActiveDevice(
  store: DeviceStore,
  label: string,
  credentialId = `seed-${randomBytes(8).toString('hex')}`,
): { device: Device; sessionId: string } {
  const device: Device = {
    id: randomUUID(),
    label,
    credentialId,
    publicKey: '',
    counter: 0,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
    status: 'active',
  };
  return store.__addForTest(device);
}
