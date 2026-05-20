import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Subprocess runner used by `docker-detect` and `shared-manager`.
 * Tests inject a mock to avoid spawning real `docker` CLI.
 *
 * Returns ExecResult regardless of exit code — caller decides whether
 * non-zero is an error (Node's execFile rejects on non-zero by default,
 * we wrap to surface exit code uniformly).
 */
export type ExecImpl = (
  cmd: string,
  args: readonly string[],
  opts?: { readonly timeoutMs?: number },
) => Promise<ExecResult>;

export const defaultExec: ExecImpl = async (cmd, args, opts) => {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, [...args], {
      timeout: opts?.timeoutMs ?? 30_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      code?: number | string;
      stdout?: string;
      stderr?: string;
    };
    return {
      exitCode: typeof e.code === 'number' ? e.code : 1,
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? (e instanceof Error ? e.message : String(e)),
    };
  }
};
