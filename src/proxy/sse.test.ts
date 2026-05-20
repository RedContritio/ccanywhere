import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { extractSseUsage, splitSseChunks } from './sse.js';
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

function mockFetch(resp: MockResp): typeof fetch {
  return (async () =>
    new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    })) as typeof fetch;
}

const credentials = { apiKey: 'sk-ant-owner-secret' };

const SSE_BODY = [
  'event: message_start',
  `data: ${JSON.stringify({
    type: 'message_start',
    message: {
      id: 'x',
      model: 'claude-opus-4-7',
      usage: { input_tokens: 1_000_000 },
    },
  })}`,
  '',
  'event: content_block_delta',
  `data: ${JSON.stringify({
    type: 'content_block_delta',
    delta: { text: 'hi' },
  })}`,
  '',
  'event: message_delta',
  `data: ${JSON.stringify({
    type: 'message_delta',
    delta: {},
    usage: { output_tokens: 1_000_000 },
  })}`,
  '',
  'event: message_stop',
  'data: {"type":"message_stop"}',
  '',
  '',
].join('\n');

describe('POST /v1/messages — SSE streaming', () => {
  it('pipes SSE chunks + meters from message_start/delta on 2xx', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const usageCalls: number[] = [];
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
        fetchImpl: mockFetch({
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: SSE_BODY,
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: message_start');
    expect(res.body).toContain('event: message_stop');
    await new Promise<void>((r) => setImmediate(r));
    expect(usageCalls).toHaveLength(1);
    // opus: 15 in + 75 out per 1M
    expect(usageCalls[0]).toBeCloseTo(15 + 75);
    await app.close();
  });

  it('does NOT meter SSE on non-2xx (D3)', async () => {
    const issuer = mkIssuer();
    const { token } = issuer.issue('alice');
    const usageCalls: number[] = [];
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
        fetchImpl: mockFetch({
          status: 503,
          headers: { 'content-type': 'text/event-stream' },
          body: SSE_BODY,
        }),
      },
    });
    await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', stream: true, messages: [] },
    });
    await new Promise<void>((r) => setImmediate(r));
    expect(usageCalls).toHaveLength(0);
    await app.close();
  });
});

describe('copyForwardHeaders (content-encoding stripping)', () => {
  it('strips content-encoding so cc does not double-decompress', async () => {
    // Reproduce real anthropic behavior: upstream returns gzip header
    // but undici's fetch presents decompressed body. If proxy forwards
    // the header verbatim, cc tries to decompress plaintext → ZlibError.
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
          status: 200,
          headers: {
            'content-type': 'application/json',
            'content-encoding': 'gzip',
            'content-length': '999',
          },
          body: '{"id":"x","content":[{"type":"text","text":"hi"}]}',
        }),
      },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: { authorization: `Bearer ${token}` },
      payload: { model: 'claude-opus-4-7', messages: [] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    // fastify recomputes content-length from actual body bytes — don't
    // assert undefined (it'll be the plaintext length, not upstream's
    // gzipped length).
    // body is plaintext, cc would JSON-parse it directly
    expect(res.body).toContain('"text":"hi"');
    await app.close();
  });
});

describe('SSE parser helpers', () => {
  it('splitSseChunks: events on \\n\\n + trailing remainder', () => {
    const { events, remainder } = splitSseChunks(
      'event: a\ndata: 1\n\nevent: b\ndata: 2\n\nevent: c\ndata: 3',
    );
    expect(events).toEqual(['event: a\ndata: 1', 'event: b\ndata: 2']);
    expect(remainder).toBe('event: c\ndata: 3');
  });

  it('extractSseUsage: message_start populates model + input', () => {
    const accum: Record<string, number | undefined> = {};
    let m = '';
    extractSseUsage(
      `event: message_start\ndata: ${JSON.stringify({
        message: { model: 'claude-opus-4-7', usage: { input_tokens: 100 } },
      })}`,
      accum,
      (v) => {
        m = v;
      },
    );
    expect(m).toBe('claude-opus-4-7');
    expect(accum['input_tokens']).toBe(100);
  });

  it('extractSseUsage: message_delta overwrites output (cumulative)', () => {
    const accum: Record<string, number | undefined> = { input_tokens: 100 };
    extractSseUsage(
      `event: message_delta\ndata: ${JSON.stringify({
        usage: { output_tokens: 50 },
      })}`,
      accum,
      () => {},
    );
    expect(accum).toEqual({ input_tokens: 100, output_tokens: 50 });
  });

  it('extractSseUsage: ignores garbage / malformed JSON', () => {
    const accum: Record<string, number | undefined> = {};
    expect(() => {
      extractSseUsage('not an SSE event', accum, () => {});
      extractSseUsage('event: x\ndata: {malformed', accum, () => {});
    }).not.toThrow();
    expect(accum).toEqual({});
  });
});
