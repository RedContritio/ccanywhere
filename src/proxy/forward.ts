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
import { copyForwardHeaders, forwardSseResponse } from './sse.js';
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
    await handleForward(req, reply, deps, {
      upstreamPath: '/v1/messages',
      allowMeter: true,
    });
  });

  // count_tokens is Anthropic-side free (no quota burn). We still
  // require bearer + check quota — gating access to upstream, not
  // metering — but skip recording any usage on response.
  app.post('/v1/messages/count_tokens', async (req, reply) => {
    await handleForward(req, reply, deps, {
      upstreamPath: '/v1/messages/count_tokens',
      allowMeter: false,
    });
  });

  // D6: model discovery reserved. Returning 404 with explicit reason
  // makes the gap loud if a future ccanywhere user enables
  // CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1.
  app.get('/v1/models', async (_req, reply) => {
    await reply.code(404).send({
      error: {
        code: 'reserved',
        message:
          '/v1/models reserved follow-up (m-anthropic-proxy-models)',
      },
    });
  });
}

interface RouteOpts {
  readonly upstreamPath: string;
  readonly allowMeter: boolean;
}

async function handleForward(
  req: FastifyRequest,
  reply: FastifyReply,
  deps: ForwardDeps,
  route: RouteOpts,
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
  const upstreamUrl = new URL(route.upstreamPath, baseUrl);
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

  // 5. SSE branch (claude SDK uses streaming for /v1/messages when
  // body has `stream: true`; count_tokens never streams). Detect by
  // response content-type to handle both with a single forward path.
  const respContentType = upstreamResp.headers.get('content-type') ?? '';
  if (respContentType.includes('text/event-stream')) {
    await forwardSseResponse(
      reply,
      upstreamResp,
      { addUsage: deps.addUsage },
      verified.userId,
      route.allowMeter,
    );
    return;
  }

  // 6. JSON path: read full body, optional meter, send.
  const respBuf = Buffer.from(await upstreamResp.arrayBuffer());
  const respText = respBuf.toString('utf8');

  if (upstreamResp.ok && route.allowMeter) {
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

  reply.code(upstreamResp.status);
  copyForwardHeaders(reply, upstreamResp.headers);
  await reply.send(respText);
}
