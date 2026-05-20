import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../../config/schema.js';
import { DeviceStore } from '../../devices/store.js';
import { ProjectStore } from '../../projects/store.js';
import { SessionManager, type Session } from '../../session/manager.js';
import { buildServer } from '../server.js';

const internalHookToken = 'h'.repeat(32);
const cliToken = 'c'.repeat(32);

const baseConfig: Config = {
  port: 7878,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  deletedSessionTtlMs: 600_000,
  wsHeartbeat: { intervalMs: 30_000, timeoutMs: 60_000 },
  outputFps: 60,
  workspace: '/tmp/ccanywhere-test-workspace-placeholder',
  webOrigin: 'http://localhost:7878',
  cookieName: 'ccanywhere_session',
  proxy: { port: 8082, bindHost: '127.0.0.1' },
  isolationPolicy: 'strict',
};

interface TestEnv {
  feedbackRoot: string;
  projectsRoot: string;
  projectStore: ProjectStore;
  deviceStore: DeviceStore;
  demoCwd: string;
  authCookie: string;
  cleanup: () => void;
}

function setup(): TestEnv {
  // Force feedback writes into a tmp HOME so we don't litter the real
  // ~/.config/ccanywhere/feedback during tests.
  const home = mkdtempSync(join(tmpdir(), 'ccanywhere-home-'));
  process.env['HOME'] = home;
  const feedbackRoot = join(home, '.config', 'ccanywhere', 'feedback');

  const projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-projects-'));
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

  return {
    feedbackRoot,
    projectsRoot,
    projectStore,
    deviceStore,
    demoCwd: join(projectsRoot, 'demo'),
    authCookie: `ccanywhere_session=${sessionId}`,
    cleanup: () => {
      rmSync(projectsRoot, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    },
  };
}

describe('POST /api/feedback', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let env: TestEnv;
  let originalHome: string | undefined;

  beforeAll(() => {
    originalHome = process.env['HOME'];
  });

  beforeEach(async () => {
    env = setup();
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken,
      cliToken,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    env.cleanup();
    if (originalHome !== undefined) process.env['HOME'] = originalHome;
  });

  it('rejects body without title', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { body: 'no title here' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('accepts ops arrays at the dogfood ceiling (~7000 entries, beyond client ring)', async () => {
    // Contract guard: server cap is a runaway-input guard set well
    // above the client ring (web/src/state/ops-log.ts MAX_OPS, derived
    // from a 60s × 90 ev/s × 1.2 budget). Submissions at any plausible
    // client size MUST pass — including bursts that briefly exceed the
    // documented client cap due to in-flight events between
    // snapshotOps() and POST. Regression caught manually when this cap
    // was an undertuned 100: dogfood feedback got a silent 400.
    const ops = Array.from({ length: 7_000 }, (_, i) => ({
      ts: 1_700_000_000_000 + i,
      kind: i % 2 === 0 ? 'touch.drag.move' : 'term.write',
      payload: { i },
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { title: 'high-density trace', ops },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects ops arrays beyond the runaway-input guard (20001 entries)', async () => {
    // Above any plausible client ring; only abusive / malformed bodies
    // reach this. The exact ceiling lives in feedback.ts as
    // FEEDBACK_OPS_RUNAWAY_GUARD = 20_000.
    const ops = Array.from({ length: 20_001 }, (_, i) => ({
      ts: 1_700_000_000_000 + i,
      kind: 'noise',
    }));
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { title: 'overflow', ops },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('invalid_request');
  });

  it('persists record with serverInfo even without diag', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { title: 'plain feedback' },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const path = join(env.feedbackRoot, `${id}.json`);
    expect(existsSync(path)).toBe(true);
    const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    expect(record['title']).toBe('plain feedback');
    expect(record['serverInfo']).toBeDefined();
    const serverInfo = record['serverInfo'] as { commitSha: unknown; uptimeMs: unknown };
    expect(typeof serverInfo.commitSha).toBe('string');
    expect(typeof serverInfo.uptimeMs).toBe('number');
    expect(record['diag']).toBeUndefined();
    expect(record['serverSession']).toBeUndefined();
  });

  it('injects serverSession when diag.activeSessionId hits the manager', async () => {
    // Spawn a real session in the manager so the route can read its
    // scrollback / state. `claudeBin: 'sh'` from baseConfig is enough —
    // we don't need cc to actually do anything; we just need a live PTY.
    const spawnResult = mgr.spawn({
      projectId: 'demo',
      cwd: env.demoCwd,
      command: baseConfig.claudeBin,
      args: [],
      scrollbackBytes: 4096,
      mode: 'create',
      userId: 'test-owner-id',
    });
    if (spawnResult.kind !== 'created') {
      throw new Error(`expected created spawn, got ${spawnResult.kind}`);
    }
    const session: Session = spawnResult.session;

    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: {
        title: 'with diag',
        diag: { activeSessionId: session.info.id, viewport: { windowW: 1, windowH: 2, devicePixelRatio: 1 } },
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const record = JSON.parse(readFileSync(join(env.feedbackRoot, `${id}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record['diag']).toMatchObject({ activeSessionId: session.info.id });
    expect(record['serverSession']).toBeDefined();
    const ss = record['serverSession'] as { state: unknown; headSeq: unknown; tailSeq: unknown };
    expect(['starting', 'idle', 'busy', 'dead']).toContain(ss.state);
    expect(typeof ss.headSeq).toBe('number');
    expect(typeof ss.tailSeq).toBe('number');
  });

  it('persists record without serverSession when activeSessionId misses', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/feedback',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: {
        title: 'with stale diag',
        diag: { activeSessionId: 'nonexistent-session-id' },
      },
    });
    expect(res.statusCode).toBe(201);
    const { id } = res.json() as { id: string };
    const record = JSON.parse(readFileSync(join(env.feedbackRoot, `${id}.json`), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(record['diag']).toBeDefined();
    expect(record['serverSession']).toBeUndefined();
    expect(record['serverInfo']).toBeDefined();
  });
});
