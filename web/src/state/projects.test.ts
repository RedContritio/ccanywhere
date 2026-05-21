import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetProjectsStoreForTest, useProjectsStore } from './projects.js';

function mockJsonResponse(body: object, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('useProjectsStore', () => {
  beforeEach(() => {
    resetProjectsStoreForTest();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('initial state: empty projects, not loading, no error', () => {
    const s = useProjectsStore.getState();
    expect(s.projects).toEqual([]);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('fetchProjects populates the list and clears loading', async () => {
    const projects = [
      { id: 'p1', name: 'one', cwd: '/x/one', modifiedAt: 1 },
      { id: 'p2', name: 'two', cwd: '/x/two', modifiedAt: 2 },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ projects }));
    await useProjectsStore.getState().fetchProjects();
    const s = useProjectsStore.getState();
    expect(s.projects).toEqual(projects);
    expect(s.loading).toBe(false);
    expect(s.error).toBeNull();
  });

  it('fetchProjects records error on network failure', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('boom'));
    await useProjectsStore.getState().fetchProjects();
    const s = useProjectsStore.getState();
    expect(s.error).toMatch(/boom/);
    expect(s.loading).toBe(false);
  });

  it('createProject appends to projects (sorted by id)', async () => {
    const created = { id: 'p3', name: 'three', cwd: '/x/three', modifiedAt: 3 };
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse(created));
    useProjectsStore.setState({
      projects: [{ id: 'p1', name: 'one', cwd: '/x/one', modifiedAt: 1 }],
      loading: false,
      error: null,
    });
    const ret = await useProjectsStore.getState().createProject('three');
    expect(ret).toEqual(created);
    const ids = useProjectsStore.getState().projects.map((p) => p.id);
    expect(ids).toEqual(['p1', 'p3']);
  });

  it('createProject dedups by id (idempotent on replay)', async () => {
    const existing = { id: 'p1', name: 'one', cwd: '/x/one', modifiedAt: 1 };
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse(existing));
    useProjectsStore.setState({
      projects: [existing],
      loading: false,
      error: null,
    });
    await useProjectsStore.getState().createProject('one');
    expect(useProjectsStore.getState().projects).toHaveLength(1);
  });

  it('hideProject removes from projects list', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 204 }));
    useProjectsStore.setState({
      projects: [
        { id: 'p1', name: 'one', cwd: '/x/one', modifiedAt: 1 },
        { id: 'p2', name: 'two', cwd: '/x/two', modifiedAt: 2 },
      ],
      loading: false,
      error: null,
    });
    await useProjectsStore.getState().hideProject('p1');
    const ids = useProjectsStore.getState().projects.map((p) => p.id);
    expect(ids).toEqual(['p2']);
  });

  it('fetchHistory returns history without mutating store', async () => {
    const history = [
      { sessionId: 's1', modifiedAt: 100, preview: 'hello' },
      { sessionId: 's2', modifiedAt: 200, preview: 'world' },
    ];
    globalThis.fetch = vi.fn().mockResolvedValue(mockJsonResponse({ history }));
    const ret = await useProjectsStore.getState().fetchHistory('p1');
    expect(ret).toEqual(history);
    expect(useProjectsStore.getState().projects).toEqual([]);
  });
});
