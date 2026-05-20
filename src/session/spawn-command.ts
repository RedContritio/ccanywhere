import { buildEnv, type SpawnOptions } from './manager-types.js';

/**
 * m-user-shared-container: split `opts.runtime` into the actual spawn
 * command + args + pty env. host path is identity (legacy ptySpawn);
 * shared-container path wraps in `docker exec -it -u <user> -e ...
 * <container> <cmd> <args...>` and strips user env from the pty's own
 * environment (env is injected into container via -e flags instead).
 *
 * Pulled out of manager.ts to keep that file under the 300-line lint
 * cap; pure function, no manager state.
 */
export function buildSpawnCommand(opts: SpawnOptions): {
  command: string;
  args: readonly string[];
  ptyEnv: Record<string, string>;
} {
  if (opts.runtime === 'shared-container') {
    if (opts.container === undefined) {
      throw new Error(
        "spawn: runtime: 'shared-container' requires opts.container",
      );
    }
    const dockerArgs: string[] = [
      'exec',
      '-it',
      '-u',
      opts.container.unixUser,
    ];
    if (opts.container.workingDir !== undefined) {
      dockerArgs.push('-w', opts.container.workingDir);
    }
    if (opts.env !== undefined) {
      for (const [k, v] of Object.entries(opts.env)) {
        dockerArgs.push('-e', `${k}=${v}`);
      }
    }
    dockerArgs.push(opts.container.name, opts.command, ...opts.args);
    // Container path's pty env stays parent-only (HOME/PATH) — user
    // env goes through -e args so docker CLI itself doesn't see it.
    return {
      command: 'docker',
      args: dockerArgs,
      ptyEnv: buildEnv(undefined),
    };
  }
  // Default 'host' (or undefined): legacy direct spawn.
  return {
    command: opts.command,
    args: opts.args,
    ptyEnv: buildEnv(opts.env),
  };
}
