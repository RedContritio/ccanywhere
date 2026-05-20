import { devices, expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Visual screenshots. Each test snaps a
 * meaningful UI state to `test-results/visual-*.png`. Author Read()s the
 * PNGs and does visual inspection — replaces the legacy "user opens
 * browser and checks visually" loop (see feedback_e2e_visual_verify.md).
 *
 * Out of scope: dialogs that require an active cc session (quota,
 * toolbar-edit unfortunately also reaches a `currentSession`-gated
 * trigger in mobile-toolbar). Those are left for the user's first
 * post-deploy peek.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-results');

test.describe('design-system visual', () => {
  // Force themeMode=dark so screenshots are deterministic regardless of
  // the clock — without this the `auto` mode flips to light at 07:00
  // local time and screenshot names disagree with what's painted.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem(
        'ccanywhere.ui',
        JSON.stringify({
          state: { themeMode: 'dark', currentSessionId: null },
          version: 0,
        }),
      );
    });
  });

  test('workspace home (no session) dark mode', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-workspace-home-dark.png'),
      fullPage: true,
    });
  });

  test('new-session dialog dark mode', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');
    await page.getByText('+ 新建').first().click();
    // DialogBase content slot
    await page.waitForSelector('[data-slot="dialog-content"]');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-new-session-dialog-dark.png'),
      fullPage: true,
    });
    // Sanity: title text is rendered
    await expect(page.getByText('新建会话').first()).toBeVisible();
  });

  test('feedback dialog dark mode', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');
    // Feedback button sits in the sidebar drawer. On desktop the drawer
    // might be auto-collapsed — open it first if so.
    const feedbackBtn = page.getByText('反馈').first();
    if (!(await feedbackBtn.isVisible().catch(() => false))) {
      await page.getByLabel('打开侧边栏').click().catch(() => {
        /* drawer might already be open */
      });
    }
    await page.getByText('反馈').first().click();
    await page.waitForSelector('[data-slot="dialog-content"]');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-feedback-dialog-dark.png'),
      fullPage: true,
    });
    await expect(page.getByText('反馈').first()).toBeVisible();
  });

  test('login page idle (unpaired) dark mode', async ({ page, context }) => {
    // Clear the planted session cookie so probeSession() returns null and
    // LoginPage settles in `idle / suggestLogin: false` mode (no
    // localStorage deviceId in a fresh BrowserContext).
    await context.clearCookies();
    await page.goto('/login');
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-login-idle-dark.png'),
      fullPage: true,
    });
    await expect(page.getByRole('heading', { name: 'CC anywhere' })).toBeVisible();
  });

  test('/settings page with toolbar config dark mode', async ({ page }) => {
    // RequireAuth gates /settings on auth state held in zustand-persist
    // localStorage, not the cookie. A fresh BrowserContext has no
    // localStorage, so a direct `goto('/settings')` bounces to /login. Hit
    // /workspace first so probeSession() populates the limited-user state,
    // then navigate to /settings.
    await page.goto('/workspace');
    await page.waitForURL(/\/workspace/);
    await page.waitForLoadState('networkidle');
    await page.goto('/settings');
    await page.waitForLoadState('networkidle');
    // Wait for toolbar editor cells to render before snapping.
    await page.waitForSelector('[data-slot="toolbar-cell"]');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-settings-toolbar-dark.png'),
      fullPage: true,
    });
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '快捷栏布局' })).toBeVisible();
    await expect(page.getByRole('button', { name: '保存' })).toBeVisible();
    await expect(page.getByRole('button', { name: '重置默认' })).toBeVisible();
  });

  test('stale session id shows friendly recovery pane', async ({ page }) => {
    // Hit /workspace first so probeSession() hydrates the limited-user
    // state into zustand-persist (RequireAuth would otherwise bounce a
    // direct goto to /login since fresh BrowserContext has empty
    // localStorage). See the /settings test above for the same pattern.
    await page.goto('/workspace');
    await page.waitForURL(/\/workspace/);
    await page.waitForLoadState('networkidle');
    // Mock sessions to an empty list so fetchSessions resolves instantly
    // and the stale UI lands well before the 5s auto-redirect timer.
    // Without this the test's actionTimeout (also 5s) races the redirect.
    await page.route('**/api/sessions', (route) => {
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sessions: [] }),
      });
    });
    const FAKE_ID = '00000000-0000-0000-0000-000000000000';
    await page.goto(`/workspace/${FAKE_ID}`);
    await page.waitForLoadState('networkidle');
    // Wait until fetchSessions resolves and the stale state lands —
    // until then a "加载中…" spinner may render instead.
    await page.getByRole('heading', { name: '会话不存在'}).waitFor();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-stale-session-dark.png'),
      fullPage: true,
    });
    await expect(
      page.getByRole('heading', { name: '会话不存在'}),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '回到首页' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '新建会话' }),
    ).toBeVisible();
    // Copy must not leak dev jargon picked up from the old wording.
    // Guard against future drift adding TTL / cleanup / tombstone vocabulary.
    await expect(
      page.getByText(/deletedSessionTtlMs|TTL|GC|回收|tombstone|cleanup/i),
    ).toHaveCount(0);
  });

  test('terminal header (active session) dark mode', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForURL(/\/workspace/);
    await page.waitForLoadState('networkidle');
    const SESS_ID = '11111111-1111-1111-1111-111111111111';
    const PROJ_ID = 'p-1';
    await page.route('**/api/sessions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              id: SESS_ID,
              projectId: PROJ_ID,
              mode: 'create',
              resumeSessionId: null,
              state: 'idle',
              createdAt: Date.now() - 60_000,
              deletedAt: null,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [{ id: PROJ_ID, name: 'demo-proj', path: '/tmp/demo' }],
        }),
      }),
    );
    await page.goto(`/workspace/${SESS_ID}`);
    await page.getByText('idle').first().waitFor();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-terminal-header-dark.png'),
      fullPage: false,
      clip: { x: 320, y: 0, width: 960, height: 80 },
    });
    await expect(page.getByText('demo-proj').first()).toBeVisible();
  });

  test('dead session pane (Resume preview) dark mode', async ({ page }) => {
    await page.goto('/workspace');
    await page.waitForURL(/\/workspace/);
    await page.waitForLoadState('networkidle');
    const DEAD_ID = '22222222-2222-2222-2222-222222222222';
    const PROJ_ID = 'p-dead';
    await page.route('**/api/sessions', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          sessions: [
            {
              id: DEAD_ID,
              projectId: PROJ_ID,
              mode: 'create',
              resumeSessionId: null,
              state: 'dead',
              createdAt: Date.now() - 120_000,
              deletedAt: null,
            },
          ],
        }),
      }),
    );
    await page.route('**/api/projects', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          projects: [{ id: PROJ_ID, name: 'paused-proj', path: '/tmp/paused' }],
        }),
      }),
    );
    await page.route(`**/api/sessions/${DEAD_ID}/screen`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: 'previous frame:\n  prompt > ls\n  foo  bar  baz\n  prompt > ',
      }),
    );
    await page.goto(`/workspace/${DEAD_ID}`);
    await page.getByRole('button', { name: 'Resume' }).waitFor();
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-dead-session-pane-dark.png'),
      fullPage: false,
      clip: { x: 320, y: 0, width: 960, height: 400 },
    });
    await expect(page.getByText('paused-proj').first()).toBeVisible();
    // dead pane label "已结束" lives both as the StatusBadge zh inner
    // span (md:hidden on desktop) and a plain main-pane span. The
    // Resume button assertion (next line) is the unambiguous signal.
    await expect(page.getByRole('button', { name: 'Resume' })).toBeVisible();
    await expect(page.getByText('prompt > ls').first()).toBeVisible();
  });

  //  P5 regression: dead pane plain-text render
  // on mobile viewport. Verifies sidebar drawer ☰ stays reachable (was
  // broken by P4 overlay z-index+pointer-events) and the snapshot text
  // is selectable via Range API (proxy for native long-press selection
  // which playwright can't simulate at the OS level).
  test.describe('mobile (iPhone 13)', () => {
    // Hand-set the iPhone 13 properties instead of spreading
    // devices['iPhone 13'] — the device descriptor includes
    // defaultBrowserType: 'webkit' which playwright rejects inside a
    // describe.use (forces a new worker).
    const iphone13 = devices['iPhone 13'];
    test.use({
      viewport: iphone13.viewport,
      userAgent: iphone13.userAgent,
      deviceScaleFactor: iphone13.deviceScaleFactor,
      isMobile: iphone13.isMobile,
      hasTouch: iphone13.hasTouch,
    });

    test('dead session pane (P7 DOM renderer + capture-phase mouse stop) — sidebar reachable + text selectable', async ({
      page,
    }) => {
      await page.goto('/workspace');
      await page.waitForURL(/\/workspace/);
      await page.waitForLoadState('networkidle');
      const DEAD_ID = '33333333-3333-3333-3333-333333333333';
      const PROJ_ID = 'p-dead-mobile';
      await page.route('**/api/sessions', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sessions: [
              {
                id: DEAD_ID,
                projectId: PROJ_ID,
                mode: 'create',
                resumeSessionId: null,
                state: 'dead',
                createdAt: Date.now() - 120_000,
                deletedAt: null,
              },
            ],
          }),
        }),
      );
      await page.route('**/api/projects', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            projects: [{ id: PROJ_ID, name: 'paused-mobile', path: '/tmp/m' }],
          }),
        }),
      );
      await page.route(`**/api/sessions/${DEAD_ID}/screen`, (route) =>
        route.fulfill({
          status: 200,
          contentType: 'text/plain; charset=utf-8',
          body: 'mobile frame:\n  prompt > ls\n  foo  bar  baz\n  prompt > ',
        }),
      );
      await page.goto(`/workspace/${DEAD_ID}`);
      await page.getByRole('button', { name: 'Resume' }).waitFor();

      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'visual-dead-session-pane-mobile-dark.png'),
        fullPage: false,
      });

      // P4 broke this: overlay z-index+pointer-events covered/intercepted
      // the header sibling area on mobile, making the drawer button hard
      // to reach. P5 has no overlay → ☰ stays clickable.
      const hamburger = page.getByRole('button', { name: '打开侧边栏' });
      await expect(hamburger).toBeVisible();

      // Plain-text snapshot is in DOM and visible (not behind canvas).
      await expect(page.getByText('prompt > ls').first()).toBeVisible();

      // Wait for xterm DOM renderer to actually paint rows. t.open +
      // t.write are async-queued — DOM cells appear only after the
      // RAF-paced renderer ticks.
      await page.waitForSelector('[data-dead-pane="true"] .xterm-rows > div', {
        timeout: 5000,
      });

      // Selectability proxy (P6): xterm's default DOM renderer puts
      // each cell in a <span>; xterm-overrides.css unlocks user-select
      // for [data-dead-pane="true"] descendants. Programmatically
      // selecting the xterm-rows container via Range and reading
      // getSelection() back confirms the spans are real native HTML
      // text and selectable. Native long-press is OS-level and not
      // driveable from playwright, but Range working means the element
      // is genuinely selectable end-to-end.
      const selectionText = await page.evaluate(() => {
        const xterm = document.querySelector(
          '[data-dead-pane="true"] .xterm-rows',
        );
        if (!xterm) return null;
        const range = document.createRange();
        range.selectNodeContents(xterm);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(range);
        return sel?.toString() ?? null;
      });
      expect(selectionText).toContain('prompt > ls');

      // Tap the drawer button → confirms touch routing reaches header
      // (P4 overlay would have intercepted). Sheet portal content
      // mounts to document.body with `data-slot="sheet-content"`
      //       await hamburger.tap();
      await expect(
        page.locator('[data-slot="sheet-content"]'),
      ).toBeVisible({ timeout: 2000 });
    });

    // Touch devices have no hover state, so session-list row delete
    // button cannot rely on group-hover to appear. Share moved to topbar
    // in ; only × delete remains on rows.
    test('session row delete button stays visible on mobile (no hover)', async ({
      page,
    }) => {
      const LIVE_ID = '44444444-4444-4444-4444-444444444444';
      const PROJ_ID = 'p-live-mobile';
      await page.route('**/api/sessions', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            sessions: [
              {
                id: LIVE_ID,
                projectId: PROJ_ID,
                mode: 'create',
                resumeSessionId: null,
                state: 'live',
                createdAt: Date.now() - 30_000,
                deletedAt: null,
              },
            ],
          }),
        }),
      );
      await page.route('**/api/projects', (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            projects: [{ id: PROJ_ID, name: 'live-mobile', path: '/tmp/m' }],
          }),
        }),
      );
      await page.goto('/workspace');
      await page.waitForLoadState('networkidle');
      // On mobile the sidebar starts closed; open the drawer so the
      // session list is on screen.
      await page.getByRole('button', { name: '打开侧边栏' }).tap();
      const deleteBtn = page.getByRole('button', { name: /^删除 / });
      await expect(deleteBtn).toBeVisible();
      // Share is no longer a row action — confirm it's gone from rows.
      const rowShareBtn = page.getByRole('button', { name: /^分享 / });
      await expect(rowShareBtn).toHaveCount(0);
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'visual-session-row-actions-mobile.png'),
        fullPage: false,
      });
    });

    // sidebar bottom row holds the three
    // global config buttons (settings / quota / feedback). They must be
    // visible on mobile drawer (touch, no hover).
    test('sidebar global actions (settings / quota / feedback) visible on mobile', async ({
      page,
    }) => {
      await page.goto('/workspace');
      await page.waitForLoadState('networkidle');
      await page.getByRole('button', { name: '打开侧边栏' }).tap();
      await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: '查看配额' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '反馈' })).toBeVisible();
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'visual-sidebar-globals-mobile.png'),
        fullPage: false,
      });
    });

    // ActiveHeaderIcons topbar render (↗ share + ↻ reload) is covered by
    // web/src/components/workspace-header-actions.test.tsx — e2e against
    // a real live session route hits a SPA URL/store race that's not
    // worth fighting here.
  });

  test('new-session step 2 history with long preview truncates (regression: dialog must not overflow)', async ({
    page,
  }) => {
    // Mock history endpoint so we control preview length deterministically.
    // The bug report: long preview text breaks dialog max-width. Fix is
    // ListBase row overflow-hidden + DialogBase children min-w-0 wrap.
    await page.route('**/api/projects/*/history', (route) => {
      const longPreview =
        '这是一个非常长的历史会话预览文本，目的是测试 dialog 内部是否会被长文本撑破 — '.repeat(
          5,
        );
      void route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          history: [
            {
              sessionId: 'long-preview-sess',
              modifiedAt: Date.now() - 60_000,
              preview: longPreview,
            },
            {
              sessionId: 'short-sess',
              modifiedAt: Date.now() - 3_600_000,
              preview: '短一点',
            },
          ],
        }),
      });
    });

    await page.goto('/workspace');
    await page.waitForLoadState('networkidle');
    await page.getByText('+ 新建').first().click();
    await page.waitForSelector('[data-slot="dialog-content"]');

    // Pick the first project (any will do — we mock the response anyway).
    // Scope to dialog so we don't accidentally click the ThemeToggle
    // radiogroup that lives in the workspace header.
    const dialog = page.locator('[data-slot="dialog-content"]');
    await dialog.locator('[role="radio"]').first().click();
    // Switch to resume tab.
    await page.getByRole('tab', { name: '从历史接续' }).click();
    // Submit advances to step 2 (button text "下一步").
    await page.getByRole('button', { name: '下一步' }).click();
    // Wait for mocked history to render inside the dialog.
    await dialog.locator('[role="radiogroup"]').waitFor();

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-history-long-preview-dark.png'),
      fullPage: true,
    });

    // Sanity: dialog rendered, long-preview row exists.
    await expect(page.getByText('选择要接续的会话')).toBeVisible();
  });
});
