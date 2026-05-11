import { existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ccusageCalc } from '../../quota/ccusage.js';
import { ccJsonlPathOf } from '../../quota/path.js';
import type { Session, SessionManager } from '../../session/manager.js';
import type { SessionState } from '../../session/types.js';
import type { UserStore } from '../../users/store.js';
import type { User } from '../../users/types.js';

const STATE_TRANSITIONS: Readonly<Record<string, SessionState | null>> = {
  SessionStart: 'idle',
  UserPromptSubmit: 'busy',
  PreToolUse: 'busy',
  PostToolUse: null,
  Notification: null,
  Stop: 'idle',
  SubagentStop: 'idle',
};

export interface HookRoutesOptions {
  /**
   * #46 quota: when set, UserPromptSubmit fires quota check against
   * `user.quota` and emits cc's block-JSON when the limited user is over.
   * Without userStore the handler runs in pure state-machine mode (legacy
   * / pre-multi-user behavior).
   */
  readonly userStore?: UserStore;
}

interface QuotaBlockDecision {
  readonly decision: 'block';
  /** Shown to the user by cc; both cc 2.x field names are populated for
   * forward compatibility. */
  readonly reason: string;
  readonly continue: false;
  readonly stopReason: string;
}

/**
 * cc-internal session id for jsonl path derivation. Create mode forces
 * `--session-id <ccanywhere-id>` (routes/sessions.ts), so info.id == cc id.
 * Resume mode reuses the cc id of the resumed session.
 */
function ccSessionIdOf(session: Session): string {
  return session.info.resumeSessionId ?? session.info.id;
}

function decide(
  user: User,
  costUsd: number,
  totalTokens: number,
): QuotaBlockDecision | null {
  // Double-limit "first to trip" semantics per v12.1 proposal. cost first
  // then tokens; either match returns immediately.
  if (user.quota.cost.limitUsd !== null && costUsd >= user.quota.cost.limitUsd) {
    const reason = `cost quota exhausted: $${costUsd.toFixed(2)} / $${user.quota.cost.limitUsd.toFixed(2)}`;
    return { decision: 'block', reason, continue: false, stopReason: reason };
  }
  if (user.quota.tokens.limit !== null && totalTokens >= user.quota.tokens.limit) {
    const reason = `tokens quota exhausted: ${totalTokens} / ${user.quota.tokens.limit}`;
    return { decision: 'block', reason, continue: false, stopReason: reason };
  }
  return null;
}

interface QuotaCheckOutcome {
  readonly block: QuotaBlockDecision | null;
}

async function checkQuota(
  userStore: UserStore,
  session: Session,
): Promise<QuotaCheckOutcome> {
  const user = userStore.findById(session.info.userId);
  if (user === null) return { block: null }; // legacy / no-user session
  if (user.kind === 'owner') return { block: null };

  const jsonlPath = ccJsonlPathOf(session.info.cwd, ccSessionIdOf(session));
  if (!existsSync(jsonlPath)) {
    // First-prompt edge: cc hasn't flushed jsonl yet. Treat as zero usage,
    // don't persist (preserve any prior used value carried across sessions).
    return { block: null };
  }
  const usage = await ccusageCalc(jsonlPath, user.createdAt);
  userStore.setQuotaUsage(user.id, usage.costUsd, usage.totalTokens);
  return { block: decide(user, usage.costUsd, usage.totalTokens) };
}

export async function registerHookRoutes(
  app: FastifyInstance,
  manager: SessionManager,
  options: HookRoutesOptions = {},
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

      // #46 quota: UserPromptSubmit is the single enforcement point. Run
      // BEFORE the state transition so a blocked prompt also keeps the
      // session out of 'busy' (cc won't actually run the turn).
      if (event === 'UserPromptSubmit' && options.userStore !== undefined) {
        const { block } = await checkQuota(options.userStore, session);
        if (block !== null) {
          app.log.warn(
            { sessionId, userId: session.info.userId, reason: block.reason },
            'hook quota block',
          );
          // cc protocol: status 200 + JSON body. A 4xx would make curl exit
          // nonzero, which cc treats as hook failure rather than block.
          await reply.code(200).send(block);
          return;
        }
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
