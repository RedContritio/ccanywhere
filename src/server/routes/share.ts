import { readFileSync } from 'node:fs';

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import type { Config } from '../../config/schema.js';
import { logger } from '../../log.js';
import type { ProjectStore } from '../../projects/store.js';
import type { SessionManager } from '../../session/manager.js';
import { generateShareCode, isValidShareCode } from '../../share/code.js';
import { renderShareHtml } from '../../share/render.js';
import type { ShareRecord, ShareStore } from '../../share/store.js';
import { ccJsonlPathOf } from '../../quota/path.js';

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Cap user-supplied TTL to ~10 years; an explicit `null` body field
// means "never expire" and bypasses the cap.
const MAX_TTL_MS = 10 * 365 * 24 * 60 * 60 * 1000;

const CreateBodySchema = z.object({
  sessionId: z.string().min(1),
  // ttlMs: number = explicit ttl; null = never expire; absent = config
  // fallback (`shareTtlMs` or DEFAULT_TTL_MS).
  ttlMs: z.union([z.number().int().positive(), z.null()]).optional(),
});

function shareUrl(webOrigin: string, code: string): string {
  return `${webOrigin.replace(/\/$/, '')}/share/${code}`;
}

function jsonlPathForSession(
  cwd: string,
  webId: string,
  resumeSessionId: string | null | undefined,
): string {
  // cc jsonl filename = the id passed to `--session-id` (create-mode)
  // or the id passed to `--resume` (resume-mode → original conv id).
  return ccJsonlPathOf(cwd, resumeSessionId ?? webId);
}

export async function registerShareRoutes(
  app: FastifyInstance,
  config: Config,
  shareStore: ShareStore,
  manager: SessionManager,
  projectStore: ProjectStore,
): Promise<void> {
  const fallbackTtlMs = config.shareTtlMs ?? DEFAULT_TTL_MS;

  // POST /api/share — owner / limited create a share for their own
  // session. Renders the HTML once + persists; returns the public URL.
  app.post('/api/share', async (req, reply) => {
    if (req.user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'login required' } });
      return;
    }
    const parsed = CreateBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      await reply
        .code(400)
        .send({ error: { code: 'invalid_request', message: 'body validation failed' } });
      return;
    }
    const { sessionId, ttlMs } = parsed.data;

    // Find session in either alive or dead set + cross-user 404.
    const row = manager.findRow(sessionId);
    if (row === undefined || row.info.userId !== req.user.id) {
      await reply
        .code(404)
        .send({ error: { code: 'not_found', message: 'session not found' } });
      return;
    }

    const project = projectStore.get(row.info.projectId);
    if (!project) {
      await reply
        .code(404)
        .send({ error: { code: 'project_gone', message: 'owning project was removed' } });
      return;
    }

    // Load cc jsonl content. ENOENT → 404 (the conversation might be
    // mid-init with no jsonl yet, or cc cleared the file).
    let jsonl: string;
    try {
      jsonl = readFileSync(
        jsonlPathForSession(row.info.cwd, row.info.id, row.info.resumeSessionId),
        'utf8',
      );
    } catch (err) {
      logger.warn({ err, sessionId }, 'share: jsonl missing or unreadable');
      await reply
        .code(404)
        .send({ error: { code: 'jsonl_missing', message: 'session log unavailable' } });
      return;
    }

    let cappedTtl: number | null;
    if (ttlMs === null) {
      cappedTtl = null;
    } else if (ttlMs === undefined) {
      cappedTtl = fallbackTtlMs;
    } else {
      cappedTtl = Math.min(ttlMs, MAX_TTL_MS);
    }

    const now = Date.now();
    const code = generateShareCode();
    const record: ShareRecord = {
      code,
      sessionId: row.info.id,
      createdBy: req.user.id,
      createdAt: now,
      expiresAt: cappedTtl === null ? null : now + cappedTtl,
      projectName: project.name,
    };

    const html = renderShareHtml({
      jsonl,
      projectName: project.name,
      createdBy: req.user.username,
      createdAt: now,
      shareCode: code,
    });

    try {
      await shareStore.save(record, html);
    } catch (err) {
      logger.error({ err, code }, 'share save failed');
      await reply
        .code(500)
        .send({ error: { code: 'save_failed', message: 'failed to persist share' } });
      return;
    }

    await reply.code(201).send({
      code,
      url: shareUrl(config.webOrigin, code),
      expiresAt: record.expiresAt,
      createdAt: record.createdAt,
    });
  });

  // GET /api/share/list — the caller's own shares (paginated would be
  // future; user counts are small in v1).
  app.get('/api/share/list', async (req, reply) => {
    if (req.user === undefined) {
      await reply
        .code(401)
        .send({ error: { code: 'unauthorized', message: 'login required' } });
      return;
    }
    const mine = shareStore.listByUserSync(req.user.id);
    return {
      shares: mine
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((r) => ({
          code: r.code,
          url: shareUrl(config.webOrigin, r.code),
          sessionId: r.sessionId,
          projectName: r.projectName,
          createdAt: r.createdAt,
          expiresAt: r.expiresAt,
        })),
    };
  });

  // DELETE /api/share/:code — owner-of-record delete. Other users get
  // 404 (no existence leak).
  app.delete<{ Params: { code: string } }>(
    '/api/share/:code',
    async (req, reply) => {
      if (req.user === undefined) {
        await reply
          .code(401)
          .send({ error: { code: 'unauthorized', message: 'login required' } });
        return;
      }
      const code = req.params.code;
      if (!isValidShareCode(code)) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'share not found' } });
        return;
      }
      const record = shareStore.load(code);
      if (record === undefined || record.createdBy !== req.user.id) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'share not found' } });
        return;
      }
      await shareStore.delete(code);
      await reply.code(204).send();
    },
  );

  // GET /share/:code — public view, no auth. Long-cache immutable HTML.
  app.get<{ Params: { code: string } }>(
    '/share/:code',
    async (req, reply) => {
      const code = req.params.code;
      if (!isValidShareCode(code)) {
        await reply.code(404).type('text/plain').send('share not found');
        return;
      }
      const record = shareStore.load(code);
      if (record === undefined) {
        await reply.code(404).type('text/plain').send('share not found');
        return;
      }
      const html = shareStore.loadHtml(code);
      if (html === undefined) {
        // Metadata says it exists but the html companion is gone — treat
        // as 404 so the user can't see an orphan snapshot.
        await reply.code(404).type('text/plain').send('share not found');
        return;
      }
      await reply
        .code(200)
        .header('content-type', 'text/html; charset=utf-8')
        .header('cache-control', 'public, max-age=31536000, immutable')
        .send(html);
    },
  );
}
