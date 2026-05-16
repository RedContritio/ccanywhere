import type { FastifyInstance } from 'fastify';
import type { DeviceStore} from '../../devices/store.js';
import { DeviceStoreError } from '../../devices/store.js';
import { pendingCredentials } from './auth-webauthn.js';

export interface InternalRoutesOptions {
  readonly store: DeviceStore;
}

/**
 * Routes for the local mac CLI to inspect and act on the device store.
 * Auth lives in `server/auth.ts` and gates on the cliToken bearer.
 */
export async function registerInternalRoutes(
  app: FastifyInstance,
  opts: InternalRoutesOptions,
): Promise<void> {
  app.get('/api/internal/devices', async () => ({
    devices: opts.store.listDevices(true).map((d) => ({
      id: d.id,
      label: d.label,
      createdAt: d.createdAt,
      lastUsedAt: d.lastUsedAt,
      status: d.status,
    })),
  }));

  app.delete<{ Params: { id: string } }>(
    '/api/internal/devices/:id',
    async (req, reply) => {
      const ok = opts.store.revokeDevice(req.params.id);
      if (!ok) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'device not found or already revoked' } });
        return;
      }
      await reply.code(204).send();
    },
  );

  app.get('/api/internal/pending', async () => ({
    pending: opts.store.listPendingForApproval().map((p) => ({
      pendingId: p.pendingId,
      label: p.label,
      createdAt: p.createdAt,
      remoteAddr: p.remoteAddr,
      userAgent: p.userAgent,
    })),
  }));

  app.post<{ Params: { id: string } }>(
    '/api/internal/pending/:id/approve',
    async (req, reply) => {
      const credential = pendingCredentials.get(req.params.id);
      if (!credential) {
        await reply.code(404).send({
          error: {
            code: 'not_found',
            message: 'pending pair not found, expired, or registration not completed',
          },
        });
        return;
      }
      try {
        const result = opts.store.approvePending(req.params.id, credential);
        pendingCredentials.delete(req.params.id);
        await reply.code(200).send({
          deviceId: result.device.id,
          label: result.device.label,
        });
      } catch (err) {
        if (err instanceof DeviceStoreError) {
          await reply
            .code(409)
            .send({ error: { code: 'invalid_state', message: err.message } });
          return;
        }
        throw err;
      }
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/internal/pending/:id',
    async (req, reply) => {
      const ok = opts.store.rejectPending(req.params.id);
      pendingCredentials.delete(req.params.id);
      if (!ok) {
        await reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'pending pair not found' } });
        return;
      }
      await reply.code(204).send();
    },
  );

}
