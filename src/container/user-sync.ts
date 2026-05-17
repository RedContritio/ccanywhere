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
}

/**
 * Lazy useradd for per-user unix accounts inside the shared container.
 *
 * Strategy (D4): no eager sync between ccanywhere UserStore and container
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
  private readonly cache = new Set<string>();

  constructor(opts: ContainerUserSyncOpts) {
    this.containerName = opts.containerName;
    this.exec = opts.execImpl ?? defaultExec;
  }

  async ensureUser(username: string): Promise<{ uid: number }> {
    const uid = ContainerUserSync.uidOf(username);
    if (this.cache.has(username)) return { uid };

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

    // Tighten /home/<user> perms to 0700 (fs isolation, m-user-runtime-
    // schema D1 best-effort).
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
