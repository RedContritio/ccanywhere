import { devices, expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Visual check for the chat-bubble share view (
 * P1 polish). Targets a freshly-minted share URL on prod — server-
 * rendered HTML, no SPA mount, public path (no auth cookie needed).
 *
 * The share code is read from CCANYWHERE_SHARE_CODE env so the test
 * stays reproducible regardless of who mints. CI / local devs run
 * `pnpm tsx scripts/mint-share.mjs` first and export the printed
 * code.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCREENSHOT_DIR = path.resolve(__dirname, '..', 'test-results');

const SHARE_CODE = process.env['CCANYWHERE_SHARE_CODE'];

test.describe('share view chat-bubble', () => {
  test.skip(
    SHARE_CODE === undefined,
    'set CCANYWHERE_SHARE_CODE=<uuid> after pnpm tsx scripts/mint-share.mjs',
  );

  test('desktop dark mode — bubble layout + alignment', async ({ page }) => {
    await page.addInitScript(() => {
      window.localStorage.setItem('ccanywhere-share.theme', 'dark');
    });
    await page.goto(`/share/${SHARE_CODE}`);
    await page.waitForLoadState('networkidle');
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'share-view-desktop-dark.png'),
      fullPage: true,
    });
    // Bubble structure assertions.
    const userBubbles = page.locator('article.msg.user');
    const assistantBubbles = page.locator('article.msg.assistant');
    await expect(userBubbles.first()).toBeVisible();
    await expect(assistantBubbles.first()).toBeVisible();
    // user bubble should sit on the right half; assistant on the left.
    // We check computed margin-left for user (auto = pushed right) and
    // margin-right for assistant (auto = pushed left).
    const userMarginLeft = await userBubbles
      .first()
      .evaluate((el) => getComputedStyle(el).marginLeft);
    const assistantMarginRight = await assistantBubbles
      .first()
      .evaluate((el) => getComputedStyle(el).marginRight);
    expect(parseFloat(userMarginLeft)).toBeGreaterThan(50);
    expect(parseFloat(assistantMarginRight)).toBeGreaterThan(50);
  });

  test.describe('mobile (iPhone 13)', () => {
    const iphone13 = devices['iPhone 13'];
    test.use({
      viewport: iphone13.viewport,
      userAgent: iphone13.userAgent,
      deviceScaleFactor: iphone13.deviceScaleFactor,
      isMobile: iphone13.isMobile,
      hasTouch: iphone13.hasTouch,
    });

    test('mobile dark mode — bubbles fit narrow viewport', async ({ page }) => {
      await page.addInitScript(() => {
        window.localStorage.setItem('ccanywhere-share.theme', 'dark');
      });
      await page.goto(`/share/${SHARE_CODE}`);
      await page.waitForLoadState('networkidle');
      await page.screenshot({
        path: path.join(SCREENSHOT_DIR, 'share-view-mobile-dark.png'),
        fullPage: true,
      });
      const userBubbles = page.locator('article.msg.user');
      await expect(userBubbles.first()).toBeVisible();
      // bubble shouldn't overflow viewport
      const w = await userBubbles
        .first()
        .evaluate((el) => el.getBoundingClientRect().width);
      expect(w).toBeLessThanOrEqual(390);
    });
  });
});
