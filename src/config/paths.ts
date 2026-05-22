import { dirname, isAbsolute, resolve } from 'node:path';

/**
 * Per-instance state directory. Houses cli-token, devices.json,
 * projects-state.json, and the feedback/ subdir.
 *
 * Resolution: prefer the explicit `config.configDir` field; otherwise
 * derive from the config file's own location (every per-instance state
 * file then sits next to the config that asked for it). This keeps the
 * "one config file fully describes one instance" invariant — no
 * out-of-band env vars to set.
 *
 * Multi-instance same-host deployments (prod + staging on different
 * ports) get full isolation by handing each instance its own config
 * file at a different path; the staging launch agent passes
 * `--config /path/to/staging.json` and everything else falls into place.
 */
export function resolveConfigDir(
  config: { readonly configDir?: string | undefined },
  configPath: string,
): string {
  if (config.configDir !== undefined && config.configDir.length > 0) {
    return isAbsolute(config.configDir)
      ? config.configDir
      : resolve(dirname(configPath), config.configDir);
  }
  return dirname(configPath);
}
