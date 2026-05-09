import {
  accessSync,
  constants,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

export interface Project {
  readonly id: string;
  readonly name: string;
  readonly cwd: string;
  /** epoch-ms; the directory's filesystem mtime. */
  readonly modifiedAt: number;
}

interface ProjectsState {
  readonly hidden: ReadonlyArray<string>;
}

export interface ProjectStoreOptions {
  /** Absolute path to the directory whose direct subdirs become projects. */
  readonly projectsRoot: string;
  /** Path to the JSON file that persists the hidden-id list. */
  readonly statePath: string;
}

export class ProjectStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectStoreError';
  }
}

const FORBIDDEN_NAME_CHARS = /[\x00-\x1f/]/;

export function isValidProjectName(name: string): boolean {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > 255) return false;
  if (name === '.' || name === '..') return false;
  if (FORBIDDEN_NAME_CHARS.test(name)) return false;
  return true;
}

/**
 * Validate projectsRoot at startup. Creates the directory if missing.
 * Throws on read failure (no point continuing); returns `{ writable }` so
 * the caller can warn but keep running when create() will fail later.
 */
export function ensureProjectsRoot(projectsRoot: string): { readonly writable: boolean } {
  const path = resolve(projectsRoot);
  if (!existsSync(path)) {
    try {
      mkdirSync(path, { recursive: true });
    } catch (err) {
      throw new ProjectStoreError(
        `failed to create projectsRoot at ${path}: ${(err as Error).message}`,
      );
    }
  }
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) {
    throw new ProjectStoreError(`projectsRoot is not a directory: ${path}`);
  }
  try {
    accessSync(path, constants.R_OK);
  } catch {
    throw new ProjectStoreError(`projectsRoot is not readable: ${path}`);
  }
  let writable = true;
  try {
    accessSync(path, constants.W_OK);
  } catch {
    writable = false;
  }
  return { writable };
}

export class ProjectStore {
  private readonly hidden: Set<string>;

  constructor(private readonly opts: ProjectStoreOptions) {
    this.hidden = new Set(this.loadState().hidden);
  }

  /**
   * Re-scan projectsRoot and return visible projects. Cheap (one readdir +
   * stat per entry) so we do it on every call rather than caching — keeps
   * the user's "mkdir Projects/foo from terminal" instantly visible.
   */
  list(): Project[] {
    let entries: string[];
    try {
      entries = readdirSync(this.opts.projectsRoot);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return [];
      throw err;
    }
    const out: Project[] = [];
    for (const name of entries) {
      if (this.hidden.has(name)) continue;
      if (name.startsWith('.')) continue;
      const cwd = join(this.opts.projectsRoot, name);
      let modifiedAt: number;
      try {
        const st = statSync(cwd);
        if (!st.isDirectory()) continue;
        modifiedAt = st.mtimeMs;
      } catch {
        continue;
      }
      out.push({ id: name, name, cwd, modifiedAt });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }

  get(id: string): Project | null {
    return this.list().find((p) => p.id === id) ?? null;
  }

  create(name: string): Project {
    if (!isValidProjectName(name)) {
      throw new ProjectStoreError(`invalid project name: ${JSON.stringify(name)}`);
    }
    const cwd = join(this.opts.projectsRoot, name);
    try {
      mkdirSync(cwd, { recursive: false });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') {
        throw new ProjectStoreError(`project already exists: ${name}`);
      }
      if (code === 'EACCES') {
        throw new ProjectStoreError(
          `no write permission for projectsRoot: ${this.opts.projectsRoot}`,
        );
      }
      throw err;
    }
    if (this.hidden.delete(name)) this.persistState();
    return { id: name, name, cwd, modifiedAt: Date.now() };
  }

  /** Marks a project hidden; idempotent. Does NOT delete on disk. */
  hide(id: string): boolean {
    if (this.hidden.has(id)) return false;
    if (this.get(id) === null) return false;
    this.hidden.add(id);
    this.persistState();
    return true;
  }

  private loadState(): ProjectsState {
    try {
      const raw = readFileSync(this.opts.statePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<ProjectsState>;
      const hidden = Array.isArray(parsed.hidden)
        ? parsed.hidden.filter((s): s is string => typeof s === 'string')
        : [];
      return { hidden };
    } catch {
      return { hidden: [] };
    }
  }

  private persistState(): void {
    const state: ProjectsState = { hidden: Array.from(this.hidden) };
    writeFileSync(this.opts.statePath, JSON.stringify(state, null, 2));
  }
}
