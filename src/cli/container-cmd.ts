import { resolve } from 'node:path';
import { stdout } from 'node:process';
import {
  ConfigError,
  defaultConfigPath,
  loadConfig,
} from '../config/loader.js';
import { DockerDetector } from '../container/docker-detect.js';
import { SharedContainerManager } from '../container/shared-manager.js';
import { logger } from '../log.js';

const IMAGE_NAME = 'ccanywhere/user-runtime:latest';

function loadConfigOrExit(
  configPathArg: string | undefined,
): { containerName: string; configPath: string } {
  const configPath =
    configPathArg !== undefined ? resolve(configPathArg) : defaultConfigPath();
  try {
    const config = loadConfig(configPath);
    return {
      containerName: `ccanywhere-shared-${config.port}`,
      configPath,
    };
  } catch (err) {
    if (err instanceof ConfigError) {
      logger.fatal(err.message);
      process.exit(2);
    }
    throw err;
  }
}

export async function runContainerSubcommand(
  args: string[],
  configPath: string | undefined,
): Promise<void> {
  const sub = args.shift();
  if (sub === 'ensure') return runEnsure(configPath);
  if (sub === 'stop') return runStop(configPath);
  if (sub === 'status') return runStatus(configPath);
  if (sub === 'build') {
    stdout.write(
      'use: ./scripts/build-container-image.sh (image: ' + IMAGE_NAME + ')\n',
    );
    return;
  }
  stdout.write(
    `unknown container subcommand: ${sub ?? '(missing)'}\n` +
      `available: build | ensure | stop | status\n`,
  );
  process.exit(2);
}

async function runEnsure(configPathArg: string | undefined): Promise<void> {
  const { containerName } = loadConfigOrExit(configPathArg);
  const dockerOk = (await new DockerDetector().detect()).available;
  if (!dockerOk) {
    stdout.write('docker daemon unreachable; not ensuring container\n');
    process.exit(2);
  }
  const mgr = new SharedContainerManager({
    image: IMAGE_NAME,
    name: containerName,
  });
  await mgr.ensureRunning();
  const h = await mgr.healthCheck();
  stdout.write(
    `container ${containerName}: running=${h.running} healthy=${h.healthy}\n`,
  );
}

async function runStop(configPathArg: string | undefined): Promise<void> {
  const { containerName } = loadConfigOrExit(configPathArg);
  const mgr = new SharedContainerManager({
    image: IMAGE_NAME,
    name: containerName,
  });
  await mgr.stop();
  stdout.write(`container ${containerName}: stopped\n`);
}

async function runStatus(configPathArg: string | undefined): Promise<void> {
  const { containerName } = loadConfigOrExit(configPathArg);
  const dockerStatus = await new DockerDetector().detect();
  if (!dockerStatus.available) {
    stdout.write(
      `docker: unavailable (${dockerStatus.reason ?? 'unknown'})\n` +
        `container ${containerName}: cannot inspect\n`,
    );
    return;
  }
  const mgr = new SharedContainerManager({
    image: IMAGE_NAME,
    name: containerName,
  });
  const h = await mgr.healthCheck();
  stdout.write(
    `docker: available\n` +
      `container ${containerName}: running=${h.running} healthy=${h.healthy}\n`,
  );
}
