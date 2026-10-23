import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
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
    const me = (await meRes.json()) as { id: string; email: string; emailVerified: boolean };
    expect(typeof me.id).toBe('string');
    expect(me.email).toBe('sandbox-probe@example.com');
    expect(me.emailVerified).toBe(true);
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
});
