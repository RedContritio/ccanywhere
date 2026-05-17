import { join } from 'node:path';
import type { Config } from '../config/schema.js';
import { DockerDetector } from '../container/docker-detect.js';
import { SharedContainerManager } from '../container/shared-manager.js';
import { ContainerUserSync } from '../container/user-sync.js';
import { logger } from '../log.js';
import type { SessionContainerDeps } from '../server/server.js';
import { TokenIssuer } from '../proxy/tokens.js';
import { ensureProxyTokenSecret } from './proxy-serve.js';

const IMAGE_NAME = 'ccanywhere/user-runtime:latest';

export interface ContainerInitResult {
  readonly sharedContainerReady: boolean;
  readonly containerDeps?: SessionContainerDeps;
  /** Graceful shutdown — caller wires into serve.ts SIGTERM handler. */
  readonly shutdown: () => Promise<void>;
}

/**
 * m-user-shared-container C6: detect docker, ensure shared container
 * running, build SessionContainerDeps. Returns a result the caller
 * (serve.ts) forwards into resolveIsolation (sharedContainerReady) and
 * buildServer (containerDeps).
 *
 * Behavior:
 * - `isolationPolicy: 'host-only'` → skip docker init entirely
 * - docker unavailable → don't init; sharedContainerReady=false (D5
 *   resolveIsolation will fatal if any user configured shared-container)
 * - docker available → ensureRunning shared container + build deps
 *
 * Container name is per-instance via `<image>-<port>` to avoid collision
 * with multi-instance same-host deployments.
 */
export async function initContainerStack(
  config: Config,
  configDir: string,
): Promise<ContainerInitResult> {
  const noop = async (): Promise<void> => {};

  if (config.isolationPolicy === 'host-only') {
    logger.info('isolationPolicy: host-only → skipping container init');
    return { sharedContainerReady: false, shutdown: noop };
  }

  const detector = new DockerDetector();
  const status = await detector.detect();
  if (!status.available) {
    logger.warn(
      { reason: status.reason },
      'docker unavailable; container deps not initialized — ' +
        'resolveIsolation D5 will fatal if any user configured shared-container',
    );
    return { sharedContainerReady: false, shutdown: noop };
  }

  const containerName = `ccanywhere-shared-${config.port}`;
  const sharedManager = new SharedContainerManager({
    image: IMAGE_NAME,
    name: containerName,
  });
  try {
    await sharedManager.ensureRunning();
  } catch (err) {
    logger.fatal(
      { err: (err as Error).message, image: IMAGE_NAME, containerName },
      'shared container ensureRunning failed; build image first via ' +
        '`./scripts/build-container-image.sh`',
    );
    process.exit(2);
  }
  logger.info({ containerName, image: IMAGE_NAME }, 'shared container running');

  const tokenSecret = ensureProxyTokenSecret(
    join(configDir, 'proxy-token-secret'),
  );
  const tokenIssuer = new TokenIssuer({ secret: tokenSecret });
  const userSync = new ContainerUserSync({ containerName });

  const containerDeps: SessionContainerDeps = {
    containerName,
    userSync,
    tokenIssuer,
    proxyBaseUrl: `http://host.docker.internal:${config.proxy.port}`,
  };

  return {
    sharedContainerReady: true,
    containerDeps,
    shutdown: async () => {
      logger.info({ containerName }, 'stopping shared container');
      try {
        await sharedManager.stop();
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'shared stop failed');
      }
    },
  };
}
