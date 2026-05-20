import type { FastifyReply } from 'fastify';
import { logger } from '../log.js';
import { meterResponse, type UpstreamUsage } from './metering.js';

/**
 * Strip hop-by-hop + length headers when copying upstream → reply.
 * Shared by both JSON and SSE forward paths (forward.ts + sse.ts).
 *
 * `content-encoding` is stripped because undici's fetch implementation
 * transparently decompresses gzip/br/deflate response bodies — by the
 * time we read `await arrayBuffer` / `body.getReader`, the bytes
 * are already plaintext. Forwarding the upstream `content-encoding:
 * gzip` header would tell cc to decompress what is already plain text
 * (ZlibError on cc side, surfaced as "Unable to connect to API").
 */
export function copyForwardHeaders(reply: FastifyReply, src: Headers): void {
  src.forEach((value, key) => {
    const lc = key.toLowerCase();
    if (
      lc === 'content-length' ||
      lc === 'connection' ||
      lc === 'transfer-encoding' ||
      lc === 'content-encoding'
    ) {
      return;
    }
    reply.header(key, value);
  });
}

export interface SseForwardDeps {
  readonly addUsage: (userId: string, costUsd: number) => Promise<void>;
}

/**
 * Stream upstream SSE chunks to client while parsing usage from
 * `message_start` (model + input_tokens) and `message_delta` (cumulative
 * output_tokens). On stream end (only when status 2xx + allowMeter),
 * compute cost and addUsage.
 *
 * SDK retry safety: failed mid-stream means upstream returned non-2xx
 * before SSE began, handled by the JSON path; an aborted SSE mid-flight
 * still meters whatever output_tokens arrived (that's real usage
 * Anthropic billed for).
 */
export async function forwardSseResponse(
  reply: FastifyReply,
  upstreamResp: Response,
  deps: SseForwardDeps,
  userId: string,
  allowMeter: boolean,
): Promise<void> {
  if (upstreamResp.body === null) {
    await reply.code(502).send({
      error: { code: 'upstream_error', message: 'empty SSE body' },
    });
    return;
  }

  reply.code(upstreamResp.status);
  copyForwardHeaders(reply, upstreamResp.headers);
  reply.hijack();
  reply.raw.flushHeaders();

  const reader = upstreamResp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let pendingText = '';
  let model = '';
  const accum: Record<string, number | undefined> = {};

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(Buffer.from(value));
      pendingText += decoder.decode(value, { stream: true });
      const { events, remainder } = splitSseChunks(pendingText);
      pendingText = remainder;
      for (const evt of events) {
        extractSseUsage(evt, accum, (m) => {
          model = m;
        });
      }
    }
  } catch (err) {
    logger.warn({ err }, 'SSE pipe error — closing client conn');
  } finally {
    reply.raw.end();
  }

  if (upstreamResp.ok && allowMeter && model !== '') {
    const meter = meterResponse({
      model,
      usage: accum as UpstreamUsage,
    });
    if (meter.costUsd > 0) {
      await deps.addUsage(userId, meter.costUsd);
    }
  }
}

/**
 * Split SSE buffer on `\n\n` event boundaries. Returns parsed event
 * blocks + any trailing unfinished bytes to keep buffering.
 */
export function splitSseChunks(buf: string): {
  events: string[];
  remainder: string;
} {
  const parts = buf.split('\n\n');
  const remainder = parts.pop() ?? '';
  return { events: parts, remainder };
}

/**
 * Pull `event: <type>` + `data: <json>` from one SSE block, then update
 * accum / model based on Anthropic event shapes:
 * message_start: message.model + message.usage (input_tokens etc).
 * message_delta: usage (cumulative output_tokens).
 * Other events (content_block_*, ping, message_stop) ignored.
 * Malformed blocks or unparseable JSON: silently skip.
 */
export function extractSseUsage(
  block: string,
  accum: Record<string, number | undefined>,
  setModel: (m: string) => void,
): void {
  let eventType = '';
  let dataJson = '';
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice('event: '.length);
    else if (line.startsWith('data: ')) dataJson = line.slice('data: '.length);
  }
  if (dataJson === '') return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataJson);
  } catch {
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) return;
  const obj = parsed as Record<string, unknown>;

  if (
    eventType === 'message_start' &&
    typeof obj['message'] === 'object' &&
    obj['message'] !== null
  ) {
    const msg = obj['message'] as Record<string, unknown>;
    if (typeof msg['model'] === 'string') setModel(msg['model']);
    if (typeof msg['usage'] === 'object' && msg['usage'] !== null) {
      Object.assign(accum, msg['usage']);
    }
  }
  if (
    eventType === 'message_delta' &&
    typeof obj['usage'] === 'object' &&
    obj['usage'] !== null
  ) {
    Object.assign(accum, obj['usage']);
  }
}
