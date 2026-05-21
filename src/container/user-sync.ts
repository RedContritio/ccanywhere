import { createHash } from 'node:crypto';
import { defaultExec, type ExecImpl } from './exec.js';

export class ContainerUserSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContainerUserSyncError';
  }
}

export interface ContainerUserSyncOpts {
  readonly containerName: string;
  /** Inject for tests; default real docker CLI. */
  readonly execImpl?: ExecImpl;
  /**
   * container-side path that the host
   * `userClaudeRoot` is mounted at (`-v <userClaudeRoot>:<root>:rw`,
   * wired in container-init.ts). ensureUser mkdirs `<root>/<username>`
   * + chowns to the user's uid + chmods 0700 so cc finds its jsonl
   * history + settings.json + CLAUDE.md under
   * `CLAUDE_CONFIG_DIR=<root>/<username>` (set per-spawn by
   * session-runtime). When omitted, ensureUser only does useradd +
   * chmod /home (legacy behavior).
   */
  readonly userClaudeContainerRoot?: string;
}

/**
 * Lazy useradd for per-user unix accounts inside the shared container.
 *
 * Strategy: no eager sync between ccanywhere UserStore and container
 * /etc/passwd. Each session spawn calls `ensureUser(username)` before
 * `docker exec -u <username>` — idempotent useradd creates the account
 * on first need, noop on subsequent calls. Removed ccanywhere users
 * leave dormant container accounts until container restart (acceptable
 * cost vs eager userdel complexity).
 *
 * UID assignment is deterministic from username (sha256 truncated to
 * [1000, 65000) avoiding system UIDs): same username → same UID across
 * container rebuilds, so /home/<user> fs perms remain consistent.
 */
export class ContainerUserSync {
  private readonly containerName: string;
  private readonly exec: ExecImpl;
  private readonly userClaudeContainerRoot: string | undefined;
  private readonly cache = new Set<string>();

  constructor(opts: ContainerUserSyncOpts) {
    this.containerName = opts.containerName;
    this.exec = opts.execImpl ?? defaultExec;
    this.userClaudeContainerRoot = opts.userClaudeContainerRoot;
  }

  async ensureUser(username: string): Promise<{ uid: number }> {
    const uid = ContainerUserSync.uidOf(username);
    // cc Managed scope
    // (/etc/claude-code/managed-settings.json) contains both deny rules
    // AND CLAUDE.md soft-norm text via `claudeMd` field. cc binary
    // reads /etc/claude-code/ directly — no per-user cp needed. cache
    // hit just returns; no per-user baked-file refresh.
    if (this.cache.has(username)) {
      return { uid };
    }

    // Check if user exists in container (id -u <user>)
    const check = await this.exec('docker', [
      'exec',
      this.containerName,
      'id',
      '-u',
      username,
    ]);
    if (check.exitCode === 0) {
      this.cache.add(username);
      return { uid };
    }

    // Not present — useradd. -M (no home creation? — we DO want home for
    // CLAUDE_CONFIG_DIR), so use default (creates home). -u <uid> -m.
    // Shell defaults to /bin/sh (alpine).
    const add = await this.exec('docker', [
      'exec',
      this.containerName,
      'useradd',
      '-u',
      String(uid),
      '-m',
      '-s',
      '/bin/sh',
      username,
    ]);
    if (add.exitCode !== 0) {
      throw new ContainerUserSyncError(
        `useradd ${username} (uid ${uid}) failed: ${add.stderr}`,
      );
    }

    // Tighten /home/<user> perms to 0700 (fs isolation; best-effort).
    const chmod = await this.exec('docker', [
      'exec',
      this.containerName,
      'chmod',
      '0700',
      `/home/${username}`,
    ]);
    if (chmod.exitCode !== 0) {
      throw new ContainerUserSyncError(
        `chmod /home/${username} failed: ${chmod.stderr}`,
      );
    }

    // Per-user `~/.claude` state dir under the mounted userClaudeRoot.
    // mkdir + chown + chmod 0700. macOS docker desktop bind mount doesn't
    // enforce inode perms, so chmod is best-effort / cosmetic on macOS;
    // linux deployments truly enforce.
    if (this.userClaudeContainerRoot !== undefined) {
      const claudeDir = `${this.userClaudeContainerRoot}/${username}`;
      const mkdir = await this.exec('docker', [
        'exec',
        this.containerName,
        'mkdir',
        '-p',
        claudeDir,
      ]);
      if (mkdir.exitCode !== 0) {
        throw new ContainerUserSyncError(
          `mkdir ${claudeDir} failed: ${mkdir.stderr}`,
        );
      }
      const chown = await this.exec('docker', [
        'exec',
        this.containerName,
        'chown',
        `${uid}:${uid}`,
        claudeDir,
      ]);
      if (chown.exitCode !== 0) {
        throw new ContainerUserSyncError(
          `chown ${claudeDir} failed: ${chown.stderr}`,
        );
      }
      const chmodClaude = await this.exec('docker', [
        'exec',
        this.containerName,
        'chmod',
        '0700',
        claudeDir,
      ]);
      if (chmodClaude.exitCode !== 0) {
        throw new ContainerUserSyncError(
          `chmod ${claudeDir} failed: ${chmodClaude.stderr}`,
        );
      }
      // All policy (deny rules + LLM soft-norm CLAUDE.md text) ships in cc
      // Managed scope `/etc/claude-code/managed-settings.json`. cc binary
      // reads it directly — no per-user cp needed. Per-user `.claude` dir
      // remains for cc's own state (jsonl history, .claude.json, etc).
      //
      // Ensure user-scope settings.json exists (empty `{}`) so cc /theme
      // and per-user preferences persist across spawns. cc auto-creates
      // this file on first write, but seeding it explicitly keeps the
      // ownership chain consistent (chown user before cc binary touches
      // it) and avoids races where cc tries to chmod a missing file.
      const userSettingsFile = `${claudeDir}/settings.json`;
      const seedSettings = await this.exec('docker', [
        'exec',
        this.containerName,
        'sh',
        '-c',
        `[ -f ${userSettingsFile} ] || (echo '{}' > ${userSettingsFile} && chown ${uid}:${uid} ${userSettingsFile} && chmod 0644 ${userSettingsFile})`,
      ]);
      if (seedSettings.exitCode !== 0) {
        throw new ContainerUserSyncError(
          `seed ${userSettingsFile} failed: ${seedSettings.stderr}`,
        );
      }
    }

    this.cache.add(username);
    return { uid };
  }

  /**
   * Deterministic UID in [1000, 65000) from username. sha256 truncated
   * lets ensureUser be idempotent across container rebuilds — same
   * username always lands at same UID, so /home/<user> mount UID
   * permissions stay valid.
   */
  static uidOf(username: string): number {
    const h = createHash('sha256').update(username).digest();
    const n = h.readUInt32BE(0);
    return 1000 + (n % 64_000);
  }
}
