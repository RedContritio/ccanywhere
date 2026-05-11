import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

describe('REST API SPA fallback', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let webDistDir: string;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    webDistDir = mkdtempSync(join(tmpdir(), 'ccanywhere-web-'));
    writeFileSync(
      join(webDistDir, 'index.html'),
      '<!doctype html><html><body data-test="spa">spa-marker</body></html>',
    );
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    rmSync(webDistDir, { recursive: true, force: true });
    env.cleanup();
  });

  it('GET / serves index.html when web/dist exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-marker');
    expect(res.headers['content-type']).toMatch(/text\/html/);
  });

  it('unknown SPA path falls back to index.html', async () => {
    const res = await app.inject({ method: 'GET', url: '/workspace/abc-123' });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('spa-marker');
  });

  it('does not affect /api/* priority', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });

  it('healthz still returns JSON', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('REST API without web/dist', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
  });

  it('unknown route still returns envelope when SPA disabled', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/somewhere',
      headers: { cookie: env.authCookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not_found' } });
  });
});
