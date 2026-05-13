import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke e2e against the prod ccanywhere instance via its real HTTPS frpc
 * domain. We deliberately do NOT short-circuit to 127.0.0.1 — staging on
 * a separate domain introduces its own environment drift (cert, port,
 * cookieName); testing on the real prod URL exercises the actual user
 * path (acme cert + frpc proxy + Secure cookie flag + SameSite=Lax).
 *
 * `globalSetup` calls the local internal RPC (which IS loopback-only) to
 * mint a limited e2e user's token, then writes storageState.json so the
 * playwright BrowserContext logs in with a token cookie. The internal RPC
 * is the only short-circuit; browser traffic goes through the public URL.
 *
 * Playwright BrowserContext is isolated from your real browser cookie
 * jar, so this never collides with the owner WebAuthn session you keep
 * logged in elsewhere.
 */
const baseURL = process.env['CCANYWHERE_TEST_URL'] ?? 'https://cc.recoco.xyz';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: 'list',
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
    storageState: './.auth/storageState.json',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
    // m-e2e-multi-browser (B6): webkit / firefox 只跑 smoke.spec.ts。
    // visual.spec.ts 用 page.screenshot({ path }) 直接写文件而非
    // toHaveScreenshot baseline 比较——跨 browser 共享同一 path 会互
    // 相覆盖，所以视觉截图限 chromium。
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'] },
      testMatch: /smoke\.spec\.ts$/,
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'] },
      testMatch: /smoke\.spec\.ts$/,
    },
  ],
});
