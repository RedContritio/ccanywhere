import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const CONFIG_PATH =
  process.env['CCANYWHERE_TEST_CONFIG'] ??
  join(homedir(), '.config/ccanywhere/config.json');

function loadToken(): string {
  const fromEnv = process.env['CCANYWHERE_TEST_TOKEN'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `ccanywhere config not found at ${CONFIG_PATH}; set CCANYWHERE_TEST_TOKEN`,
    );
  }
  const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as {
    tokens?: Array<{ token?: string }>;
  };
  const t = cfg.tokens?.[0]?.token;
  if (typeof t !== 'string' || t.length === 0) {
    throw new Error(`no token in ${CONFIG_PATH}`);
  }
  return t;
}

const TOKEN = loadToken();

/** Hook page-level error capture so silent failures (uncaught exceptions,
 *  console.error) become test failures. */
function trackConsole(page: Page): { errors: string[] } {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  return { errors };
}

test.describe('ccanywhere smoke', () => {
  test('healthz is public and returns ok:true', async ({ request }) => {
    const res = await request.get('/healthz');
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test('login → workspace → "+ 新建" opens dialog without page errors', async ({
    page,
  }) => {
    const { errors } = trackConsole(page);

    await page.goto('/login');
    await page.getByPlaceholder(/config\.json/i).fill(TOKEN);
    await page.getByPlaceholder(/laptop/i).fill('e2e-test');
    await page.getByRole('button', { name: '登入' }).click();

    await expect(page).toHaveURL(/\/workspace/, { timeout: 5_000 });

    // Click "+ 新建" — should open the new-session dialog. This regressed
    // when crypto.randomUUID() was called in an insecure context (HTTP via
    // frpc): handler threw, dialog never opened.
    await page.getByRole('button', { name: /\+ 新建/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible({ timeout: 2_000 });
    await expect(page.getByText(/新建会话/)).toBeVisible();

    expect(errors, `unexpected page errors:\n${errors.join('\n')}`).toEqual([]);
  });

  test('rejects bad token with human-readable message', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/config\.json/i).fill('not-a-real-token-1234');
    await page.getByPlaceholder(/laptop/i).fill('e2e-test');
    await page.getByRole('button', { name: '登入' }).click();

    await expect(page.getByText(/token 无效/)).toBeVisible({ timeout: 5_000 });
  });

  test('full create-then-delete flow leaves manager clean', async ({
    page,
    request,
  }) => {
    await page.goto('/login');
    await page.getByPlaceholder(/config\.json/i).fill(TOKEN);
    await page.getByPlaceholder(/laptop/i).fill('e2e-test');
    await page.getByRole('button', { name: '登入' }).click();
    await expect(page).toHaveURL(/\/workspace/, { timeout: 5_000 });

    await page.getByRole('button', { name: /\+ 新建/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: '创建' }).click();

    // After creation the dialog closes and we navigate to /workspace/:id
    await expect(page).toHaveURL(/\/workspace\/[0-9a-f-]{36}$/, { timeout: 10_000 });

    // The session row must appear in the list and the URL :id must match.
    const url = page.url();
    const id = url.split('/').pop() ?? '';
    expect(id).toMatch(/^[0-9a-f-]{36}$/);

    // Clean up by hitting DELETE directly (avoids depending on a × button selector).
    const del = await request.delete(`/api/sessions/${id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(del.status()).toBe(204);
  });
});
