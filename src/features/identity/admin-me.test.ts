import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #124, ADR-0011): the public HTTP boundary of the
// built Worker, executed inside the Cloudflare Workers runtime with the
// isolated test D1 database. These tests prove the application-owned
// `GET /v1/admin/me` authorization boundary: anonymous sessions end in the
// existing 401, verified regular Users end in an explicit 403, and only a
// verified session holding Better Auth User listing/read access reaches the
// exact administrative representation. No Better Auth or D1 internals cross
// the assertions; only status codes, stable problem codes and the public
// response shape are observed.
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

async function get(
  path: string,
  init: { cookie?: string | null; overrides?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined && init.cookie !== null && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  return app.request(path, { method: 'GET', headers }, testEnv(init.overrides));
}

async function postWithCookie(
  path: string,
  body: unknown,
  cookie: string | null,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null && cookie.length > 0) {
    headers.cookie = cookie;
  }
  return app.request(
    path,
    { method: 'POST', headers, body: JSON.stringify(body) },
    testEnv(overrides),
  );
}

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

function tokenFromLastVerificationMessage(): string {
  const messages = mailer.sent;
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured verification message.');
  }
  const token = new URL(last.url).searchParams.get('token');
  if (token === null) {
    throw new Error('Expected a token in the captured verification action URL.');
  }
  return token;
}

async function verifyEmailAddress(email: string, administrator = false): Promise<void> {
  const prefix = administrator ? '/v1/admin/auth' : '/v1/auth';
  const requestRes = await post(`${prefix}/request-verification`, { email });
  expect(requestRes.status).toBe(202);
  const verifyRes = await post(`${prefix}/verify-email`, {
    token: tokenFromLastVerificationMessage(),
  });
  expect(verifyRes.status).toBe(200);
}

async function verifiedAdminCookie(): Promise<string> {
  const bootstrapRes = await post('/v1/admin/auth/bootstrap', {
    name: 'Ada Admin',
    email: 'admin@example.com',
    password: 'Correct-horse-41',
  });
  expect(bootstrapRes.status).toBe(201);
  await verifyEmailAddress('admin@example.com', true);
  const loginRes = await post('/v1/admin/auth/login', {
    email: 'admin@example.com',
    password: 'Correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified administrator.');
  }
  return cookie;
}

async function verifiedRegularCookie(): Promise<string> {
  const registerRes = await post('/v1/auth/register', {
    name: 'Ordinary User',
    email: 'ordinary@example.com',
    password: 'Correct-horse-41',
  });
  expect(registerRes.status).toBe(201);
  await verifyEmailAddress('ordinary@example.com');
  const loginRes = await post('/v1/auth/login', {
    email: 'ordinary@example.com',
    password: 'Correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified regular User.');
  }
  return cookie;
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
    db.prepare('DELETE FROM "session"'),
    db.prepare('DELETE FROM "account"'),
    db.prepare('DELETE FROM "verification"'),
    db.prepare('DELETE FROM "email_verification_token"'),
    db.prepare('DELETE FROM "admin_bootstrap_attempt"'),
    db.prepare('DELETE FROM "admin_bootstrap_guard"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('GET /v1/admin/me', () => {
  it('rejects anonymous requests with the existing unauthenticated problem', async () => {
    const res = await get('/v1/admin/me');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'urn:problem:unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'unauthenticated',
      instance: '/v1/admin/me',
    });
  });

  it('returns the exact administrative representation for a verified administrator', async () => {
    const cookie = await verifiedAdminCookie();

    const res = await get('/v1/admin/me', { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'emailVerified', 'id', 'realm', 'role']);
    expect(body.realm).toBe('administrator');
    expect(body.email).toBe('admin@example.com');
    expect(body.emailVerified).toBe(true);
    expect(body.role).toBe('admin');
    expect(typeof body.id).toBe('string');
  });

  it('does not treat a Reader session as an Administrator session', async () => {
    const cookie = await verifiedRegularCookie();

    const res = await get('/v1/admin/me', { cookie });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('rejects a revoked session as unauthenticated', async () => {
    const cookie = await verifiedAdminCookie();
    const signOutRes = await postWithCookie('/v1/admin/auth/sign-out', {}, cookie);
    expect(signOutRes.status).toBe(200);

    const res = await get('/v1/admin/me', { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects an expired session even when its signed cookie remains present', async () => {
    const cookie = await verifiedAdminCookie();
    await workerEnv.DB.prepare('UPDATE "admin_session" SET expires_at = 0').run();
    const res = await get('/v1/admin/me', { cookie });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('reads administrative identity independently of mail-provider credentials', async () => {
    const cookie = await verifiedAdminCookie();
    const readApp = createApp();
    const res = await readApp.request(
      '/v1/admin/me',
      { headers: { cookie } },
      testEnv({
        AUTH_MAIL_TRANSPORT: 'smtp',
        SMTP_HOST: 'smtp.example.com',
        SMTP_PORT: '587',
        SMTP_SECURE: 'false',
        AUTH_MAIL_FROM: 'service@example.com',
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ role: 'admin', emailVerified: true });
  });

  it('does not resolve an Administrator cookie through Reader endpoints', async () => {
    const cookie = await verifiedAdminCookie();

    const me = await get('/v1/me', { cookie });
    const readerState = await postWithCookie('/v1/auth/reader-state', {}, cookie);

    expect(me.status).toBe(401);
    expect(readerState.status).toBe(401);
  });
});
