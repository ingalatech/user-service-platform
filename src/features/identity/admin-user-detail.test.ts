import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #126, ADR-0011): the public HTTP boundary of the
// built Worker, executed inside the Cloudflare Workers runtime with the
// isolated test D1 database. These tests prove the application-owned
// `GET /v1/admin/users/{userId}` detail boundary: verified administrators
// read one real User through the exact safe projection, missing Users end in
// a distinct 404, invalid identifiers end in the existing 400 contract, and
// anonymous/regular/revoked sessions are rejected before any User lookup.
// Telemetry assertions prove parameterized detail logs carry the matched
// route pattern instead of raw User identifiers or personal data. Only
// status codes, stable problem codes and the exact public representation are
// observed.
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

async function verifyEmailAddress(email: string): Promise<void> {
  const requestRes = await post('/v1/auth/request-verification', { email });
  expect(requestRes.status).toBe(202);
  const verifyRes = await post('/v1/auth/verify-email', {
    token: tokenFromLastVerificationMessage(),
  });
  expect(verifyRes.status).toBe(200);
}

async function registerVerifiedUser(name: string, email: string): Promise<void> {
  const registerRes = await post('/v1/auth/register', {
    name,
    email,
    password: 'Correct-horse-41',
  });
  expect(registerRes.status).toBe(201);
  await verifyEmailAddress(email);
}

async function userIdForCookie(cookie: string): Promise<string> {
  const res = await get('/v1/me', { cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id?: unknown };
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

async function bootstrapVerifiedAdmin(
  email = 'admin@example.com',
): Promise<{ cookie: string; adminId: string }> {
  const bootstrapRes = await post('/v1/auth/admin/bootstrap', {
    name: 'Ada Admin',
    email,
    password: 'Correct-horse-41',
  });
  expect(bootstrapRes.status).toBe(201);
  await verifyEmailAddress(email);
  const loginRes = await post('/v1/auth/login', {
    email,
    password: 'Correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified administrator.');
  }
  return { cookie, adminId: await userIdForCookie(cookie) };
}

async function verifiedRegularCookie(
  email = 'ordinary@example.com',
): Promise<{ cookie: string; userId: string }> {
  await registerVerifiedUser('Ordinary User', email);
  const loginRes = await post('/v1/auth/login', {
    email,
    password: 'Correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified regular User.');
  }
  return { cookie, userId: await userIdForCookie(cookie) };
}

function capturedLogs(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
    logs.push(String(message));
  });
  return {
    logs,
    restore: () => {
      spy.mockRestore();
    },
  };
}

function loggedPaths(logs: readonly string[]): string[] {
  const paths: string[] = [];
  for (const entry of logs) {
    try {
      const record = JSON.parse(entry) as { path?: unknown };
      if (typeof record.path === 'string') {
        paths.push(record.path);
      }
    } catch {
      // Non-JSON console output is not request telemetry.
    }
  }
  return paths;
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
    db.prepare('DELETE FROM "admin_bootstrap_guard"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('GET /v1/admin/users/{userId}', () => {
  it('rejects anonymous requests with the existing unauthenticated problem', async () => {
    const res = await get('/v1/admin/users/some-opaque-id');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('returns the exact safe projection for an existing User', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('ordinary@example.com');

    const res = await get(`/v1/admin/users/${encodeURIComponent(userId)}`, { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'emailVerified', 'id', 'role']);
    expect(body).toEqual({
      id: userId,
      email: 'ordinary@example.com',
      emailVerified: true,
      role: 'user',
    });
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('session');
  });

  it('returns a distinct not-found problem for an authorized missing User', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();

    const res = await get('/v1/admin/users/does-not-exist-41', { cookie });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('rejects overlong identifiers through the public validation contract', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();

    const res = await get(`/v1/admin/users/${'a'.repeat(129)}`, { cookie });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'bad-request', status: 400 });
  });

  it('rejects a verified regular User before lookup even for a missing identifier', async () => {
    await bootstrapVerifiedAdmin();
    const { cookie } = await verifiedRegularCookie('ordinary@example.com');

    const res = await get('/v1/admin/users/does-not-exist-41', { cookie });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('rejects a revoked session as unauthenticated', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    const signOutRes = await postWithCookie('/v1/auth/sign-out', {}, cookie);
    expect(signOutRes.status).toBe(200);

    const res = await get(`/v1/admin/users/${encodeURIComponent(adminId)}`, { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects an expired session as unauthenticated', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    await workerEnv.DB.prepare('UPDATE "session" SET expires_at = 0').run();

    const res = await get(`/v1/admin/users/${encodeURIComponent(adminId)}`, { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('logs the matched route pattern without raw identifiers or personal data', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();
    const { userId, cookie: regularCookie } = await verifiedRegularCookie(
      'telemetry-subject@example.com',
    );
    const { logs, restore } = capturedLogs();
    try {
      const success = await get(`/v1/admin/users/${encodeURIComponent(userId)}`, { cookie });
      expect(success.status).toBe(200);
      await success.arrayBuffer();
      const missing = await get('/v1/admin/users/does-not-exist-41', { cookie });
      expect(missing.status).toBe(404);
      await missing.arrayBuffer();
      const denied = await get(`/v1/admin/users/${encodeURIComponent(userId)}`, {
        cookie: regularCookie,
      });
      expect(denied.status).toBe(403);
      await denied.arrayBuffer();
      const anonymous = await get(`/v1/admin/users/${encodeURIComponent(userId)}`);
      expect(anonymous.status).toBe(401);
      await anonymous.arrayBuffer();
      const invalid = await get(`/v1/admin/users/${'a'.repeat(129)}`, { cookie });
      expect(invalid.status).toBe(400);
      await invalid.arrayBuffer();
    } finally {
      restore();
    }

    const joined = logs.join('\n');
    expect(joined).not.toContain(userId);
    expect(joined).not.toContain('does-not-exist-41');
    expect(joined).not.toContain('telemetry-subject@example.com');
    expect(joined).not.toContain('a'.repeat(129));
    const paths = loggedPaths(logs);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths).toContain('/v1/admin/users/:userId');
    for (const path of paths) {
      expect(path).not.toContain(userId);
    }
  });

  it('keeps the matched route pattern on retryable infrastructure failure', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    await workerEnv.DB.prepare('ALTER TABLE "user" RENAME TO "user_detail_unavailable"').run();
    const { logs, restore } = capturedLogs();
    try {
      const res = await get(`/v1/admin/users/${encodeURIComponent(adminId)}`, { cookie });
      expect(res.status).toBe(500);
      await res.arrayBuffer();
    } finally {
      restore();
      await workerEnv.DB.prepare('ALTER TABLE "user_detail_unavailable" RENAME TO "user"').run();
    }

    const joined = logs.join('\n');
    expect(joined).not.toContain(adminId);
    const paths = loggedPaths(logs);
    expect(paths).toContain('/v1/admin/users/:userId');
  });
});
