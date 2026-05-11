import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionManager } from '../session/manager.js';
import { encodeProjectCwd } from './history.js';
import { buildServer } from './server.js';
import {
  baseConfig,
  CLI_TOKEN,
  INTERNAL_HOOK_TOKEN,
  setupProjects,
  type TestProjectsEnv,
} from './server.test-helpers.js';

describe('REST API with historyRoot for resume validation', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;
  let historyRoot: string;
  let env: TestProjectsEnv;

  beforeEach(async () => {
    env = setupProjects();
    historyRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-srv-hist-'));
    const projDir = join(historyRoot, encodeProjectCwd(env.demoCwd));
    mkdirSync(projDir, { recursive: true });
    writeFileSync(
      join(projDir, 'known-session.jsonl'),
      JSON.stringify({ type: 'user', message: { content: 'old' } }) + '\n',
    );

    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      projectStore: env.projectStore,
      deviceStore: env.deviceStore,
      internalHookToken: INTERNAL_HOOK_TOKEN,
      cliToken: CLI_TOKEN,
      historyRoot,
      webDistDir: null,
      injectCcSessionId: false,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
    rmSync(historyRoot, { recursive: true, force: true });
    env.cleanup();
  });

  it('accepts resume when sessionId exists in history', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume', sessionId: 'known-session' },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { mode: string }).mode).toBe('resume');
  });

  it('rejects resume when sessionId is not in history (boundary)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { cookie: env.authCookie, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume', sessionId: 'never-was' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid_resume');
  });
});
