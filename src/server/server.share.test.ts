import {
  mkdirSync,
  rmSync,
  writeFileSync,
  existsSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { FastifyInstance } from 'fastify';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import { ccJsonlPathOf } from '../quota/path.js';
import { SessionManager } from '../session/manager.js';
import { SessionRegistry } from '../session/registry.js';
import { ShareStore } from '../share/store.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

/**
 * Share endpoints integration test ( C2).
 *
 * jsonl side-effect: each test writes a real cc-style jsonl into
 * `<homedir>/.claude/projects/<encoded-cwd>/<id>.jsonl`. The cwd is
 * a tmp dir per test so the encoded-path is unique and never
 * collides with real user cc data; afterEach unlinks the file +
 * cleans the projects subdir.
 */
describe('share endpoints', () => {
  let env: TestProjectsEnv;
  let regDir: string;
  let shareDir: string;
  let registry: SessionRegistry;
  let store: ShareStore;
  let mgr: SessionManager;
  let app: FastifyInstance;
  const sessionId = '11111111-2222-4333-8444-555555555555';
  let jsonlPath: string;
  let ccProjectDir: string;

  const SAMPLE_JSONL = [
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content: 'hello cc' },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hi there' }],
      },
    }),
  ].join('\n');

  beforeEach(async () => {
    env = setupProjects();
    regDir = await mkdtemp(join(tmpdir(), 'cc-share-reg-'));
    shareDir = await mkdtemp(join(tmpdir(), 'cc-share-store-'));
    registry = new SessionRegistry(regDir);
    store = new ShareStore(shareDir);
    mgr = new SessionManager({ registry });

    // Seed a dead-stub for the test session pointing at the real demo
    // cwd so projectStore.get works.
    await registry.save(
      {
        id: sessionId,
        projectId: 'demo',
        cwd: env.demoCwd,
        mode: 'create',
        createdAt: 1_700_000_000_000,
        userId: env.owner.id,
      },
      null,
    );
    mgr.loadDeadStubs(Date.now());

    // Write the cc jsonl at the path the share route expects.
    jsonlPath = ccJsonlPathOf(env.demoCwd, sessionId);
    ccProjectDir = dirname(jsonlPath);
    mkdirSync(ccProjectDir, { recursive: true });
    writeFileSync(jsonlPath, SAMPLE_JSONL, 'utf8');

    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      userStore: env.userStore,
      tokenStore: env.tokenStore,
      shareStore: store,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await mgr.detach();
    await app.close();
    if (existsSync(jsonlPath)) rmSync(jsonlPath);
    // The encoded-cwd dir is unique per tmpdir, safe to nuke.
    if (existsSync(ccProjectDir)) rmSync(ccProjectDir, { recursive: true });
    await rm(regDir, { recursive: true, force: true });
    await rm(shareDir, { recursive: true, force: true });
    env.cleanup();
  });

  describe('POST /api/share', () => {
    it('creates a share record + html and returns 201 with public URL', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as {
        code: string;
        url: string;
        expiresAt: number | null;
      };
      expect(body.code).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(body.url).toBe(`http://localhost:7878/share/${body.code}`);
      expect(body.expiresAt).not.toBeNull();
      expect(store.load(body.code)).not.toBeUndefined();
      expect(store.loadHtml(body.code)).toContain('hello cc');
      expect(store.loadHtml(body.code)).toContain('hi there');
    });

    it('honors ttlMs: null = never expire', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId, ttlMs: null },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { expiresAt: number | null };
      expect(body.expiresAt).toBeNull();
    });

    it('caps oversized ttlMs to ~10y', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId, ttlMs: 1_000_000_000_000 },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { expiresAt: number };
      const tenYearsMs = 10 * 365 * 24 * 60 * 60 * 1000;
      expect(body.expiresAt - Date.now()).toBeLessThanOrEqual(tenYearsMs);
    });

    it('404 when caller is not session owner (no existence leak)', async () => {
      const other = env.createUserWithToken('intruder');
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: other.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId },
      });
      expect(res.statusCode).toBe(404);
    });

    it('404 jsonl_missing when cc log file is gone', async () => {
      rmSync(jsonlPath);
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe(
        'jsonl_missing',
      );
    });

    it('400 invalid_request on bad body', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId: 123 },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /share/:code (public, no auth)', () => {
    it('returns HTML with immutable cache headers', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId },
      });
      const { code } = create.json() as { code: string };
      const view = await app.inject({ method: 'GET', url: `/share/${code}` });
      expect(view.statusCode).toBe(200);
      expect(view.headers['content-type']).toMatch(/text\/html/);
      expect(view.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
      expect(view.body).toMatch(/^<!DOCTYPE html>/);
      expect(view.body).toContain('hello cc');
    });

    it('does NOT require auth cookie (public path)', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: {
          cookie: env.authCookie,
          'content-type': 'application/json',
        },
        payload: { sessionId },
      });
      const { code } = create.json() as { code: string };
      const view = await app.inject({ method: 'GET', url: `/share/${code}` });
      expect(view.statusCode).toBe(200);
    });

    it('404 on malformed code (regex reject before fs)', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/share/../etc/passwd',
      });
      expect(res.statusCode).toBe(404);
    });

    it('404 on unknown code', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/share/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/share/list', () => {
    it("returns only the caller's shares, newest first", async () => {
      const a = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { sessionId },
      });
      // small spacing so createdAt differs reliably
      await new Promise((resolve) => setTimeout(resolve, 5));
      const b = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { sessionId },
      });
      const list = await app.inject({
        method: 'GET',
        url: '/api/share/list',
        headers: { cookie: env.authCookie },
      });
      expect(list.statusCode).toBe(200);
      const { shares } = list.json() as {
        shares: ReadonlyArray<{ code: string; sessionId: string }>;
      };
      expect(shares).toHaveLength(2);
      const newest = (b.json() as { code: string }).code;
      const older = (a.json() as { code: string }).code;
      expect(shares[0]!.code).toBe(newest);
      expect(shares[1]!.code).toBe(older);
    });

    it("does not include another user's shares", async () => {
      await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { sessionId },
      });
      const other = env.createUserWithToken('other');
      const list = await app.inject({
        method: 'GET',
        url: '/api/share/list',
        headers: { cookie: other.authCookie },
      });
      expect(list.statusCode).toBe(200);
      const { shares } = list.json() as { shares: ReadonlyArray<unknown> };
      expect(shares).toHaveLength(0);
    });
  });

  describe('DELETE /api/share/:code', () => {
    it('owner can delete their own share; subsequent view 404', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { sessionId },
      });
      const { code } = create.json() as { code: string };
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/share/${code}`,
        headers: { cookie: env.authCookie },
      });
      expect(del.statusCode).toBe(204);
      const view = await app.inject({ method: 'GET', url: `/share/${code}` });
      expect(view.statusCode).toBe(404);
    });

    it("404 when caller is not the share's owner-of-record", async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/share',
        headers: { cookie: env.authCookie, 'content-type': 'application/json' },
        payload: { sessionId },
      });
      const { code } = create.json() as { code: string };
      const other = env.createUserWithToken('other');
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/share/${code}`,
        headers: { cookie: other.authCookie },
      });
      expect(del.statusCode).toBe(404);
    });

    it('404 on malformed code', async () => {
      const del = await app.inject({
        method: 'DELETE',
        url: '/api/share/not-a-uuid',
        headers: { cookie: env.authCookie },
      });
      expect(del.statusCode).toBe(404);
    });
  });

  // Sanity: stale homedir / .claude leakage check — we explicitly write
  // under env.demoCwd (a tmp dir) so the encoded path is /private/tmp/...
  // and never overlaps with the real user's cc projects.
  it('jsonl path stays under the unique tmp-derived encoded dir', () => {
    expect(jsonlPath.startsWith(join(homedir(), '.claude', 'projects'))).toBe(
      true,
    );
    expect(jsonlPath).toContain(env.demoCwd.replace(/\//g, '-'));
  });
});
