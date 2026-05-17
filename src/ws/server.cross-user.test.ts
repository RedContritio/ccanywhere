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
  proxy: { port: 62276, bindHost: '127.0.0.1' },
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
 * #44 m-multi-user: when a limited user holds a valid token-session cookie
 * and tries to upgrade against an owner-owned session id, the WS server
 * MUST close with 1008 — uniform with not-found, so the response does not
 * leak that the id exists but belongs to another user.
 */
describe('WebSocket /ws/sessions/:id cross-user mask', () => {
  it('alice WS upgrade to owner session → close 1008', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'ccanywhere-ws-xuser-workspace-'));
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
    const tokenStore = new TokenStore({
      statePath: join(workspace, '.tokens.json'),
    });
    const deviceStore = new DeviceStore({
      statePath: join(workspace, '.devices.json'),
      ownerId: owner.id,
    });
    const { sessionId: ownerSessionId } = deviceStore.__seedActiveDevice('owner-dev');
    const ownerCookie = `ccanywhere_session=${ownerSessionId}`;

    const alice = userStore.createUser({
      username: 'alice',
      costLimitUsd: 10,
      tokensLimit: null,
    });
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
      const create = await app.inject({
        method: 'POST',
        url: '/api/sessions',
        headers: { cookie: ownerCookie, 'content-type': 'application/json' },
        payload: { projectId: 'demo', mode: 'create' },
      });
      expect(create.statusCode).toBe(201);
      const ownerSid = (create.json() as { id: string }).id;

      // Auth passes for alice (token cookie valid). But session.info.userId
      // !== alice.id triggers the not-found-mask close.
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/sessions/${ownerSid}`, {
        headers: { cookie: aliceCookie },
      });
      await waitOpen(ws);

      const result = await new Promise<{ code: number; reason: string }>((resolve) => {
        ws.once('close', (code: number, reason: Buffer) => {
          resolve({ code, reason: reason.toString('utf8') });
        });
      });
      expect(result.code).toBe(1008);
      expect(result.reason).toMatch(/session not found/);
    } finally {
      await manager.killAll();
      app.server.closeAllConnections();
      await app.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 8_000);
});
