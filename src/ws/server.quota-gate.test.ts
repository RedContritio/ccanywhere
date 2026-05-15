import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Config } from '../config/schema.js';
import { DeviceStore } from '../devices/store.js';
import { ProjectStore } from '../projects/store.js';
import { SessionManager } from '../session/manager.js';
import { buildServer } from '../server/server.js';
import { TokenStore } from '../tokens/store.js';
import { UserStore } from '../users/store.js';

const internalHookToken = 'h'.repeat(32);
const cliToken = 'c'.repeat(32);

const baseConfig: Config = {
  port: 0,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  workspace: '/tmp/placeholder-workspace',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
};

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

/**
 * Listen for a server frame matching `predicate` within `timeoutMs`.
 * Resolves with the matching parsed frame; rejects on timeout.
 */
/**
 * Frame collector: accumulate all incoming frames into `frames` and
 * provide an awaitable `waitFor(predicate)` that satisfies from already-
 * received frames or future ones. Avoids race between handler register
 * and first frame arrival.
 */
interface FrameCollector<T = unknown> {
  readonly frames: T[];
  waitFor(predicate: (frame: T) => boolean, timeoutMs?: number, debugLabel?: string): Promise<T>;
}

function collectFrames<T = unknown>(ws: WebSocket): FrameCollector<T> {
  const frames: T[] = [];
  const pending: Array<{
    predicate: (frame: T) => boolean;
    resolve: (frame: T) => void;
  }> = [];
  ws.on('message', (buf: Buffer) => {
    let parsed: T;
    try {
      parsed = JSON.parse(buf.toString('utf8')) as T;
    } catch {
      return;
    }
    frames.push(parsed);
    for (let i = 0; i < pending.length; i++) {
      const p = pending[i];
      if (p === undefined) continue;
      if (p.predicate(parsed)) {
        pending.splice(i, 1);
        p.resolve(parsed);
        return;
      }
    }
  });
  return {
    frames,
    waitFor(predicate, timeoutMs = 2000, debugLabel?: string) {
      const existing = frames.find(predicate);
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          const idx = pending.findIndex((p) => p.predicate === predicate);
          if (idx >= 0) pending.splice(idx, 1);
          const why = debugLabel === undefined ? '' : ` (${debugLabel})`;
          reject(
            new Error(`frame timeout${why}; frames=${JSON.stringify(frames)}`),
          );
        }, timeoutMs);
        pending.push({
          predicate,
          resolve: (frame: T) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

/**
 * m-quota-inline: WS input frame quota gate. When the user's quota.used
 * has crossed the limit (typically refreshed asynchronously by
 * QuotaWatcher reading cc's jsonl), the next 'input' frame from the
 * client MUST be dropped before reaching the PTY and the server MUST
 * push a `quota_exhausted` frame. The session stays alive and other
 * frames continue to flow.
 */
describe('WebSocket /ws/sessions/:id quota input gate', () => {
  it('user over tokens limit → next input emits quota_exhausted; cc never sees bytes', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ccanywhere-quota-gate-'));
    const ownerProjectsRoot = join(workspace, 'owner');
    mkdirSync(ownerProjectsRoot);
    mkdirSync(join(ownerProjectsRoot, 'demo'));
    const projectStore = new ProjectStore({
      projectsRoot: ownerProjectsRoot,
      statePath: join(ownerProjectsRoot, '.projects-state.json'),
    });
    const userStore = new UserStore({
      statePath: join(workspace, '.users.json'),
      workspace,
    });
    const owner = userStore.getOwner();
    const tokenStore = new TokenStore({ statePath: join(workspace, '.tokens.json') });
    const deviceStore = new DeviceStore({
      statePath: join(workspace, '.devices.json'),
      ownerId: owner.id,
    });

    const alice = userStore.createUser({
      username: 'alice',
      costLimitUsd: null,
      tokensLimit: 100,
    });
    const aliceProjectDir = join(workspace, 'alice', 'p1');
    mkdirSync(aliceProjectDir, { recursive: true });
    const { plaintext: aliceToken } = tokenStore.issue({
      userId: alice.id,
      ttlMs: 24 * 60 * 60 * 1000,
    });
    const aliceCookie = `ccanywhere_session=${aliceToken}`;

    const manager = new SessionManager();
    const app = await buildServer({
      config: { ...baseConfig, workspace },
      manager,
      projectStore,
      deviceStore,
      userStore,
      tokenStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    try {
      // Spawn alice's session via mgr.spawn (sh PTY; quota gate doesn't
      // actually need cc, only a live PTY to test "input never reaches
      // it" — easiest signal: input frame is rejected pre-write).
      const spawn = manager.spawn({
        projectId: 'alice-p1',
        cwd: aliceProjectDir,
        command: 'sh',
        args: [],
        scrollbackBytes: 4096,
        mode: 'create',
        userId: alice.id,
      });
      if (spawn.kind !== 'created') throw new Error('expected created');
      const aliceSid = spawn.session.info.id;

      // Trip the quota: bypass watcher and write directly via store.
      // This is the post-condition QuotaWatcher would create after cc
      // wrote enough jsonl rows.
      userStore.setQuotaUsage(alice.id, 0, 200); // 200 > 100 limit

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${aliceSid}`, {
        headers: { cookie: aliceCookie },
      });
      const collector = collectFrames<{ type: string; reason?: string; state?: string }>(ws);
      await waitOpen(ws);
      ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      await collector.waitFor(
        (f) => f.type === 'status' && f.state === 'idle',
        5000,
        'status:idle',
      );

      // Send input — gate MUST drop it + push quota_exhausted.
      ws.send(JSON.stringify({ type: 'input', data: 'echo blocked\r' }));
      const frame = await collector.waitFor(
        (f) => f.type === 'quota_exhausted',
        3000,
        'quota_exhausted',
      );
      expect(frame.reason).toMatch(/tokens quota exhausted/);

      // After reset usage, next input passes (no second quota_exhausted).
      userStore.setQuotaUsage(alice.id, 0, 0);
      const before = collector.frames.length;
      ws.send(JSON.stringify({ type: 'input', data: 'echo allowed\r' }));
      await new Promise((r) => setTimeout(r, 300));
      const newQuotaFrames = collector.frames
        .slice(before)
        .filter((f) => f.type === 'quota_exhausted');
      expect(newQuotaFrames).toHaveLength(0);

      // Re-trip the limit and verify focus tracking sequences (auto-emitted
      // by xterm on focus changes) bypass the gate — they're not real user
      // input, popping a dialog every focus shift would block text selection.
      userStore.setQuotaUsage(alice.id, 0, 200);
      const beforeFocus = collector.frames.length;
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[I' }));
      ws.send(JSON.stringify({ type: 'input', data: '\x1b[O' }));
      await new Promise((r) => setTimeout(r, 200));
      const focusBlocks = collector.frames
        .slice(beforeFocus)
        .filter((f) => f.type === 'quota_exhausted');
      expect(focusBlocks).toHaveLength(0);

      ws.close();
    } finally {
      await manager.killAll();
      app.server.closeAllConnections();
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 8_000);

  it('owner: input gate always passes regardless of usage', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ccanywhere-quota-gate-owner-'));
    const ownerProjectsRoot = join(workspace, 'owner');
    mkdirSync(ownerProjectsRoot);
    mkdirSync(join(ownerProjectsRoot, 'demo'));
    const projectStore = new ProjectStore({
      projectsRoot: ownerProjectsRoot,
      statePath: join(ownerProjectsRoot, '.projects-state.json'),
    });
    const userStore = new UserStore({
      statePath: join(workspace, '.users.json'),
      workspace,
    });
    const owner = userStore.getOwner();
    const tokenStore = new TokenStore({ statePath: join(workspace, '.tokens.json') });
    const deviceStore = new DeviceStore({
      statePath: join(workspace, '.devices.json'),
      ownerId: owner.id,
    });
    const { sessionId: ownerSessionId } = deviceStore.__seedActiveDevice('owner-dev');
    const ownerCookie = `ccanywhere_session=${ownerSessionId}`;

    const manager = new SessionManager();
    const app = await buildServer({
      config: { ...baseConfig, workspace },
      manager,
      projectStore,
      deviceStore,
      userStore,
      tokenStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
    const port = (app.server.address() as AddressInfo).port;

    try {
      const spawn = manager.spawn({
        projectId: 'demo',
        cwd: join(ownerProjectsRoot, 'demo'),
        command: 'sh',
        args: [],
        scrollbackBytes: 4096,
        mode: 'create',
        userId: owner.id,
      });
      if (spawn.kind !== 'created') throw new Error('expected created');
      const sid = spawn.session.info.id;

      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${sid}`, {
        headers: { cookie: ownerCookie },
      });
      const collector = collectFrames<{ type: string; reason?: string; state?: string }>(ws);
      await waitOpen(ws);
      ws.send(JSON.stringify({ type: 'resize', cols: 80, rows: 24 }));
      await collector.waitFor(
        (f) => f.type === 'status' && f.state === 'idle',
        5000,
        'status:idle (owner)',
      );

      // Owner kind: gate evaluation always returns blocked=false. Send
      // input and confirm no quota_exhausted frame appears.
      const before = collector.frames.length;
      ws.send(JSON.stringify({ type: 'input', data: 'echo owner\r' }));
      await new Promise((r) => setTimeout(r, 300));
      const blocks = collector.frames
        .slice(before)
        .filter((f) => f.type === 'quota_exhausted');
      expect(blocks).toHaveLength(0);

      ws.close();
    } finally {
      await manager.killAll();
      app.server.closeAllConnections();
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 8_000);
});
