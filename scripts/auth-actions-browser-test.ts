import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { createAuthActionsRouter } from '../src/features/identity/auth-actions.js';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Auth action browser assertion: ${message}`);
}

async function waitForCount(
  locator: { count(): Promise<number> },
  expected: number,
): Promise<void> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if ((await locator.count()) === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${String(expected)} matching elements.`);
}

export async function runAuthActionsBrowserTest(): Promise<void> {
  const response = await createAuthActionsRouter().request(
    'http://service.test/reset-password?token=browser-token',
  );
  assert(response.status === 200, 'reset action route responds');
  const source = await response.text();
  const document = source.replace('<head>', '<head><base href="http://service.test/">');
  const executablePath = [
    process.env.CHROME_PATH,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].find((path) => path !== undefined && existsSync(path));
  const browser = await chromium.launch({
    ...(executablePath === undefined ? {} : { executablePath }),
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.route('**/v1/auth/config', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          capabilities: {
            registration: true,
            emailPassword: true,
            emailVerification: true,
            passwordReset: true,
          },
          passwordPolicy: {
            minLength: 10,
            maxLength: 64,
            minUppercase: 2,
            minLowercase: 1,
            minDigits: 2,
            minSymbols: 1,
          },
        }),
      }),
    );
    await page.route('**/v1/auth/reset-password', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"status":"ok"}',
      });
    });
    await page.route('**/reset-password?token=browser-token', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: document }),
    );
    await page.goto('http://service.test/reset-password?token=browser-token');
    await waitForCount(page.locator('#requirements li'), 6);
    assert(
      (await page.locator('#new-password').getAttribute('minlength')) === '10',
      'policy sets minimum',
    );
    await page.locator('#new-password').fill('Abcdefgh12!');
    await page.getByRole('button', { name: 'Set new password' }).click();
    assert(
      (await page.locator('#status').textContent())?.includes('current requirements'),
      'shows policy error',
    );
    await page.locator('#new-password').fill('ABcdefgh12!');
    await page.getByRole('button', { name: 'Set new password' }).click();
    await page.getByText('Your password was reset.').waitFor();

    const fallback = await browser.newPage();
    await fallback.route('**/v1/auth/config', (route) => route.abort());
    await fallback.route('**/v1/auth/reset-password', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: '{"status":"ok"}',
      });
    });
    await fallback.route('**/reset-password?token=browser-token', (route) =>
      route.fulfill({ status: 200, contentType: 'text/html', body: document }),
    );
    await fallback.goto('http://service.test/reset-password?token=browser-token');
    await fallback.locator('#new-password').fill('short');
    await fallback.getByRole('button', { name: 'Set new password' }).click();
    await fallback.getByText('Your password was reset.').waitFor();
    await fallback.close();
  } finally {
    await browser.close();
  }
}
