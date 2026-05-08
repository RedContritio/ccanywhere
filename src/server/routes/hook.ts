import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../session/manager.js';

const KNOWN_EVENTS = new Set([
  'Stop',
  'SubagentStop',
  'Notification',
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'SessionStart',
]);

export async function registerHookRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): Promise<void> {
  app.post<{ Params: { sessionId: string; event: string } }>(
    '/api/hook/:sessionId/:event',
    async (req, reply) => {
      const { sessionId, event } = req.params;
      if (!KNOWN_EVENTS.has(event)) {
        await reply
          .code(400)
          .send({ error: { code: 'invalid_event', message: `unknown hook event: ${event}` } });
        return;
      }
      const session = manager.get(sessionId);
      if (!session) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'session not found' } });
        return;
      }
      // Full state-machine wiring lands in M5; M3 only acknowledges receipt.
      app.log.info({ sessionId, event }, 'hook received');
      await reply.code(204).send();
    },
  );
}
