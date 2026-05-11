import { expect, test } from '@playwright/test';

/**
 * API-level smoke against prod (https://cc.recoco.xyz). globalSetup planted
 * a token cookie for the e2e limited user; `request` inherits storageState
 * so cookie auth works on the HTTP boundary.
 *
 * UI-level smoke is intentionally NOT here yet. The web /login page only
 * surfaces WebAuthn login at the moment (gap from m-multi-user); a token
 * cookie authenticates the HTTP/WS layer but RequireAuth in the React app
 * doesn't recognise a limited-user session and bounces to /login. Fixing
 * that gap is a separate follow-up (frontend needs to fetch /api/me/quota
 * on mount and accept "kind ∈ {owner, limited}" as logged-in). Once that
 * lands, restore the workspace/dialog smoke.
 */

test.describe('ccanywhere smoke (prod URL, API surface)', () => {
  test('healthz is public and returns ok:true', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('GET /api/me/quota returns the limited e2e user quota', async ({ request }) => {
    const res = await request.get('/api/me/quota');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      kind: 'owner' | 'limited';
      cost: { limitUsd: number | null; usedUsd: number };
    };
    expect(body.kind).toBe('limited');
    expect(body.cost.limitUsd).toBe(100); // globalSetup planted quota
  });

  test('GET /api/projects returns the limited user projects view', async ({ request }) => {
    const res = await request.get('/api/projects');
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { projects: Array<{ id: string }> };
    expect(Array.isArray(body.projects)).toBe(true);
  });

  test('POST /api/sessions with owner-projectsRoot project → 403 (cwd guard)', async ({
    request,
  }) => {
    // Pick any project — limited user is sandboxed to guestProjectsRoot
    // so server should refuse on cwd subtree mismatch. If projects list
    // is empty (fresh install) skip.
    const list = await request.get('/api/projects');
    const projects = ((await list.json()) as { projects: Array<{ id: string }> }).projects;
    if (projects.length === 0) {
      test.skip();
      return;
    }
    const first = projects[0];
    if (first === undefined) {
      test.skip();
      return;
    }
    const res = await request.post('/api/sessions', {
      data: { projectId: first.id, mode: 'create' },
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('forbidden');
  });

  test('cookieless request → 401', async ({ playwright }) => {
    // Fresh request context, explicitly empty storageState so cookies
    // don't leak from the project-wide auth file.
    const ctx = await playwright.request.newContext({
      baseURL: process.env['CCANYWHERE_TEST_URL'] ?? 'https://cc.recoco.xyz',
      storageState: { cookies: [], origins: [] },
    });
    try {
      const res = await ctx.get('/api/projects');
      expect(res.status()).toBe(401);
    } finally {
      await ctx.dispose();
    }
  });
});
