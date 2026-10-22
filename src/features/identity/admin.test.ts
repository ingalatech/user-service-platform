import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #59, ADR-0011): the public HTTP boundary of the
// built Worker, executed inside the Cloudflare Workers runtime with the
// isolated test D1 database. These tests prove the explicit first-admin
// bootstrap creates an administrative User through Better Auth APIs — never
// migration seeds or direct persistence inserts — and that repeats/conflicts
// fail safely without duplicating privileged accounts.
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

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

async function userCount(): Promise<number> {
  const row = await workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "user"').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

async function adminCount(): Promise<number> {
  const row = await workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "user" WHERE role = ?')
    .bind('admin')
    .first<{ total: number }>();
  return row?.total ?? 0;
}

function tokenFromLastMessage(): string {
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

const ADMIN_BOOTSTRAP_PATH = '/v1/auth/admin/bootstrap';

const adminInput = {
  name: 'Ada Admin',
  email: 'admin@example.com',
  password: 'correct-horse-41',
};

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

describe('POST /v1/auth/admin/bootstrap', () => {
  it('creates the first administrator with the admin role through Better Auth APIs', async () => {
    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as {
      id: string;
      email: string;
      role: string;
      emailVerified: boolean;
    };
    expect(typeof body.id).toBe('string');
    expect(body.email).toBe('admin@example.com');
    expect(body.role).toBe('admin');
    expect(body.emailVerified).toBe(false);

    // Exactly one User exists and it carries the administrative role: no
    // duplicate privileged accounts, no seeded identities.
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);

    // Bootstrap itself schedules no mail and leaks no credential material.
    expect(mailer.sent).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain('correct-horse-41');
  });

  it('keeps the verification gate for the bootstrapped admin, then admits them after verification', async () => {
    await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    const gated = await post('/v1/auth/login', {
      email: 'admin@example.com',
      password: 'correct-horse-41',
    });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({
      code: 'email-verification-required',
      status: 403,
    });

    await post('/v1/auth/request-verification', { email: 'admin@example.com' });
    const verifyRes = await post('/v1/auth/verify-email', { token: tokenFromLastMessage() });
    expect(verifyRes.status).toBe(200);

    // The bootstrapped credential was hashed by the auth engine: only the
    // operator-supplied password establishes a session.
    const wrongPassword = await post('/v1/auth/login', {
      email: 'admin@example.com',
      password: 'wrong-password-99',
    });
    expect(wrongPassword.status).toBe(401);

    const loginRes = await post('/v1/auth/login', {
      email: 'admin@example.com',
      password: 'correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();

    const meRes = await get('/v1/me', { cookie });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      email: 'admin@example.com',
      emailVerified: true,
    });
  });

  it('rejects a repeated bootstrap without duplicating privileged accounts', async () => {
    const first = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(first.status).toBe(201);

    const second = await post(ADMIN_BOOTSTRAP_PATH, {
      name: 'Second Admin',
      email: 'second-admin@example.com',
      password: 'another-horse-42',
    });

    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/problem+json');
    expect(await second.json()).toMatchObject({
      code: 'admin-already-bootstrapped',
      status: 409,
    });

    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
  });

  it('rejects bootstrap for an already-registered email without duplicating identities', async () => {
    const registerRes = await post('/v1/auth/register', {
      name: 'Ordinary User',
      email: 'ordinary@example.com',
      password: 'correct-horse-41',
    });
    expect(registerRes.status).toBe(201);

    const res = await post(ADMIN_BOOTSTRAP_PATH, {
      name: 'Claimant',
      email: 'ordinary@example.com',
      password: 'another-horse-42',
    });

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'admin-email-conflict', status: 409 });

    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(0);
  });

  it('does not treat ordinary users as bootstrapped', async () => {
    await post('/v1/auth/register', {
      name: 'Ordinary User',
      email: 'ordinary@example.com',
      password: 'correct-horse-41',
    });

    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ email: 'admin@example.com', role: 'admin' });
    expect(await userCount()).toBe(2);
    expect(await adminCount()).toBe(1);
  });

  it('rejects invalid bootstrap input through the public contract', async () => {
    const res = await post(ADMIN_BOOTSTRAP_PATH, {
      name: '',
      email: 'not-an-email',
      password: 'short',
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'bad-request', status: 400 });
    expect(await userCount()).toBe(0);
  });

  it('rejects bootstrap with a stable error when email/password is disabled', async () => {
    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput, {
      AUTH_EMAIL_PASSWORD_ENABLED: 'false',
    });

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'email-password-disabled', status: 403 });
    expect(await userCount()).toBe(0);
  });

  it('never logs bootstrap credentials or privileged material', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    try {
      await post(ADMIN_BOOTSTRAP_PATH, adminInput);
      await post(ADMIN_BOOTSTRAP_PATH, {
        name: 'Second Admin',
        email: 'second-admin@example.com',
        password: 'another-horse-42',
      });
      await post(ADMIN_BOOTSTRAP_PATH, {
        name: '',
        email: 'not-an-email',
        password: 'short',
      });
    } finally {
      spy.mockRestore();
    }

    const transcript = seen.join('\n');
    expect(transcript).not.toContain('correct-horse-41');
    expect(transcript).not.toContain('another-horse-42');
    expect(transcript).not.toContain('admin@example.com');
    expect(transcript).not.toContain('second-admin@example.com');
  });
});
