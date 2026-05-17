import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { logger } from '../log.js';
import type { OwnerCredentials } from './credentials.js';
import { meterResponse, type ResponseShape } from './metering.js';
import {
  QuotaExceededError,
  UnknownUserError,
  checkQuota,
  type UsageStore,
} from './quota-check.js';
import type { TokenIssuer } from './tokens.js';

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

export interface ForwardDeps {
  readonly credentials: OwnerCredentials;
  readonly tokenIssuer: TokenIssuer;
  readonly usageStore: UsageStore;
  readonly addUsage: (userId: string, costUsd: number) => Promise<void>;
  /** Injectable for tests + future Bedrock/Vertex base URL switching. */
  readonly upstreamBaseUrl?: string;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
}

/**
 * Registers POST /v1/messages. count_tokens and SSE streaming come in C4.
 *
 * Auth: bearer (verified by TokenIssuer) → userId
 * Quota: inline checkQuota → 429 on exceed, 401 on unknown user
 * Forward: rewrite Authorization to owner x-api-key, preserve all
 *   stainless-* headers (spike F4), forward query string (spike F1)
 * Meter: 2xx upstream only (D3: SDK retry safe), parse usage from
 *   response body, addUsage(costUsd) async
 */
export function registerForwardRoutes(
  app: FastifyInstance,
  deps: ForwardDeps,
): void {
  app.post('/v1/messages', async (req, reply) => {
    await handleForward(req, reply, deps);
  });
}

async function handleForward(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ForwardDeps,
): Promise<void> {
  // 1. Bearer auth
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'missing bearer token' },
    });
    return;
  }
  const token = auth.slice('Bearer '.length).trim();
  const verified = deps.tokenIssuer.verify(token);
  if (verified === null) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'invalid token' },
    });
    return;
  }

  // 2. Quota
  try {
    await checkQuota({ userId: verified.userId, store: deps.usageStore });
  } catch (err) {
    if (err instanceof QuotaExceededError) {
      await reply.code(429).send({
        error: {
          code: 'quota_exceeded',
          message: `quota exceeded (${err.used.toFixed(2)} / ${err.limit.toFixed(2)} USD)`,
        },
      });
      return;
    }
    if (err instanceof UnknownUserError) {
      await reply.code(401).send({
        error: { code: 'unauthorized', message: 'unknown user' },
      });
      return;
    }
    throw err;
  }

  // 3. Build upstream request
  const baseUrl = deps.upstreamBaseUrl ?? DEFAULT_UPSTREAM;
  const upstreamUrl = new URL('/v1/messages', baseUrl);
  // spike F1: preserve query string (?beta=true etc.)
  const queryIdx = req.url.indexOf('?');
  if (queryIdx >= 0) {
    upstreamUrl.search = req.url.slice(queryIdx);
  }

  // Header passthrough (spike F4: x-stainless-* must survive).
  // Strip hop-by-hop + authorization (replaced) + content-length (fetch
  // sets fresh).
  const upstreamHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const value = Array.isArray(v) ? v[0] : v;
    if (typeof value !== 'string') continue;
    const lc = k.toLowerCase();
    if (
      lc === 'host' ||
      lc === 'connection' ||
      lc === 'content-length' ||
      lc === 'transfer-encoding' ||
      lc === 'authorization' ||
      lc === 'x-api-key'
    ) {
      continue;
    }
    upstreamHeaders[k] = value;
  }
  upstreamHeaders['x-api-key'] = deps.credentials.apiKey;

  const body =
    req.body !== undefined && req.body !== null
      ? JSON.stringify(req.body)
      : undefined;

  // 4. Upstream call
  const fetchImpl = deps.fetchImpl ?? fetch;
  let upstreamResp: Response;
  const requestInit: RequestInit = {
    method: 'POST',
    headers: upstreamHeaders,
  };
  if (body !== undefined) requestInit.body = body;
  try {
    upstreamResp = await fetchImpl(upstreamUrl.toString(), requestInit);
  } catch (err) {
    logger.error(
      { err, url: upstreamUrl.toString() },
      'upstream fetch failed',
    );
    await reply.code(502).send({
      error: { code: 'upstream_error', message: 'upstream request failed' },
    });
    return;
  }

  // 5. Read body
  const respBuf = Buffer.from(await upstreamResp.arrayBuffer());
  const respText = respBuf.toString('utf8');

  // 6. Meter (only on 2xx — D3 prevents SDK retry double-counting)
  if (upstreamResp.ok) {
    try {
      const parsed = JSON.parse(respText) as ResponseShape;
      const meter = meterResponse(parsed);
      if (meter.costUsd > 0) {
        await deps.addUsage(verified.userId, meter.costUsd);
      }
    } catch (err) {
      logger.warn(
        { err, status: upstreamResp.status },
        'failed to parse upstream response for metering — usage not recorded',
      );
    }
  }

  // 7. Forward response
  reply.code(upstreamResp.status);
  upstreamResp.headers.forEach((value, key) => {
    const lc = key.toLowerCase();
    if (
      lc === 'content-length' ||
      lc === 'connection' ||
      lc === 'transfer-encoding'
    ) {
      return;
    }
    reply.header(key, value);
  });
  await reply.send(respText);
}
