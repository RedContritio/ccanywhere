import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ProjectStore,
  ProjectStoreError,
  ensureProjectsRoot,
  isValidProjectName,
} from './store.js';

describe('isValidProjectName', () => {
  it.each([
    ['simple ASCII', 'demo', true],
    ['kebab', 'my-project', true],
    ['snake', 'my_project', true],
    ['dotted middle', 'a.b', true],
    ['Chinese', '我的项目', true],
    ['emoji', '🎮project', true],
    ['255 chars', 'x'.repeat(255), true],
    ['empty', '', false],
    ['256 chars', 'x'.repeat(256), false],
    ['dot', '.', false],
    ['dotdot', '..', false],
    ['contains slash', 'a/b', false],
    ['contains null byte', 'a\x00b', false],
    ['contains tab', 'a\tb', false],
    ['contains newline', 'a\nb', false],
  ])('%s -> %s', (_label, name, expected) => {
    expect(isValidProjectName(name)).toBe(expected);
  });
});

describe('ensureProjectsRoot', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-ensure-'));
  });

  afterEach(() => {
    try {
      chmodSync(tmpRoot, 0o755);
    } catch {
      // ignore
    }
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('creates the directory if missing', () => {
    const target = join(tmpRoot, 'nested', 'deep');
    const { writable } = ensureProjectsRoot(target);
    expect(writable).toBe(true);
  });

  it('reports writable=true for a normal dir', () => {
    expect(ensureProjectsRoot(tmpRoot).writable).toBe(true);
  });

  it('reports writable=false for a read-only dir but does not throw', () => {
    chmodSync(tmpRoot, 0o555);
    expect(ensureProjectsRoot(tmpRoot).writable).toBe(false);
  });

  it('throws when path is a file, not a directory', () => {
    const filePath = join(tmpRoot, 'notadir');
    writeFileSync(filePath, 'oops');
    expect(() => ensureProjectsRoot(filePath)).toThrow(ProjectStoreError);
    expect(() => ensureProjectsRoot(filePath)).toThrow(/not a directory/);
  });

  it('throws when path is unreadable', () => {
    const unreadable = join(tmpRoot, 'no-r');
    mkdirSync(unreadable);
    chmodSync(unreadable, 0o000);
    try {
      expect(() => ensureProjectsRoot(unreadable)).toThrow(/not readable/);
    } finally {
      chmodSync(unreadable, 0o755);
    }
  });
});

describe('ProjectStore', () => {
  let projectsRoot: string;
  let statePath: string;
  let store: ProjectStore;

  beforeEach(() => {
    projectsRoot = mkdtempSync(join(tmpdir(), 'ccanywhere-store-'));
    statePath = join(projectsRoot, '.projects-state.json');
    store = new ProjectStore({ projectsRoot, statePath });
  });

  afterEach(() => {
    rmSync(projectsRoot, { recursive: true, force: true });
  });

  it('list() returns subdirectories sorted by id', () => {
    mkdirSync(join(projectsRoot, 'beta'));
    mkdirSync(join(projectsRoot, 'alpha'));
    mkdirSync(join(projectsRoot, 'gamma'));
    const list = store.list();
    expect(list.map((p) => p.id)).toEqual(['alpha', 'beta', 'gamma']);
    expect(list[0]?.cwd).toBe(join(projectsRoot, 'alpha'));
  });

  it('list() skips dotfiles and regular files', () => {
    mkdirSync(join(projectsRoot, 'visible'));
    mkdirSync(join(projectsRoot, '.hidden-dotfile'));
    writeFileSync(join(projectsRoot, 'README.md'), 'hi');
    expect(store.list().map((p) => p.id)).toEqual(['visible']);
  });

  it('get() returns null for unknown id', () => {
    expect(store.get('ghost')).toBeNull();
  });

  it('get() returns the project for known id', () => {
    mkdirSync(join(projectsRoot, 'demo'));
    expect(store.get('demo')?.id).toBe('demo');
  });

  it('create() makes a new subdir and returns the project', () => {
    const p = store.create('fresh');
    expect(p.id).toBe('fresh');
    expect(p.cwd).toBe(join(projectsRoot, 'fresh'));
    expect(store.list().map((x) => x.id)).toContain('fresh');
  });

  it('create() rejects invalid names', () => {
    expect(() => store.create('')).toThrow(/invalid project name/);
    expect(() => store.create('..')).toThrow(/invalid project name/);
    expect(() => store.create('a/b')).toThrow(/invalid project name/);
  });

  it('create() throws when project already exists', () => {
    mkdirSync(join(projectsRoot, 'dup'));
    expect(() => store.create('dup')).toThrow(/already exists/);
  });

  it('hide() marks an existing project hidden and persists', () => {
    mkdirSync(join(projectsRoot, 'gone'));
    expect(store.hide('gone')).toBe(true);
    expect(store.list().map((p) => p.id)).not.toContain('gone');
    // Persisted to state file
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { hidden: string[] };
    expect(persisted.hidden).toEqual(['gone']);
  });

  it('hide() is idempotent and returns false on the second call', () => {
    mkdirSync(join(projectsRoot, 'twice'));
    expect(store.hide('twice')).toBe(true);
    expect(store.hide('twice')).toBe(false);
  });

  it('hide() returns false for unknown id and does not persist', () => {
    expect(store.hide('ghost')).toBe(false);
  });

  it('create() un-hides a previously hidden name when recreating', () => {
    mkdirSync(join(projectsRoot, 'rebirth'));
    store.hide('rebirth');
    rmSync(join(projectsRoot, 'rebirth'), { recursive: true, force: true });
    const p = store.create('rebirth');
    expect(p.id).toBe('rebirth');
    expect(store.list().map((x) => x.id)).toContain('rebirth');
    const persisted = JSON.parse(readFileSync(statePath, 'utf8')) as { hidden: string[] };
    expect(persisted.hidden).not.toContain('rebirth');
  });

  it('loads existing hidden state on construction', () => {
    mkdirSync(join(projectsRoot, 'pre-hidden'));
    writeFileSync(statePath, JSON.stringify({ hidden: ['pre-hidden'] }));
    const fresh = new ProjectStore({ projectsRoot, statePath });
    expect(fresh.list().map((p) => p.id)).not.toContain('pre-hidden');
  });

  it('list() returns empty when projectsRoot does not exist', () => {
    rmSync(projectsRoot, { recursive: true, force: true });
    expect(store.list()).toEqual([]);
  });
});
