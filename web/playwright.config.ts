import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke e2e against an already-running ccanywhere (LaunchAgent in dev,
 * or any reachable instance in CI). The default points at the LaunchAgent
 * port; override with CCANYWHERE_TEST_URL.
 */
const baseURL = process.env['CCANYWHERE_TEST_URL'] ?? 'http://127.0.0.1:62275';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL,
    headless: true,
    trace: 'retain-on-failure',
    viewport: { width: 1280, height: 800 },
    actionTimeout: 5_000,
    navigationTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
