import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { createIdentityRuntime } from './identity-runtime.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #93, ADR-0011): the public HTTP boundary of the built
// Worker with a sandbox-like mail configuration. Anonymous session reads must
// not depend on the transactional-mail transport; authenticated reads still
// resolve through Better Auth + D1; mail routes stay fail-closed; unexpected
// session defects surface as redacted phased telemetry (never 401).
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

// Dummy signing secret shared by the sandbox-like apps below. It is test-only
// material, never a real credential, and must never appear in logs.
const SANDBOX_SECRET = 'sandbox-test-signing-secret-0000000000000000000000000001';

// Sandbox-shaped non-secret config plus the shared dummy signing secret, but
// without SMTP provider credentials. Mirrors the live RCH sandbox shape
// (AUTH_MAIL_TRANSPORT=smtp via Gmail submission) without holding real secrets.
function sandboxLikeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'sandbox',
    AUTH_MAIL_TRANSPORT: 'smtp',
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
    AUTH_MAIL_ALLOWLIST: 'ops@example.com',
    BETTER_AUTH_SECRET: SANDBOX_SECRET,
    ...overrides,
  };
}

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

function failureRecords(seen: string[]): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const line of seen) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'object' && parsed !== null) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Non-JSON console output carries no failure telemetry.
    }
  }
  return records.filter((record) => record.event === 'session.resolve-failed');
}

async function waitForVerificationMessage(mailer: InMemoryAuthMailer): Promise<void> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mailer.sent.length).toBeGreaterThan(0);
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
});

describe('sandbox-like anonymous session reads (ticket #93)', () => {
  it('returns 401 unauthenticated without SMTP provider credentials', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      const app = createApp();
      const res = await app.request('/v1/me', { method: 'GET' }, sandboxLikeEnv());

      expect(res.status).toBe(401);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await res.json()).toEqual({
        type: 'urn:problem:unauthenticated',
        title: 'Unauthenticated',
        status: 401,
        code: 'unauthenticated',
        instance: '/v1/me',
      });
      // An absent session is the expected outcome, not a failure: no failure
      // telemetry is emitted for the anonymous 401 path.
      expect(failureRecords(seen)).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('still resolves an authenticated session through Better Auth + D1', async () => {
    const mailer = new InMemoryAuthMailer();
    const setupApp = createApp({ authMailer: mailer });
    const sessionApp = createApp();
    const environment = sandboxLikeEnv();

    const registerRes = await setupApp.request(
      '/v1/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Sandbox Probe',
          email: 'sandbox-probe@example.com',
          password: 'Correct-horse-41',
        }),
      },
      environment,
    );
    expect(registerRes.status).toBe(201);
    await waitForVerificationMessage(mailer);

    const messages = mailer.sent;
    expect(messages.length).toBeGreaterThan(0);
    const token = new URL(messages[messages.length - 1]?.url ?? '').searchParams.get('token');
    expect(token).not.toBeNull();

    const verifyRes = await setupApp.request(
      '/v1/auth/verify-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      },
      environment,
    );
    expect(verifyRes.status).toBe(200);

    const loginRes = await setupApp.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sandbox-probe@example.com', password: 'Correct-horse-41' }),
      },
      environment,
    );
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();

    // The session read runs on an app without an injected mailer and without
    // SMTP provider credentials: it must still resolve the same
    // application-owned user contract through Better Auth + D1.
    const meRes = await sessionApp.request(
      '/v1/me',
      { method: 'GET', headers: { cookie: cookie ?? '' } },
      sandboxLikeEnv(),
    );
    expect(meRes.status).toBe(200);
    const me = (await meRes.json()) as {
      id: string;
      email: string;
      emailVerified: boolean;
      realm: string;
    };
    expect(typeof me.id).toBe('string');
    expect(me.email).toBe('sandbox-probe@example.com');
    expect(me.emailVerified).toBe(true);
    expect(me.realm).toBe('reader');
  });

  it('keeps session-backed administration and Reader State independent from mail configuration', async () => {
    const mailer = new InMemoryAuthMailer();
    const setupApp = createApp({ authMailer: mailer });
    const environment = sandboxLikeEnv({
      AUTH_JWT_ISSUER: 'https://identity.example.com',
      AUTH_READER_STATE_AUDIENCE: 'identity-reader-state',
      AUTH_READER_STATE_TTL_SECONDS: '900',
    });
    const bootstrap = await setupApp.request(
      '/v1/admin/auth/bootstrap',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Runtime Administrator',
          email: 'runtime-admin@example.com',
          password: 'Correct-horse-41',
        }),
      },
      environment,
    );
    expect(bootstrap.status).toBe(201);
    const administrator = (await bootstrap.json()) as { id: string };
    await waitForVerificationMessage(mailer);
    const verificationToken = new URL(mailer.sent[0]?.url ?? '').searchParams.get('token');
    expect(verificationToken).not.toBeNull();
    const verify = await setupApp.request(
      '/v1/admin/auth/verify-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: verificationToken }),
      },
      environment,
    );
    expect(verify.status).toBe(200);
    const login = await setupApp.request(
      '/v1/admin/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          email: 'runtime-admin@example.com',
          password: 'Correct-horse-41',
        }),
      },
      environment,
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookieFrom(login);
    expect(cookie).not.toBeNull();

    const noMailRuntime = createApp();
    const request = async (path: string): Promise<Response> =>
      await noMailRuntime.request(
        path,
        { method: 'GET', headers: { cookie: cookie ?? '' } },
        environment,
      );
    expect((await request('/v1/me')).status).toBe(401);
    expect((await request('/v1/admin/me')).status).toBe(200);
    expect((await request('/v1/admin/users')).status).toBe(200);
    expect((await request(`/v1/admin/users/${administrator.id}`)).status).toBe(404);

    const readerState = await noMailRuntime.request(
      '/v1/auth/reader-state',
      {
        method: 'POST',
        headers: { cookie: cookie ?? '', 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
      environment,
    );
    expect(readerState.status).toBe(401);
    expect(readerState.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps transactional-mail routes fail-closed without SMTP credentials', async () => {
    const app = createApp();
    const res = await app.request(
      '/v1/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Mail Guard',
          email: 'mail-guard@example.com',
          password: 'Correct-horse-41',
        }),
      },
      sandboxLikeEnv(),
    );

    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal-error', status: 500 });
  });

  it('checks a password-reset token without constructing the mail transport', async () => {
    const app = createApp();
    const res = await app.request(
      '/v1/auth/check-password-reset',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'unknown-reset-token' }),
      },
      sandboxLikeEnv(),
    );

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ valid: false });
  });

  it('logs a redacted config phase instead of converting session defects to 401', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });
    try {
      const app = createApp();
      const withoutSecret: Env = { ...sandboxLikeEnv(), BETTER_AUTH_SECRET: undefined };
      const res = await app.request('/v1/me', { method: 'GET' }, withoutSecret);

      // Unexpected defects must not masquerade as "unauthenticated".
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: 'internal-error', status: 500 });

      const failures = failureRecords(seen);
      expect(failures).toHaveLength(1);
      const failure = failures[0];
      expect(failure?.level).toBe('error');
      expect(failure?.event).toBe('session.resolve-failed');
      expect(failure?.phase).toBe('config');
      // Correlation is preserved: the failure joins the same request trace.
      expect(typeof failure?.requestId).toBe('string');
      expect((failure?.requestId as string).length).toBeGreaterThan(0);

      const transcript = seen.join('\n');
      // Raw exception text, secrets and session material never enter logs.
      expect(transcript).not.toContain('refusing to start');
      expect(transcript).not.toContain(SANDBOX_SECRET);
      expect(transcript).not.toContain('better-auth.session_token');
      expect(transcript).not.toContain('token=');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps lazy Better Auth initialization failures in the session phase', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      await expect(
        createIdentityRuntime({
          env: sandboxLikeEnv(),
          requestUrl: 'not-an-absolute-url',
          authMailer: new InMemoryAuthMailer(),
        }).resolveSessionContext(new Headers()),
      ).rejects.toThrow();

      const failures = failureRecords(seen);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.phase).toBe('session');
      expect(seen.join('\n')).not.toContain('not-an-absolute-url');
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps Better Auth D1 session-store failures in the session phase', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });
    const mailer = new InMemoryAuthMailer();
    const setupApp = createApp({ authMailer: mailer });
    const register = await setupApp.request(
      '/v1/auth/register',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Session Phase Probe',
          email: 'session-phase@example.com',
          password: 'Correct-horse-41',
        }),
      },
      sandboxLikeEnv(),
    );
    expect(register.status).toBe(201);
    await waitForVerificationMessage(mailer);
    const verificationToken = new URL(mailer.sent[0]?.url ?? '').searchParams.get('token');
    expect(verificationToken).not.toBeNull();
    const verify = await setupApp.request(
      '/v1/auth/verify-email',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: verificationToken }),
      },
      sandboxLikeEnv(),
    );
    expect(verify.status).toBe(200);
    const login = await setupApp.request(
      '/v1/auth/login',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'session-phase@example.com', password: 'Correct-horse-41' }),
      },
      sandboxLikeEnv(),
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookieFrom(login);
    expect(cookie).not.toBeNull();

    const prepareSpy = vi.spyOn(workerEnv.DB, 'prepare').mockImplementation(() => {
      throw new Error('session-store-probe-secret');
    });
    try {
      await expect(
        createIdentityRuntime({
          env: sandboxLikeEnv(),
          requestUrl: 'http://localhost',
          authMailer: mailer,
        }).resolveSessionContext(new Headers({ cookie: cookie ?? '' })),
      ).rejects.toThrow();

      const failures = failureRecords(seen);
      expect(failures).toHaveLength(1);
      expect(failures[0]?.phase).toBe('session');
      expect(seen.join('\n')).not.toContain('session-store-probe-secret');
    } finally {
      prepareSpy.mockRestore();
      spy.mockRestore();
    }
  });
});
