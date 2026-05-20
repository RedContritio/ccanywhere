import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildProxyServer } from './server.js';
import { TokenIssuer } from './tokens.js';
import type { UsageState, UsageStore } from './quota-check.js';

function mkIssuer(): TokenIssuer {
  return new TokenIssuer({ secret: randomBytes(32) });
}

function mkUsageStore(records: Record<string, UsageState | null>): UsageStore {
  return { getUsage: async (id) => records[id] ?? null };
}

interface MockResp {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function mockFetch(
  resp: MockResp,
  captured: { url?: string; init?: RequestInit } = {},
): typeof fetch {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (typeof url === 'string') captured.url = url;
    else if (url instanceof URL) captured.url = url.toString();
    else captured.url = url.url;
    if (init !== undefined) captured.init = init;
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  }) as typeof fetch;
}

const credentials = { apiKey: 'sk-ant-owner-secret' };

describe('POST /v1/messages — auth', () => {
  it('accepts token via X-Api-Key header (cc uses this for cca. prefix)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({ alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 } }),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }),
      },
    });
    const res = await app.inject({ method: 'POST', url: '/v1/messages', headers: { 'x-api-key': token }, payload: { model: 'claude-opus-4-7', messages: [] } });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('401 when no Authorization header', async () => {
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: mkIssuer(),
        usageStore: mkUsageStore({}),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 when bearer token invalid', async () => {
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: mkIssuer(),
        usageStore: mkUsageStore({}),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: 'Bearer garbage' },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('401 when valid token but unknown user (fail-closed, D7)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('ghost');
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({}), // ghost not in store
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /v1/messages — quota', () => {
  it('429 when user over quota', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 10, limit: 10, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().error.code).toBe('quota_exceeded');
    await app.close();
  });
});

describe('POST /v1/messages — forward', () => {
  it('oauthToken (subscription) → Authorization: Bearer upstream', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const captured: { url?: string; init?: RequestInit } = {};
    const app = await buildProxyServer({
      credentials: { oauthToken: 'sk-ant-oat-subscription' },
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: mockFetch(
          { status: 200, headers: {}, body: '{}' },
          captured,
        ),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    const sentHeaders = captured.init?.headers as Record<string, string>;
    expect(sentHeaders['authorization']).toBe(
      'Bearer sk-ant-oat-subscription',
    );
    expect(sentHeaders['x-api-key']).toBeUndefined();
    await app.close();
  });

  it('forwards body + replaces auth header with owner x-api-key', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const captured: { url?: string; init?: RequestInit } = {};
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: mockFetch(
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-opus-4-7',
              usage: { input_tokens: 0, output_tokens: 0 },
            }),
          },
          captured,
        ),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: {
        authorization: `Bearer ${token}`,
        'x-stainless-arch': 'arm64',
        'x-stainless-lang': 'js',
      },
      payload: { model: 'claude-opus-4-7', messages: [{ role: 'user', content: 'hi' }] },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages');

    const sentHeaders = captured.init?.headers as Record<string, string>;
    expect(sentHeaders['x-api-key']).toBe('sk-ant-owner-secret');
    // Bearer must NOT be forwarded
    expect(sentHeaders['authorization']).toBeUndefined();
    // stainless headers must survive (spike F4)
    expect(sentHeaders['x-stainless-arch']).toBe('arm64');
    expect(sentHeaders['x-stainless-lang']).toBe('js');
    await app.close();
  });

  it('preserves ?beta=true query string (spike F1)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const captured: { url?: string; init?: RequestInit } = {};
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: mockFetch(
          { status: 200, headers: {}, body: '{}' },
          captured,
        ),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/messages?beta=true',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(captured.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    await app.close();
  });

  it('recovers when first attempt throws but second succeeds', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    let attempts = 0;
    const fetchImpl = (() => {
      attempts++;
      if (attempts === 1) throw new Error('first attempt fails');
      return Promise.resolve(
        new Response('{"ok":true}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }) as unknown as typeof fetch;
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(attempts).toBe(2);
    await app.close();
  });

  it('502 when upstream throws on all 3 retry attempts', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    let attempts = 0;
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: (() => {
          attempts++;
          throw new Error('network down');
        }) as unknown as typeof fetch,
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(502);
    expect(attempts).toBe(3);
    await app.close();
  });

  it('returns upstream status verbatim (5xx not 502)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async () => {},
        fetchImpl: mockFetch({
          status: 529,
          headers: { 'content-type': 'application/json' },
          body: '{"type":"error","error":{"type":"overloaded_error"}}',
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(529);
    await app.close();
  });
});

describe('POST /v1/messages — metering', () => {
  it('records cost on 2xx', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const usageCalls: Array<{ userId: string; cost: number }> = [];
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async (userId, cost) => {
          usageCalls.push({ userId, cost });
        },
        fetchImpl: mockFetch({
          status: 200,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-7',
            usage: { input_tokens: 1_000_000, output_tokens: 0 },
          }),
        }),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(usageCalls).toHaveLength(1);
    expect(usageCalls[0]?.userId).toBe('alice');
    expect(usageCalls[0]?.cost).toBeCloseTo(15); // opus input 15/1M
    await app.close();
  });

  it('does NOT record cost on 5xx (D3: SDK retry safety)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const usageCalls: Array<{ userId: string; cost: number }> = [];
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async (userId, cost) => {
          usageCalls.push({ userId, cost });
        },
        fetchImpl: mockFetch({
          status: 500,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-opus-4-7',
            usage: { input_tokens: 1_000_000, output_tokens: 1_000_000 },
          }),
        }),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(usageCalls).toHaveLength(0);
    await app.close();
  });
});

describe('GET /v1/models (D6 reserved)', () => {
  it('returns 404 with reserved code', async () => {
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: mkIssuer(),
        usageStore: mkUsageStore({}),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({ method: 'GET', url: '/v1/models' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('reserved');
    await app.close();
  });
});

describe('POST /v1/messages/count_tokens', () => {
  it('still requires bearer (auth gate)', async () => {
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: mkIssuer(),
        usageStore: mkUsageStore({}),
        addUsage: async () => {},
        fetchImpl: mockFetch({ status: 200, headers: {}, body: '{}' }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('forwards but does NOT meter (count_tokens is free upstream)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const usageCalls: number[] = [];
    const captured: { url?: string } = {};
    const app = await buildProxyServer({
      credentials,
      forward: {
        tokenIssuer: issuer,
        usageStore: mkUsageStore({
          alice: { used: 0, limit: 100, resetAt: Date.now() + 60_000 },
        }),
        addUsage: async (_uid, cost) => {
          usageCalls.push(cost);
        },
        fetchImpl: mockFetch(
          {
            status: 200,
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              model: 'claude-opus-4-7',
              usage: { input_tokens: 1_000_000, output_tokens: 0 },
            }),
          },
          captured,
        ),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages/count_tokens',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(captured.url).toBe(
      'https://api.anthropic.com/v1/messages/count_tokens',
    );
    expect(usageCalls).toHaveLength(0); // NOT metered
    await app.close();
  });
});

