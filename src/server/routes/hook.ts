import type { FastifyInstance } from 'fastify';
import type { SessionManager } from '../../session/manager.js';
import type { SessionState } from '../../session/types.js';

const STATE_TRANSITIONS: Readonly<Record<string, SessionState | null>> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: null,
  Notification: null,
  Stop: 'idle',
  SubagentStop: 'idle',
};

export async function registerHookRoutes(
  app: FastifyInstance,
  manager: SessionManager,
): Promise<void> {
  app.post<{ Params: { sessionId: string; event: string } }>(
    '/api/hook/:sessionId/:event',
    async (req, reply) => {
      const { sessionId, event } = req.params;
      if (!Object.hasOwn(STATE_TRANSITIONS, event)) {
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
      const next = STATE_TRANSITIONS[event];
      if (next !== null && next !== undefined) {
        session.setState(next);
      }
      app.log.info({ sessionId, event, state: session.state }, 'hook applied');
      await reply.code(204).send();
    },
  );
}
