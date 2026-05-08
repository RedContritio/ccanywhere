import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Config } from '../config/schema.js';
import { ProjectStore } from '../projects/store.js';
import { SessionManager } from '../session/manager.js';
import { buildServer } from '../server/server.js';
import type { ServerFrame } from './protocol.js';

const userToken = 'a'.repeat(32);
const internalHookToken = 'h'.repeat(32);

const config: Config = {
  port: 0,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  tokens: [{ label: 'laptop', token: userToken }],
  projectsRoot: '/tmp/ccanywhere-test-placeholder',
};

interface Harness {
  app: FastifyInstance;
  manager: SessionManager;
  port: number;
  projectsRoot: string;
}

async function startServer(): Promise<Harness> {
  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-ws-projects-'));
  mkdirSync(join(projectsRoot, 'demo'));
  const projectStore = new ProjectStore({
    projectsRoot,
    statePath: join(projectsRoot, '.projects-state.json'),
  });
  const manager = new SessionManager();
  const app = await buildServer({
    config,
    manager,
    projectStore,
    internalHookToken,
    webDistDir: null,
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const addr = app.server.address() as AddressInfo;
  return { app, manager, port: addr.port, projectsRoot };
}

async function createSession(h: Harness): Promise<string> {
  const res = await h.app.inject({
    method: 'POST',
    url: '/api/sessions',
    headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
    payload: { projectId: 'demo', mode: 'fresh' },
  });
  return (res.json() as { id: string }).id;
}

interface TrackedClient {
  ws: WebSocket;
  waitFor<T extends ServerFrame['type']>(
    type: T,
    timeoutMs?: number,
  ): Promise<Extract<ServerFrame, { type: T }>>;
}

function connect(port: number, sessionId: string, token: string): TrackedClient {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sessionId}?token=${token}`);
  const buffered: ServerFrame[] = [];
  const waiters: Array<{
    type: ServerFrame['type'];
    resolve: (frame: ServerFrame) => void;
    timer: NodeJS.Timeout;
  }> = [];

  ws.on('message', (raw: WebSocket.RawData) => {
    const frame = JSON.parse(raw.toString()) as ServerFrame;
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

  return { ws, waitFor };
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

  it('rejects connection without token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/anything`);
    const result = await waitUnexpected(ws);
    expect(result.code).toBe(401);
    ws.terminate();
  });

  it('rejects connection with invalid token', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/ws/sessions/anything?token=wrong`);
    const result = await waitUnexpected(ws);
    expect(result.code).toBe(401);
    ws.terminate();
  });

  it('closes immediately for unknown session id', async () => {
    const c = connect(h.port, '00000000-0000-0000-0000-000000000000', userToken);
    await waitOpen(c.ws);
    const err = await c.waitFor('error');
    expect(err.message).toMatch(/session not found/);
    await new Promise<void>((resolve) => c.ws.once('close', () => resolve()));
  });

  it('delivers snapshot then status on connect', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
    await waitOpen(c.ws);
    const snap = await c.waitFor('snapshot');
    expect(typeof snap.data).toBe('string');
    const status = await c.waitFor('status');
    expect(status.state).toBe('idle');
    c.ws.close();
  });

  it('forwards input to the PTY and broadcasts output back', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'input', data: 'echo cc-marker\n' }));
    const output = await c.waitFor('output', 6000);
    expect(output.data).toMatch(/cc-marker/);
    c.ws.close();
  });

  it('responds to ping with pong', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'ping' }));
    const pong = await c.waitFor('pong');
    expect(pong.type).toBe('pong');
    c.ws.close();
  });

  it('rejects invalid frames with an error frame', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
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
    const c1 = connect(h.port, id, userToken);
    const c2 = connect(h.port, id, userToken);
    await Promise.all([waitOpen(c1.ws), waitOpen(c2.ws)]);
    await Promise.all([c1.waitFor('snapshot'), c2.waitFor('snapshot')]);

    c1.ws.send(JSON.stringify({ type: 'input', data: 'echo dual-marker\n' }));
    const [o1, o2] = await Promise.all([
      c1.waitFor('output', 6000),
      c2.waitFor('output', 6000),
    ]);
    expect(o1.data + o2.data).toMatch(/dual-marker/);
    c1.ws.close();
    c2.ws.close();
  });

  it('closes all clients when the session dies', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
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

  it('accepts resize without throwing', async () => {
    const id = await createSession(h);
    const c = connect(h.port, id, userToken);
    await waitOpen(c.ws);
    await c.waitFor('snapshot');

    c.ws.send(JSON.stringify({ type: 'resize', cols: 120, rows: 40 }));
    c.ws.send(JSON.stringify({ type: 'ping' }));
    await c.waitFor('pong');
    c.ws.close();
  });
});
