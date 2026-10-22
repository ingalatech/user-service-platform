import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #125, ADR-0011): the public HTTP boundary of the
// built Worker, executed inside the Cloudflare Workers runtime with the
// isolated test D1 database. These tests prove the application-owned
// `GET /v1/admin/users` listing boundary: verified administrators read real
// User rows with bounded server pagination and literal case-insensitive email
// search, while anonymous/regular/revoked sessions are rejected before any
// list read. Only status codes, stable problem codes and the exact public
// representation are observed.
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
    password: 'correct-horse-41',
  });
  expect(registerRes.status).toBe(201);
  await verifyEmailAddress(email);
}

async function bootstrapVerifiedAdmin(email = 'admin@example.com'): Promise<{ cookie: string }> {
  const bootstrapRes = await post('/v1/auth/admin/bootstrap', {
    name: 'Ada Admin',
    email,
    password: 'correct-horse-41',
  });
  expect(bootstrapRes.status).toBe(201);
  await verifyEmailAddress(email);
  const loginRes = await post('/v1/auth/login', {
    email,
    password: 'correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified administrator.');
  }
  return { cookie };
}

async function verifiedRegularCookie(email = 'ordinary@example.com'): Promise<string> {
  await registerVerifiedUser('Ordinary User', email);
  const loginRes = await post('/v1/auth/login', {
    email,
    password: 'correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified regular User.');
  }
  return cookie;
}

async function seedRoster(): Promise<{ cookie: string }> {
  const { cookie } = await bootstrapVerifiedAdmin();
  await registerVerifiedUser('Beta User', 'beta@example.com');
  await registerVerifiedUser('Alpha User', 'alpha@example.com');
  await registerVerifiedUser('Gamma User', 'gamma@example.com');
  return { cookie };
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

describe('GET /v1/admin/users', () => {
  it('rejects anonymous requests with the existing unauthenticated problem', async () => {
    const res = await get('/v1/admin/users');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'urn:problem:unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'unauthenticated',
      instance: '/v1/admin/users',
    });
  });

  it('returns real User rows with the exact administrative representation', async () => {
    const { cookie } = await seedRoster();

    const res = await get('/v1/admin/users', { cookie });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(Object.keys(body).sort()).toEqual(['items', 'total']);
    expect(body.total).toBe(4);
    expect(body.items).toHaveLength(4);
    for (const item of body.items) {
      expect(Object.keys(item).sort()).toEqual(['email', 'emailVerified', 'id', 'role']);
    }
    expect(body.items.map((item) => item.email)).toEqual([
      'admin@example.com',
      'alpha@example.com',
      'beta@example.com',
      'gamma@example.com',
    ]);
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('session');
  });

  it('rejects a verified regular User with an explicit forbidden problem', async () => {
    await seedRoster();
    const cookie = await verifiedRegularCookie('ordinary@example.com');

    const res = await get('/v1/admin/users', { cookie });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('rejects a revoked session as unauthenticated', async () => {
    const { cookie } = await seedRoster();
    const signOutRes = await postWithCookie('/v1/auth/sign-out', {}, cookie);
    expect(signOutRes.status).toBe(200);

    const res = await get('/v1/admin/users', { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects an expired session as unauthenticated', async () => {
    const { cookie } = await seedRoster();
    await workerEnv.DB.prepare('UPDATE "session" SET expires_at = 0').run();

    const res = await get('/v1/admin/users', { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('paginates with bounded limit/offset and reports the pre-pagination total', async () => {
    const { cookie } = await seedRoster();

    const first = await get('/v1/admin/users?limit=2&offset=0', { cookie });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as {
      items: { email: string }[];
      total: number;
    };
    expect(firstBody.total).toBe(4);
    expect(firstBody.items.map((item) => item.email)).toEqual([
      'admin@example.com',
      'alpha@example.com',
    ]);

    const second = await get('/v1/admin/users?limit=2&offset=2', { cookie });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      items: { email: string }[];
      total: number;
    };
    expect(secondBody.total).toBe(4);
    expect(secondBody.items.map((item) => item.email)).toEqual([
      'beta@example.com',
      'gamma@example.com',
    ]);
  });

  it('rejects invalid pagination and search bounds through the public contract', async () => {
    const { cookie } = await seedRoster();

    for (const path of [
      '/v1/admin/users?limit=0',
      '/v1/admin/users?limit=101',
      '/v1/admin/users?offset=-1',
      '/v1/admin/users?limit=abc',
      `/v1/admin/users?email=${encodeURIComponent('   ')}`,
      `/v1/admin/users?email=${encodeURIComponent('a'.repeat(255))}`,
    ]) {
      const res = await get(path, { cookie });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: 'bad-request', status: 400 });
    }
  });

  it('searches case-insensitively by literal email substring with deterministic order', async () => {
    const { cookie } = await seedRoster();

    const res = await get(`/v1/admin/users?email=${encodeURIComponent('ALPHA')}`, { cookie });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: { email: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.items.map((item) => item.email)).toEqual(['alpha@example.com']);
  });

  it('treats percent and underscore as literal search characters', async () => {
    const { cookie } = await seedRoster();
    await registerVerifiedUser('Underscore User', 'under_score@example.com');

    // A bare `%` is a wildcard in LIKE syntax; as a literal substring no
    // stored address contains it, so only a literal implementation returns
    // zero rows instead of the whole table.
    const percent = await get(`/v1/admin/users?email=${encodeURIComponent('%')}`, { cookie });
    expect(percent.status).toBe(200);
    const percentBody = (await percent.json()) as {
      items: { email: string }[];
      total: number;
    };
    expect(percentBody).toEqual({ items: [], total: 0 });

    // A bare `_` matches any single character as a LIKE wildcard; literally
    // only the stored underscore address contains it.
    const underscore = await get(`/v1/admin/users?email=${encodeURIComponent('_')}`, {
      cookie,
    });
    expect(underscore.status).toBe(200);
    const underscoreBody = (await underscore.json()) as {
      items: { email: string }[];
      total: number;
    };
    expect(underscoreBody.total).toBe(1);
    expect(underscoreBody.items.map((item) => item.email)).toEqual(['under_score@example.com']);
  });

  it('returns an empty page with the matching total for searches without matches', async () => {
    const { cookie } = await seedRoster();

    const res = await get(`/v1/admin/users?email=${encodeURIComponent('no-such-user')}`, {
      cookie,
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ items: [], total: 0 });
  });
});
