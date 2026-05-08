import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Config } from '../config/schema.js';
import { SessionManager } from '../session/manager.js';
import { buildServer } from './server.js';

const userToken = 'a'.repeat(32);
const internalHookToken = 'h'.repeat(32);

const baseConfig: Config = {
  port: 7878,
  bindHost: '127.0.0.1',
  claudeBin: 'sh',
  scrollbackBytes: 4096,
  tokens: [{ label: 'laptop', token: userToken }],
  projects: [{ id: 'demo', name: 'Demo', cwd: process.cwd() }],
};

describe('REST API', () => {
  let mgr: SessionManager;
  let app: FastifyInstance;

  beforeEach(async () => {
    mgr = new SessionManager();
    app = await buildServer({
      config: baseConfig,
      manager: mgr,
      internalHookToken,
    });
  });

  afterEach(async () => {
    await mgr.killAll();
    await app.close();
  });

  it('healthz is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('rejects requests without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects requests with an invalid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: 'Bearer notvalid' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('lists projects with a valid token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { projects: Array<{ id: string; name: string; cwd: string }> };
    expect(body.projects).toHaveLength(1);
    expect(body.projects[0]?.id).toBe('demo');
  });

  it('accepts query token as fallback', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/projects?token=${userToken}`,
    });
    expect(res.statusCode).toBe(200);
  });

  it('history endpoint returns array even when no on-disk history', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/demo/history',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { history: unknown[] };
    expect(Array.isArray(body.history)).toBe(true);
  });

  it('history endpoint 404s for unknown project', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/projects/nope/history',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('creates a fresh session, lists it, and deletes it', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    expect(create.statusCode).toBe(201);
    const session = create.json() as { id: string; mode: string; state: string };
    expect(session.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.mode).toBe('fresh');

    const list = await app.inject({
      method: 'GET',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    const listBody = list.json() as { sessions: Array<{ id: string }> };
    expect(listBody.sessions).toHaveLength(1);
    expect(listBody.sessions[0]?.id).toBe(session.id);

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/sessions/${session.id}`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(del.statusCode).toBe(204);
  });

  it('rejects invalid create body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'resume' /* missing sessionId */ },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown projectId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      payload: { projectId: 'ghost', mode: 'fresh' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('delete returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/sessions/00000000-0000-0000-0000-000000000000',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hook endpoint rejects user token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hook/abc/Stop',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it('hook endpoint with internal token returns 404 for unknown session', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/hook/missing-session-id/Stop',
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('hook endpoint rejects unknown event names', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/MadeUpEvent`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('hook endpoint accepts valid Stop for live session', async () => {
    const create = await app.inject({
      method: 'POST',
      url: '/api/sessions',
      headers: { Authorization: `Bearer ${userToken}`, 'content-type': 'application/json' },
      payload: { projectId: 'demo', mode: 'fresh' },
    });
    const sid = (create.json() as { id: string }).id;

    const res = await app.inject({
      method: 'POST',
      url: `/api/hook/${sid}/Stop`,
      headers: { Authorization: `Bearer ${internalHookToken}` },
    });
    expect(res.statusCode).toBe(204);
  });

  it('404 for unknown route returns standard error envelope', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/nope',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'not_found', message: 'route not found' },
    });
  });
});
