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
 * Forward: rewrite auth to owner credentials (Bearer oauthToken
 *   when present — Claude subscription path; else X-Api-Key for
 *   Console billing), preserve all stainless-* headers (spike F4),
 *   forward query string (spike F1)
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
          '/v1/models reserved follow-up',
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
  // 1. Auth: accept Authorization: Bearer OR X-Api-Key.
  // cc decides which header to use based on token prefix —
  // sk-ant-oat-... → Bearer, sk-ant-... → X-Api-Key. Our refreshed
  // bearer carries the `cca.` prefix ( D2 token
  // format), so cc treats it as a Console-style API key and sends it
  // via X-Api-Key. Accept both shapes and run the same TokenIssuer
  // verify either way — the HMAC validates regardless of header.
  const authHeader = req.headers.authorization;
  const apiKeyHeader = req.headers['x-api-key'];
  let presented: string | undefined;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    presented = authHeader.slice('Bearer '.length).trim();
  } else if (typeof apiKeyHeader === 'string') {
    presented = apiKeyHeader.trim();
  } else if (Array.isArray(apiKeyHeader) && typeof apiKeyHeader[0] === 'string') {
    presented = apiKeyHeader[0].trim();
  }
  if (presented === undefined || presented.length === 0) {
    await reply.code(401).send({
      error: { code: 'unauthorized', message: 'missing bearer token' },
    });
    return;
  }
  const verified = deps.tokenIssuer.verify(presented);
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
  // Owner auth: oauthToken (subscription, Bearer) wins over apiKey
  // (Console, X-Api-Key) when both present.
  if (deps.credentials.oauthToken !== undefined) {
    upstreamHeaders['authorization'] = `Bearer ${deps.credentials.oauthToken}`;
  } else if (deps.credentials.apiKey !== undefined) {
    upstreamHeaders['x-api-key'] = deps.credentials.apiKey;
  }

  const body =
    req.body !== undefined && req.body !== null
      ? JSON.stringify(req.body)
      : undefined;

  // 4. Upstream call. Retry on transient network failures — observed
  // intermittent "Client network socket disconnected before secure TLS
  // connection was established" on macOS → cloudflare, particularly on
  // the first request after the proxy starts. Two retries with short
  // backoff cover the common transient cases; persistent failures still
  // surface 502 to cc, which then displays its own retry UI.
  const fetchImpl = deps.fetchImpl ?? fetch;
  const requestInit: RequestInit = {
    method: 'POST',
    headers: upstreamHeaders,
  };
  if (body !== undefined) requestInit.body = body;
  const RETRY_DELAYS_MS = [0, 200, 600];
  let upstreamResp: Response | undefined;
  let lastErr: unknown = null;
  for (const delay of RETRY_DELAYS_MS) {
    if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      upstreamResp = await fetchImpl(upstreamUrl.toString(), requestInit);
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (upstreamResp === undefined) {
    logger.error(
      { err: lastErr, url: upstreamUrl.toString(), attempts: RETRY_DELAYS_MS.length },
      'upstream fetch failed after retries',
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
