import { describe, expect, it } from 'vitest';
import { buildProxyServer } from './server.js';

describe('buildProxyServer', () => {
  it('responds 200 to HEAD / (claude startup probe, spike F5)', async () => {
    const app = await buildProxyServer({
      credentials: { apiKey: 'sk-ant-test' },
    });
    const res = await app.inject({ method: 'HEAD', url: '/' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('HEAD / works in degraded mode too (probe predates auth)', async () => {
    const app = await buildProxyServer({ credentials: null });
    const res = await app.inject({ method: 'HEAD', url: '/' });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('GET /healthz returns ok:true + mode=ready when credentials loaded', async () => {
    const app = await buildProxyServer({
      credentials: { apiKey: 'sk-ant-test' },
    });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: 'ready' });
    await app.close();
  });

  it('GET /healthz returns mode=degraded when credentials missing', async () => {
    const app = await buildProxyServer({ credentials: null });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, mode: 'degraded' });
    await app.close();
  });

  it('returns 404 for unimplemented routes', async () => {
    const app = await buildProxyServer({
      credentials: { apiKey: 'sk-ant-test' },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/messages' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('not_found');
    await app.close();
  });

  it('accepts request bodies up to ~10MB (spike F2)', async () => {
    const app = await buildProxyServer({
      credentials: { apiKey: 'sk-ant-test' },
    });
    // 5MB blob — well under the 10MB cap, would fail under fastify
    // default (~1MB) but pass our raised bodyLimit.
    const big = JSON.stringify({ data: 'x'.repeat(5 * 1024 * 1024) });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { 'content-type': 'application/json' },
      payload: big,
    });
    // 404 (route not implemented) not 413 (payload too large) = bodyLimit honored
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});
