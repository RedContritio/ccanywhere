import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachHeartbeat, type HeartbeatTarget } from './heartbeat.js';

class MockSocket extends EventEmitter implements HeartbeatTarget {
  pings = 0;
  terminated = false;
  ping(): void {
    this.pings++;
  }
  terminate(): void {
    this.terminated = true;
  }
  // EventEmitter's on/off already match the HeartbeatTarget signature.
  pong(): void {
    this.emit('pong');
  }
}

describe('attachHeartbeat', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects timeoutMs <= intervalMs', () => {
    const sock = new MockSocket();
    expect(() => attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 100 })).toThrow(
      RangeError,
    );
    expect(() => attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 50 })).toThrow(
      RangeError,
    );
  });

  it('pings periodically and does not terminate while pong arrives', () => {
    const sock = new MockSocket();
    attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 300 });

    vi.advanceTimersByTime(100);
    expect(sock.pings).toBe(1);
    sock.pong();

    vi.advanceTimersByTime(100);
    expect(sock.pings).toBe(2);
    sock.pong();

    vi.advanceTimersByTime(200);
    expect(sock.pings).toBe(4);
    expect(sock.terminated).toBe(false);
  });

  it('terminates when no pong arrives for longer than timeoutMs', () => {
    const sock = new MockSocket();
    attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 300 });

    // Each tick: ping fires; we never pong.
    vi.advanceTimersByTime(100); // pings=1, lastPongAt unchanged from init
    vi.advanceTimersByTime(100); // pings=2
    vi.advanceTimersByTime(100); // pings=3, gap = 300, NOT > 300
    expect(sock.terminated).toBe(false);
    vi.advanceTimersByTime(100); // gap = 400 > 300 → terminate
    expect(sock.terminated).toBe(true);
  });

  it('stops pinging after termination', () => {
    const sock = new MockSocket();
    attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 200 });

    vi.advanceTimersByTime(500);
    expect(sock.terminated).toBe(true);
    const pingsAtTermination = sock.pings;
    vi.advanceTimersByTime(1000);
    expect(sock.pings).toBe(pingsAtTermination);
  });

  it('returned dispose stops the heartbeat without terminating', () => {
    const sock = new MockSocket();
    const detach = attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 300 });

    vi.advanceTimersByTime(150);
    expect(sock.pings).toBe(1);
    detach();
    vi.advanceTimersByTime(1000);
    expect(sock.pings).toBe(1);
    expect(sock.terminated).toBe(false);
  });

  it('pong listener is removed on dispose', () => {
    const sock = new MockSocket();
    const detach = attachHeartbeat(sock, { intervalMs: 100, timeoutMs: 300 });
    expect(sock.listenerCount('pong')).toBe(1);
    detach();
    expect(sock.listenerCount('pong')).toBe(0);
  });
});
