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

  it('sends restrictive security headers and generic states without engine internals', async () => {
    for (const path of ['/auth-actions/verify-email', '/auth-actions/reset-password']) {
      const res = await get(path);
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('referrer-policy')).toContain('no-referrer');
      const csp = res.headers.get('content-security-policy') ?? '';
      expect(csp.length).toBeGreaterThan(0);
      expect(csp).toContain("frame-ancestors 'none'");

      const html = await res.text();
      expect(html).toMatch(/invalid|expired/i);
      expect(html).not.toContain('/api/auth');
      expect(html).not.toMatch(/better[\s_-]?auth/i);
    }
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
