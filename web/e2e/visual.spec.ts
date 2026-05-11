import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Visual screenshots for m-design-system-unify C3. Each test snaps a
 * meaningful UI state to `test-results/visual-*.png`. Author Read()s the
 * PNGs and does visual inspection — replaces the legacy "user opens
 * browser and checks visually" loop (see feedback_e2e_visual_verify.md).
 *
 * Coverage in this commit:
 *   - workspace home (no session selected) — base chrome / sidebar / theme
 *   - new-session dialog — DialogBase + Tabs + ListBase + SortButton
 *   - feedback dialog — DialogBase + Input + Textarea
 *
 * Out of scope: dialogs that require an active cc session (quota,
 * toolbar-edit unfortunately also reaches a `currentSession`-gated
 * trigger in mobile-toolbar). Those are left for the user's first
 * post-deploy peek.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-results');

test.describe('m-design-system-unify visual', () => {
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
    await page.locator('[role="radio"]').first().click();
    // Switch to resume tab.
    await page.getByRole('tab', { name: '从历史接续' }).click();
    // Submit advances to step 2 (button text "下一步").
    await page.getByRole('button', { name: '下一步' }).click();
    // Wait for mocked history to render.
    await page.waitForSelector('[role="radiogroup"]');

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'visual-history-long-preview-dark.png'),
      fullPage: true,
    });

    // Sanity: dialog rendered, long-preview row exists.
    await expect(page.getByText('选择要接续的会话')).toBeVisible();
  });
});
