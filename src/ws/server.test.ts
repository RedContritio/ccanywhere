import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Config } from '../config/schema.js';
import { DeviceStore } from '../devices/store.js';
import { ProjectStore } from '../projects/store.js';
import { SessionManager } from '../session/manager.js';
import { buildServer } from '../server/server.js';
import type { ServerFrame } from './protocol.js';

function parseFrame(raw: WebSocket.RawData): ServerFrame {
  const text = Buffer.isBuffer(raw)
    ? raw.toString('utf8')
    : Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.from(raw).toString('utf8');
  return JSON.parse(text) as ServerFrame;
}

const internalHookToken = 'h'.repeat(32);
const cliToken = 'c'.repeat(32);

const config: Config = {
  port: 0,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  projectsRoot: '/tmp/ccanywhere-test-placeholder',
  guestProjectsRoot: '/tmp/ccanywhere-test-guest-placeholder',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
};

interface Harness {
  app: FastifyInstance;
  manager: SessionManager;
  port: number;
  projectsRoot: string;
  authCookie: string;
}

async function startServer(): Promise<Harness> {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-ws-projects-'));
  mkdirSync(join(projectsRoot, 'demo'));
  const projectStore = new ProjectStore({
    projectsRoot,
    statePath: join(projectsRoot, '.projects-state.json'),
  });
  const deviceStore = new DeviceStore({
    statePath: join(projectsRoot, '.devices.json'),
    ownerId: 'test-owner-id',
  });
  const { sessionId } = deviceStore.__seedActiveDevice('test-device');
  const manager = new SessionManager();
  const app = await buildServer({
    config,
    manager,
    projectStore,
    deviceStore,
    internalHookToken,
    cliToken,
    webDistDir: null,
    injectCcSessionId: false,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  return {
    app,
    manager,
    port: addr.port,
    projectsRoot,
    authCookie: `ccanywhere_session=${sessionId}`,
  };
}

async function createSession(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { cookie: h.authCookie, 'content-type': 'application/json' },
    payload: { projectId: 'demo', mode: 'create' },
  });
  return (res.json() as { id: string }).id;
}

interface TrackedClient {
  ws: WebSocket;
  waitFor<T extends ServerFrame['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerFrame, { type: T }>>;
  /**
   * Like waitFor('output') but keeps consuming output frames until one
   * (cumulatively) contains the needle. Necessary because the shell
   * prints its prompt before the test sends `input`, and that prompt
   * arrives as its own output frame — without filtering, waitFor would
   * resolve on the prompt and miss the actual `cc-marker` payload.
   */
  waitForOutputContaining(
    needle: string,
    timeoutMs?: number,
  ): Promise<string>;
}

function connect(port: number, sessionId: string, cookie: string): TrackedClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}`, {
    headers: { cookie },
  });
  // Server defers the snapshot until the first 'resize' message; send a
  // default size on open so we don't burn the 1.5s fallback timeout on
  // every test that calls connect().
  ws.on('open', () => {
    try {
      ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
    } catch {
      // ws may already be closing on rejection paths; ignore.
    }
  });
  const buffered: ServerFrame[] = [];
  const waiters: Array<{
    type: ServerFrame['type'];
    resolve: (frame: ServerFrame) => void;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on('message', (raw: WebSocket.RawData) => {
    const frame = parseFrame(raw);
    const idx = waiters.findIndex((w) => w.type === frame.type);
    if (idx >= 0) {
      const w = waiters[idx];
      if (!w) return;
      clearTimeout(w.timer);
      waiters.splice(idx, 1);
      w.resolve(frame);
      return;
    }
    buffered.push(frame);
  });

  const waitFor = <T extends ServerFrame['type']>(
    type: T,
    timeoutMs = 4000,
  ): Promise<Extract<ServerFrame, { type: T }>> => {
    const idx = buffered.findIndex((f) => f.type === type);
    if (idx >= 0) {
      const [frame] = buffered.splice(idx, 1);
      return Promise.resolve(frame as Extract<ServerFrame, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.type === type);
        if (i >= 0) waiters.splice(i, 1);
        reject(new Error(`timeout waiting for frame type=${type}`));
      }, timeoutMs);
      waiters.push({
        type,
        resolve: (frame: ServerFrame) => resolve(frame as Extract<ServerFrame, { type: T }>),
        timer,
      });
    });
  };

  const waitForOutputContaining = async (
    needle: string,
    timeoutMs = 6000,
  ): Promise<string> => {
    const start = Date.now();
    let acc = '';
    // First sweep buffered output frames already collected.
    for (let i = buffered.length - 1; i >= 0; i--) {
      const f = buffered[i];
      if (f?.type === 'output') {
        acc += f.data;
        buffered.splice(i, 1);
      }
    }
    if (acc.includes(needle)) return acc;
    while (Date.now() - start < timeoutMs) {
      const remaining = timeoutMs - (Date.now() - start);
      if (remaining <= 0) break;
      const frame = await waitFor('output', remaining);
      acc += frame.data;
      if (acc.includes(needle)) return acc;
    }
    throw new Error(`timeout waiting for output containing ${needle}`);
  };

  return { ws, waitFor, waitForOutputContaining };
}

function waitOpen(ws: WebSocket, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitUnexpected(
  ws: WebSocket,
  timeoutMs = 4000,
): Promise<{ code: number | null }> {
  return new Promise((resolve) => {
    let code: number | null = null;
    const timer = setTimeout(() => resolve({ code }), timeoutMs);
    const finish = (c: number | null): void => {
      code = c;
      clearTimeout(timer);
      resolve({ code });
    };
    ws.once('unexpected-response', (_req: unknown, res: { statusCode?: number }) => {
      finish(res.statusCode ?? null);
    });
    ws.once('error', () => {
      // Errors are expected on rejection paths; ignore the err object itself.
    });
    ws.once('close', (c: number) => {
      if (code === null) finish(c);
    });
  });
}

describe('WebSocket /ws/sessions/:id', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(async () => {
    await h.manager.killAll();
    h.app.server.closeAllConnections();
    await h.app.close();
    rmSync(h.projectsRoot, { recursive: true, force: true });
  });

  it('rejects connection without session cookie', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/anything`);
    const result = await waitUnexpected(ws);
    expect(result.code).toBe(401);
    ws.terminate();
  });

  it('rejects connection with invalid session cookie', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/anything`, {
      headers: { cookie: 'ccanywhere_session=wrong' },
    });
    const result = await waitUnexpected(ws);
    expect(result.code).toBe(401);
    ws.terminate();
  });

  it('closes immediately for unknown session id', async () => {
    const c = connect(h.port, '00000000-0000-0000-0000-000000000000', h.authCookie);
    await waitOpen(c.ws);
    const err = await c.waitFor('error');
    expect(err.message).toMatch(/session not found/);
    await new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
  });

  it('delivers snapshot then status on connect', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    const snap = await c.waitFor('snapshot');
    expect(typeof snap.data).toBe('string');
    const status = await c.waitFor('status');
    expect(status.state).toBe('idle');
    c.ws.close();
  });

  it('forwards input to the PTY and broadcasts output back', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'input', data: 'echo cc-marker\n' }));
    const acc = await c.waitForOutputContaining('cc-marker', 6000);
    expect(acc).toMatch(/cc-marker/);
    c.ws.close();
  });

  it('responds to ping with pong', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await c.waitFor('pong');
    expect(pong.type).toBe('pong');
    c.ws.close();
  });

  it('rejects invalid frames with an error frame', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send('not json');
    const err = await c.waitFor('error');
    expect(err.message).toMatch(/invalid json/);

    c.ws.send(JSON.stringify({ type: 'unknown-frame' }));
    const err2 = await c.waitFor('error');
    expect(err2.message).toMatch(/invalid frame/);
    c.ws.close();
  });

  it('broadcasts output to multiple clients on the same session', async () => {
    const id = await createSession(h);
    const c1 = connect(h.port, id, h.authCookie);
    const c2 = connect(h.port, id, h.authCookie);
    await Promise.all([waitOpen(c1.ws), waitOpen(c2.ws)]);
    await Promise.all([c1.waitFor('snapshot'), c2.waitFor('snapshot')]);

    c1.ws.send(JSON.stringify({ type: 'input', data: 'echo dual-marker\n' }));
    const [acc1, acc2] = await Promise.all([
      c1.waitForOutputContaining('dual-marker', 6000),
      c2.waitForOutputContaining('dual-marker', 6000),
    ]);
    expect(acc1).toMatch(/dual-marker/);
    expect(acc2).toMatch(/dual-marker/);
    c1.ws.close();
    c2.ws.close();
  });

  it('closes all clients with 1000 when the session dies (cc self-exit)', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    const closed = new Promise<number>((resolve) =>
      c.ws.once('close', (code: number) => resolve(code)),
    );
    const session = h.manager.get(id);
    expect(session).toBeDefined();
    await session?.kill();
    const code = await closed;
    expect(code).toBe(1000);
  });

  it('closes with 4002 when teardown is DELETE-driven (markDeleted)', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    const closed = new Promise<number>((resolve) =>
      c.ws.once('close', (code: number) => resolve(code)),
    );
    const session = h.manager.get(id);
    expect(session).toBeDefined();
    // markDeleted sets deletedAt + triggers kill — by the time PTY exit
    // fires teardown the session.deletedAt !== null, so close code is 4002.
    session?.markDeleted();
    const code = await closed;
    expect(code).toBe(4002);
  });

  it('accepts resize without throwing', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.waitFor('pong');
    c.ws.close();
  });

  it('snapshot is the first broadcast frame even when PTY is streaming', async () => {
    const id = await createSession(h);
    // First client kicks off a continuous PTY stream so by the time we
    // bring up the second client the broadcast pipe is hot.
    const c1 = connect(h.port, id, h.authCookie);
    await waitOpen(c1.ws);
    await c1.waitFor('snapshot');
    c1.ws.send(
      JSON.stringify({
        type: 'input',
        data: 'while true; do echo gate-marker; sleep 0.005; done\n',
      }),
    );
    await c1.waitForOutputContaining('gate-marker', 4000);

    // Raw collector — connect helper reorders by type, but here we need
    // to assert the actual receive order to catch output-before-snapshot
    // regressions.
    const c2Frames: ServerFrame[] = [];
    const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/${id}`, {
      headers: { cookie: h.authCookie },
    });
    ws2.on('message', (raw: WebSocket.RawData) => {
      c2Frames.push(parseFrame(raw));
    });
    await waitOpen(ws2);
    ws2.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));

    // Initial-state arrives ~200ms after first resize; allow 1s for
    // snapshot + status + a few buffered/post-init output frames.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_000));

    expect(c2Frames.length).toBeGreaterThan(0);
    const firstFrame = c2Frames[0];
    expect(firstFrame?.type).toBe('snapshot');
    // No output frame may precede the snapshot.
    const firstOutputIdx = c2Frames.findIndex((f) => f.type === 'output');
    const snapshotIdx = c2Frames.findIndex((f) => f.type === 'snapshot');
    if (firstOutputIdx >= 0) {
      expect(snapshotIdx).toBeLessThan(firstOutputIdx);
    }

    ws2.close();
    c1.ws.close();
  }, 12_000);

  it('per-socket gate does not interfere with already-active clients', async () => {
    const id = await createSession(h);
    const c1 = connect(h.port, id, h.authCookie);
    await waitOpen(c1.ws);
    await c1.waitFor('snapshot');
    c1.ws.send(
      JSON.stringify({
        type: 'input',
        data: 'while true; do echo c1-marker; sleep 0.01; done\n',
      }),
    );
    await c1.waitForOutputContaining('c1-marker', 4000);

    // Bring up c2; gate engages on c2 only — c1 should keep receiving
    // output uninterrupted.
    const c2Frames: ServerFrame[] = [];
    const ws2 = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/${id}`, {
      headers: { cookie: h.authCookie },
    });
    ws2.on('message', (raw: WebSocket.RawData) => {
      c2Frames.push(parseFrame(raw));
    });
    await waitOpen(ws2);
    ws2.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));

    // Wait for c2 to receive its initial state.
    await new Promise<void>((resolve) => setTimeout(resolve, 800));
    expect(c2Frames[0]?.type).toBe('snapshot');

    // After c2's gate engaged and drained, c1 must still be getting
    // live output for the marker stream.
    await c1.waitForOutputContaining('c1-marker', 2000);

    ws2.close();
    c1.ws.close();
  }, 12_000);

  it('connect-then-close before resize does not crash the server', async () => {
    const id = await createSession(h);
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/${id}`, {
      headers: { cookie: h.authCookie },
    });
    await waitOpen(ws);
    ws.close();
    await new Promise<void>((resolve) => ws.once('close', () => resolve()));

    // Wait past the 1.5s sendInitialState fallback so any post-close
    // drain attempt would surface here.
    await new Promise<void>((resolve) => setTimeout(resolve, 1_700));

    // Server must still serve a fresh client — a stranded pendingClients
    // entry or a fallback-timer crash would manifest as the next connect
    // hanging or being rejected.
    const c = connect(h.port, id, h.authCookie);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');
    c.ws.close();
  }, 8_000);
});
