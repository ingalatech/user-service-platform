import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #77, ADR-0011): the public HTTP boundary of the
// built Worker inside the Cloudflare Workers runtime with the isolated test
// D1 database. Mail generated from a normal request must carry
// application-owned action URLs (never Better Auth `/api/auth/*` callbacks),
// and the service-owned fallback browser pages must complete through the
// existing POST `/v1` contracts with generic states and security headers.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    ...overrides,
  };
}

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

async function sha256Base64(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return btoa(String.fromCharCode(...new Uint8Array(digest)));
}

function contrastRatio(foreground: string, background: string): number {
  const channel = (value: string, offset: number): number => {
    const component = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return component <= 0.03928 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (value: string): number =>
    0.2126 * channel(value, 1) + 0.7152 * channel(value, 3) + 0.0722 * channel(value, 5);
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

async function waitForVerificationMessages(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mailer.sent.length).toBeGreaterThanOrEqual(count);
}

async function post(path: string, body: unknown, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv(overrides),
  );
}

async function get(path: string, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(path, { method: 'GET' }, testEnv(overrides));
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM "admin_session"'),
    db.prepare('DELETE FROM "admin_account"'),
    db.prepare('DELETE FROM "admin_verification"'),
    db.prepare('DELETE FROM "admin_email_verification_token"'),
    db.prepare('DELETE FROM "admin_user"'),
    db.prepare('DELETE FROM "admin_bootstrap_attempt"'),
    db.prepare('DELETE FROM "admin_bootstrap_guard"'),
    db.prepare('DELETE FROM "session"'),
    db.prepare('DELETE FROM "account"'),
    db.prepare('DELETE FROM "verification"'),
    db.prepare('DELETE FROM "email_verification_token"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('application-owned mail action URLs', () => {
  it('sends verification mail to the service-owned fallback route without Better Auth callbacks', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Action Page',
      email: 'action-page@example.com',
      password: 'Correct-horse-41',
    });
    expect(res.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);

    const message = mailer.sent[0];
    expect(message).toBeDefined();
    const target = new URL(message?.url ?? '');
    expect(message?.url).not.toContain('/api/auth');
    expect(`${target.origin}${target.pathname}`).toBe('http://localhost/auth-actions/verify-email');
    expect(target.searchParams.get('token')).toBe(message?.token);
    expect(target.searchParams.getAll('token')).toHaveLength(1);
    expect(target.searchParams.get('token')?.length).toBeGreaterThan(0);
  });

  it('sends password-reset mail to the service-owned fallback route without Better Auth callbacks', async () => {
    await post('/v1/auth/register', {
      name: 'Reset Page',
      email: 'reset-page@example.com',
      password: 'Correct-horse-41',
    });
    await waitForVerificationMessages(1);
    const token = new URL(mailer.sent[mailer.sent.length - 1]?.url ?? '').searchParams.get('token');
    expect(token).not.toBeNull();
    await post('/v1/auth/verify-email', { token });
    mailer.clear();

    const res = await post('/v1/auth/request-password-reset', {
      email: 'reset-page@example.com',
    });
    expect(res.status).toBe(202);
    expect(mailer.passwordResets).toHaveLength(1);

    const message = mailer.passwordResets[0];
    const target = new URL(message?.url ?? '');
    expect(message?.url).not.toContain('/api/auth');
    expect(`${target.origin}${target.pathname}`).toBe(
      'http://localhost/auth-actions/reset-password',
    );
    expect(target.searchParams.get('token')).toBe(message?.token);
    expect(target.searchParams.getAll('token')).toHaveLength(1);
  });

  it('targets a configured consumer action page and preserves its non-token parameters', async () => {
    const overrides = {
      AUTH_VERIFY_EMAIL_ACTION_URL: 'https://app.example.com/verify?next=%2Fwelcome',
      AUTH_RESET_PASSWORD_ACTION_URL: 'https://app.example.com/reset?next=%2Fwelcome',
    };
    await post(
      '/v1/auth/register',
      { name: 'Custom Page', email: 'custom-page@example.com', password: 'Correct-horse-41' },
      overrides,
    );
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);
    const verification = new URL(mailer.sent[0]?.url ?? '');
    expect(mailer.sent[0]?.url).not.toContain('/api/auth');
    expect(`${verification.origin}${verification.pathname}`).toBe('https://app.example.com/verify');
    expect(verification.searchParams.get('next')).toBe('/welcome');
    expect(verification.searchParams.get('token')).toBe(mailer.sent[0]?.token);

    const token = verification.searchParams.get('token');
    await post('/v1/auth/verify-email', { token }, overrides);
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'custom-page@example.com' }, overrides);
    expect(mailer.passwordResets).toHaveLength(1);
    const reset = new URL(mailer.passwordResets[0]?.url ?? '');
    expect(mailer.passwordResets[0]?.url).not.toContain('/api/auth');
    expect(`${reset.origin}${reset.pathname}`).toBe('https://app.example.com/reset');
    expect(reset.searchParams.get('next')).toBe('/welcome');
    expect(reset.searchParams.get('token')).toBe(mailer.passwordResets[0]?.token);
  });
});

describe('service-owned fallback browser pages', () => {
  it('serves Administrator verification through the explicit Admin realm action route', async () => {
    const bootstrap = await post('/v1/admin/auth/bootstrap', {
      name: 'Action Admin',
      email: 'action-admin@example.com',
      password: 'Correct-horse-41',
    });
    expect(bootstrap.status).toBe(201);
    await waitForVerificationMessages(1);
    const actionUrl = new URL(mailer.sent.at(-1)?.url ?? '');
    expect(actionUrl.pathname).toBe('/auth-actions/admin/verify-email');
    const page = await get(actionUrl.pathname);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('/v1/admin/auth/verify-email');
    expect(html).not.toContain('/v1/auth/verify-email');
    const verify = await post('/v1/admin/auth/verify-email', {
      token: actionUrl.searchParams.get('token'),
    });
    expect(verify.status).toBe(200);
    const login = await post('/v1/admin/auth/login', {
      email: 'action-admin@example.com',
      password: 'Correct-horse-41',
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toContain('rch-admin.session_token=');
  });

  it('serves a verification action page that completes through POST /v1/auth/verify-email', async () => {
    const page = await get('/auth-actions/verify-email?token=placeholder');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    await post('/v1/auth/register', {
      name: 'Browser Verify',
      email: 'browser-verify@example.com',
      password: 'Correct-horse-41',
    });
    await waitForVerificationMessages(1);
    const token = new URL(mailer.sent[mailer.sent.length - 1]?.url ?? '').searchParams.get('token');
    expect(token).not.toBeNull();

    const verifyRes = await post('/v1/auth/verify-email', { token });
    expect(verifyRes.status).toBe(200);
    const loginRes = await post('/v1/auth/login', {
      email: 'browser-verify@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
  });

  it('serves a reset action page that completes through POST /v1/auth/reset-password', async () => {
    const page = await get('/auth-actions/reset-password?token=placeholder');
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');

    await post('/v1/auth/register', {
      name: 'Browser Reset',
      email: 'browser-reset@example.com',
      password: 'Correct-horse-41',
    });
    await waitForVerificationMessages(1);
    const verifyToken = new URL(mailer.sent[mailer.sent.length - 1]?.url ?? '').searchParams.get(
      'token',
    );
    await post('/v1/auth/verify-email', { token: verifyToken });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'browser-reset@example.com' });
    const resetToken = mailer.passwordResets[mailer.passwordResets.length - 1]?.token;
    expect(resetToken?.length).toBeGreaterThan(0);

    const resetRes = await post('/v1/auth/reset-password', {
      token: resetToken,
      newPassword: 'Brand-new-horse-42',
    });
    expect(resetRes.status).toBe(200);
    const loginRes = await post('/v1/auth/login', {
      email: 'browser-reset@example.com',
      password: 'Brand-new-horse-42',
    });
    expect(loginRes.status).toBe(200);
  });

  it('completes the Administrator reset fallback only in the Administrator realm', async () => {
    const email = 'same-realm@example.com';
    const adminPassword = 'Admin-old-horse-41';
    const readerPassword = 'Reader-old-horse-41';
    const adminBootstrap = await post('/v1/admin/auth/bootstrap', {
      name: 'Fallback Admin',
      email,
      password: adminPassword,
    });
    expect(adminBootstrap.status).toBe(201);
    const adminVerificationToken = new URL(mailer.sent.at(-1)?.url ?? '').searchParams.get('token');
    expect(
      (await post('/v1/admin/auth/verify-email', { token: adminVerificationToken })).status,
    ).toBe(200);

    const readerRegistration = await post('/v1/auth/register', {
      name: 'Fallback Reader',
      email,
      password: readerPassword,
    });
    expect(readerRegistration.status).toBe(201);
    const readerVerificationToken = new URL(mailer.sent.at(-1)?.url ?? '').searchParams.get(
      'token',
    );
    expect((await post('/v1/auth/verify-email', { token: readerVerificationToken })).status).toBe(
      200,
    );

    mailer.clear();
    const request = await post('/v1/admin/auth/request-password-reset', { email });
    expect(request.status).toBe(202);
    const message = mailer.passwordResets.at(-1);
    expect(message).toBeDefined();
    const actionUrl = new URL(message?.url ?? '');
    expect(actionUrl.pathname).toBe('/auth-actions/admin/reset-password');
    expect(await (await get(actionUrl.pathname)).text()).toContain('/v1/admin/auth/reset-password');
    const adminToken = message?.token;
    expect(adminToken).toBeDefined();
    expect(
      await (await post('/v1/auth/check-password-reset', { token: adminToken })).json(),
    ).toEqual({
      valid: false,
    });

    const reset = await post('/v1/admin/auth/reset-password', {
      token: adminToken,
      newPassword: 'Admin-new-horse-42',
    });
    expect(reset.status).toBe(200);
    expect(
      (await post('/v1/admin/auth/login', { email, password: adminPassword })).status,
    ).not.toBe(200);
    expect(
      (await post('/v1/admin/auth/login', { email, password: 'Admin-new-horse-42' })).status,
    ).toBe(200);
    expect((await post('/v1/auth/login', { email, password: readerPassword })).status).toBe(200);
  });

  it('sends restrictive security headers and generic states without engine internals', async () => {
    for (const path of ['/auth-actions/verify-email', '/auth-actions/reset-password']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('referrer-policy')).toContain('no-referrer');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp.length).toBeGreaterThan(0);
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toContain("'unsafe-inline'");

      const html = await res.text();
      const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1];
      const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
      expect(style).toBeDefined();
      expect(script).toBeDefined();
      expect(csp).toContain(`script-src 'sha256-${await sha256Base64(script ?? '')}'`);
      expect(csp).toContain(`style-src 'sha256-${await sha256Base64(style ?? '')}'`);
      expect(csp).not.toMatch(/(?:https?:)?\/\//);
      expect(html).not.toMatch(/<(?:script[^>]+src|link\b)/i);
      expect(html).toMatch(/invalid|expired/i);
      expect(html).not.toContain('/api/auth');
      expect(html).not.toMatch(/better[\s_-]?auth/i);
      expect(html).toContain('auth-screen');
      expect(html).toContain('auth-card');
      expect(html).toContain('--background:oklch(1 0 0)');
      expect(html).toContain('--primary:oklch(.205 0 0)');
      expect(html).toContain('prefers-color-scheme:dark');
      expect(html).toContain('prefers-reduced-motion:reduce');
      expect(html).not.toContain('linear-gradient');
      expect(html).not.toContain('class="mark"');
      expect(html).not.toContain('User Service');
      expect(html).not.toContain('--accent');
      expect(html).not.toContain('#1b75bb');
    }
  });

  it('keeps official action colors at WCAG AA for text and 3:1 for focus indicators', async () => {
    const html = await (await get('/auth-actions/reset-password')).text();
    expect(contrastRatio('#ffffff', '#2f2f2f')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#2f2f2f', '#f4f4f4')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#8f8f8f', '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio('#8f8f8f', '#252525')).toBeGreaterThanOrEqual(3);
    expect(html).toContain('--primary-foreground:oklch(.985 0 0)');
    expect(html).toContain('--ring:oklch(.708 0 0)');
  });

  it('renders the reset form with accessible policy and status hooks', async () => {
    const html = await (await get('/auth-actions/reset-password?token=placeholder')).text();
    expect(html).toContain('autocomplete="new-password"');
    expect(html).toContain('aria-describedby="requirements"');
    expect(html).toContain('id="requirements" aria-live="polite"');
    expect(html).toContain('Your password does not meet the current requirements.');
    expect(html).toContain('Your password was reset. You can now sign in.');
  });

  it('keeps the fallback pages out of the generated OpenAPI contract', async () => {
    const res = await app.request('/v1/openapi.json', { method: 'GET' }, testEnv());
    expect(res.status).toBe(200);
    const document = (await res.json()) as { paths?: Record<string, unknown> };
    for (const path of Object.keys(document.paths ?? {})) {
      expect(path).not.toContain('auth-actions');
    }
  });

  it('never logs tokens, action URLs or query strings on the fallback pages', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      await get('/auth-actions/verify-email?token=s3cret-marker');
      await get('/auth-actions/reset-password?token=s3cret-marker');
    } finally {
      spy.mockRestore();
    }
    const transcript = seen.join('\n');
    expect(transcript).not.toContain('s3cret-marker');
    expect(transcript).not.toContain('token=');
  });
});
