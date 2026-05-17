import { pino } from 'pino';
import { PassThrough } from 'node:stream';

export class RedactSelfTestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RedactSelfTestError';
  }
}

/**
 * Paths pino must redact in any log record the proxy emits. Anything
 * carrying owner credentials, user bearer tokens, or upstream API keys
 * MUST be listed here. Adding a new code path that logs secrets without
 * updating this list is a bug — the self-test (runRedactSelfTest) is
 * the safety net that fail-fasts boot if a known secret leaks.
 */
export const REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers["x-api-key"]',
  'res.headers.authorization',
  'reqBody.api_key',
  'reqBody.auth_token',
  'credentials.apiKey',
  'apiKey',
  'bearer',
];

export function buildRedactOptions(): {
  paths: string[];
  censor: string;
  remove: false;
} {
  return {
    paths: [...REDACT_PATHS],
    censor: '[REDACTED]',
    remove: false,
  };
}

const SELF_TEST_TOKEN = 'fake-self-test-token-deadbeef-1234567890';

/**
 * Spawn a throwaway pino instance with the production redact rules,
 * log a record that contains SELF_TEST_TOKEN in every redacted path,
 * grep the captured output. Any unredacted occurrence → throw.
 *
 * Caller (proxy-serve.ts) MUST treat failure as fatal — refuse to bind
 * any listener if self-test fails.
 */
export async function runRedactSelfTest(): Promise<void> {
  const captured: string[] = [];
  const stream = new PassThrough();
  stream.on('data', (chunk: Buffer) => captured.push(chunk.toString('utf8')));

  const testLogger = pino(
    {
      level: 'info',
      redact: buildRedactOptions(),
    },
    stream,
  );

  testLogger.info(
    {
      req: {
        headers: {
          authorization: `Bearer ${SELF_TEST_TOKEN}`,
          'x-api-key': SELF_TEST_TOKEN,
        },
      },
      res: { headers: { authorization: SELF_TEST_TOKEN } },
      reqBody: { api_key: SELF_TEST_TOKEN, auth_token: SELF_TEST_TOKEN },
      credentials: { apiKey: SELF_TEST_TOKEN },
      apiKey: SELF_TEST_TOKEN,
      bearer: SELF_TEST_TOKEN,
    },
    'redact self-test',
  );

  // Pino is sync-by-default to its destination stream, but the
  // PassThrough emits 'data' on next microtask. Drain once.
  await new Promise<void>((r) => setImmediate(r));

  const output = captured.join('');
  if (output.includes(SELF_TEST_TOKEN)) {
    throw new RedactSelfTestError(
      `redact self-test FAILED: token leaked in log output. ` +
        `Update REDACT_PATHS in src/proxy/log-redact.ts before starting.\n` +
        `Captured output:\n${output}`,
    );
  }
}
