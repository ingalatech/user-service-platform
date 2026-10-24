import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import type { AuthMailer, VerificationMessage } from './mailer.js';
import { InMemoryAuthMailer } from './mailer.js';
import {
  PASSWORD_POLICY_BOUNDARY_PASSWORDS,
  PASSWORD_POLICY_VIOLATIONS,
  TEST_PASSWORD_POLICY,
} from './password-policy.test-data.js';

// Seam under test (ticket #59, ADR-0011): the public HTTP boundary of the
// built Worker, executed inside the Cloudflare Workers runtime with the
// isolated test D1 database. These tests prove the explicit first-admin
// bootstrap creates an administrative User through Better Auth APIs — never
// migration seeds or direct persistence inserts — and that repeats/conflicts
// fail safely without duplicating privileged accounts.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];
const TEST_NOW = 1_800_000_000_000;

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
const app = createApp({ authMailer: mailer, now: () => TEST_NOW });

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

async function waitForVerificationMessages(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mailer.sent.length).toBeGreaterThanOrEqual(count);
}

class FailOnceAuthMailer implements AuthMailer {
  readonly sent: VerificationMessage[] = [];
  private shouldFail = true;

  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return Promise.reject(new Error('simulated delivery failure'));
    }
    this.sent.push(message);
    return Promise.resolve();
  }

  sendPasswordResetEmail(): Promise<void> {
    return Promise.resolve();
  }
}

const ADMIN_BOOTSTRAP_PATH = '/v1/auth/admin/bootstrap';

const adminInput = {
  name: 'Ada Admin',
  email: 'admin@example.com',
  password: 'Correct-horse-41',
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
    db.prepare('DELETE FROM "admin_bootstrap_guard"'),
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

    // One bootstrap command creates the admin and schedules exactly one
    // verification message, without leaking credential material.
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain('Correct-horse-41');
  });

  it('keeps the verification gate for the bootstrapped admin, then admits them after verification', async () => {
    const bootstrap = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(bootstrap.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);

    const gated = await post('/v1/auth/login', {
      email: 'admin@example.com',
      password: 'Correct-horse-41',
    });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({
      code: 'email-verification-required',
      status: 403,
    });

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
      password: 'Correct-horse-41',
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

  it('serializes concurrent first-admin bootstraps with one durable winner', async () => {
    const responses = await Promise.all([
      post(ADMIN_BOOTSTRAP_PATH, adminInput),
      post(ADMIN_BOOTSTRAP_PATH, {
        name: 'Grace Admin',
        email: 'grace-admin@example.com',
        password: 'Another-horse-42',
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);
    expect(await adminCount()).toBe(1);
    expect(await userCount()).toBe(1);
  });

  it('lets a concurrent loser acquire after the winner fails and releases', async () => {
    let firstCreate = true;
    const concurrentApp = createApp({
      authMailer: mailer,
      now: () => TEST_NOW,
      bootstrapCreateUser: async (auth, body) => {
        if (firstCreate) {
          firstCreate = false;
          await new Promise((resolve) => setTimeout(resolve, 40));
          throw new Error('simulated create failure');
        }
        return auth.api.createUser({ body });
      },
    });

    const responses = await Promise.all([
      concurrentApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(adminInput),
        },
        testEnv(),
      ),
      concurrentApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            name: 'Grace Admin',
            email: 'grace-admin@example.com',
            password: 'Another-horse-42',
          }),
        },
        testEnv(),
      ),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 500]);
    await waitForVerificationMessages(1);
    expect(await adminCount()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('takes over an expired orphan lease', async () => {
    await workerEnv.DB.prepare(
      'INSERT INTO admin_bootstrap_guard (id, owner_nonce, expires_at, completed_at) VALUES (?, ?, ?, NULL)',
    )
      .bind(1, 'orphan-owner', TEST_NOW - 1)
      .run();

    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    expect(res.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(await adminCount()).toBe(1);
    const guard = await workerEnv.DB.prepare(
      'SELECT completed_at FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ completed_at: number | null }>();
    expect(guard?.completed_at).toBe(TEST_NOW);
  });

  it('does not take over an active lease and reports bounded in-progress conflict', async () => {
    await workerEnv.DB.prepare(
      'INSERT INTO admin_bootstrap_guard (id, owner_nonce, expires_at, completed_at) VALUES (?, ?, ?, NULL)',
    )
      .bind(1, 'active-owner', TEST_NOW + 60_000)
      .run();

    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'admin-bootstrap-in-progress',
      status: 409,
    });
    expect(await adminCount()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('renews a lease while a slow creation is in progress', async () => {
    let currentNow = TEST_NOW;
    let firstCreate = true;
    let markFirstCreateStarted: () => void = () => undefined;
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const slowApp = createApp({
      authMailer: mailer,
      now: () => currentNow,
      bootstrapLeaseTtlMs: 30,
      bootstrapCreateUser: async (auth, body) => {
        if (firstCreate) {
          firstCreate = false;
          markFirstCreateStarted();
          await new Promise((resolve) => setTimeout(resolve, 1_000));
          return auth.api.createUser({ body });
        }
        return auth.api.createUser({ body });
      },
    });
    const request = async (body: typeof adminInput): Promise<Response> =>
      await slowApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        testEnv(),
      );

    const winner = request(adminInput);
    await firstCreateStarted;
    await new Promise((resolve) => setTimeout(resolve, 70));
    currentNow += 31;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const loser = await request({
      name: 'Grace Admin',
      email: 'grace-admin@example.com',
      password: 'Another-horse-42',
    });

    expect(loser.status).toBe(409);
    expect(await loser.json()).toMatchObject({
      code: 'admin-bootstrap-in-progress',
      status: 409,
    });
    expect((await winner).status).toBe(201);
    expect(await adminCount()).toBe(1);
  });

  it('keeps a completed guard permanent even when no User row remains', async () => {
    await workerEnv.DB.prepare(
      'INSERT INTO admin_bootstrap_guard (id, owner_nonce, expires_at, completed_at) VALUES (?, ?, ?, ?)',
    )
      .bind(1, 'completed-owner', TEST_NOW, TEST_NOW)
      .run();

    const res = await post(ADMIN_BOOTSTRAP_PATH, adminInput);

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: 'admin-already-bootstrapped',
      status: 409,
    });
    expect(await userCount()).toBe(0);
    expect(mailer.sent).toHaveLength(0);
  });

  it('rejects a repeated bootstrap without duplicating privileged accounts', async () => {
    const first = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(first.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);

    const second = await post(ADMIN_BOOTSTRAP_PATH, {
      name: 'Second Admin',
      email: 'second-admin@example.com',
      password: 'Another-horse-42',
    });

    expect(second.status).toBe(409);
    expect(second.headers.get('content-type')).toContain('application/problem+json');
    expect(await second.json()).toMatchObject({
      code: 'admin-already-bootstrapped',
      status: 409,
    });

    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('keeps the admin when delivery fails and permits request-verification retry', async () => {
    const flakyMailer = new FailOnceAuthMailer();
    const flakyApp = createApp({ authMailer: flakyMailer });
    const request = async (path: string, body: unknown): Promise<Response> =>
      flakyApp.request(
        path,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        testEnv(),
      );

    const bootstrap = await request(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(bootstrap.status).toBe(201);
    expect(await adminCount()).toBe(1);
    expect(flakyMailer.sent).toHaveLength(0);

    const retry = await request('/v1/auth/request-verification', { email: adminInput.email });
    expect(retry.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flakyMailer.sent).toHaveLength(1);
  });

  it('rejects bootstrap for an already-registered email without duplicating identities', async () => {
    const registerRes = await post('/v1/auth/register', {
      name: 'Ordinary User',
      email: 'ordinary@example.com',
      password: 'Correct-horse-41',
    });
    expect(registerRes.status).toBe(201);
    await waitForVerificationMessages(1);

    const res = await post(ADMIN_BOOTSTRAP_PATH, {
      name: 'Claimant',
      email: 'ordinary@example.com',
      password: 'Another-horse-42',
    });

    expect(res.status).toBe(409);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'admin-email-conflict', status: 409 });

    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(0);
    expect(mailer.sent).toHaveLength(1);
  });

  it('releases the reservation after a creation conflict so a later bootstrap can retry', async () => {
    const registerRes = await post('/v1/auth/register', {
      name: 'Ordinary User',
      email: 'ordinary@example.com',
      password: 'Correct-horse-41',
    });
    expect(registerRes.status).toBe(201);
    await waitForVerificationMessages(1);

    const conflict = await post(ADMIN_BOOTSTRAP_PATH, {
      ...adminInput,
      email: 'ordinary@example.com',
    });
    expect(conflict.status).toBe(409);
    expect(await adminCount()).toBe(0);

    const retry = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(retry.status).toBe(201);
    await waitForVerificationMessages(2);
    expect(await adminCount()).toBe(1);
    expect(mailer.sent).toHaveLength(2);
  });

  it('closes the guard when an administrator predates the reservation migration', async () => {
    const first = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(first.status).toBe(201);
    await waitForVerificationMessages(1);
    await workerEnv.DB.prepare('DELETE FROM admin_bootstrap_guard').run();
    mailer.clear();

    const repeated = await post(ADMIN_BOOTSTRAP_PATH, {
      ...adminInput,
      email: 'second-admin@example.com',
    });
    expect(repeated.status).toBe(409);
    const guard = await workerEnv.DB.prepare(
      'SELECT completed_at FROM admin_bootstrap_guard',
    ).first<{ completed_at: number | null }>();
    expect(guard?.completed_at).toEqual(expect.any(Number));
    expect(mailer.sent).toHaveLength(0);
  });

  it('does not treat ordinary users as bootstrapped', async () => {
    await post('/v1/auth/register', {
      name: 'Ordinary User',
      email: 'ordinary@example.com',
      password: 'Correct-horse-41',
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
    expect(mailer.sent).toHaveLength(0);
  });

  it('enforces every configured password rule and both length boundaries', async () => {
    const policyEnv = {
      AUTH_PASSWORD_MIN_LENGTH: String(TEST_PASSWORD_POLICY.minLength),
      AUTH_PASSWORD_MAX_LENGTH: String(TEST_PASSWORD_POLICY.maxLength),
      AUTH_PASSWORD_MIN_UPPERCASE: String(TEST_PASSWORD_POLICY.minUppercase),
      AUTH_PASSWORD_MIN_LOWERCASE: String(TEST_PASSWORD_POLICY.minLowercase),
      AUTH_PASSWORD_MIN_DIGITS: String(TEST_PASSWORD_POLICY.minDigits),
      AUTH_PASSWORD_MIN_SYMBOLS: String(TEST_PASSWORD_POLICY.minSymbols),
    };

    for (const [index, violation] of PASSWORD_POLICY_VIOLATIONS.entries()) {
      const res = await post(
        ADMIN_BOOTSTRAP_PATH,
        {
          name: `Policy Admin ${String(index)}`,
          email: `policy-admin-${String(index)}@example.com`,
          password: violation.password,
        },
        policyEnv,
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        code: 'password-policy-violation',
        failedRules: [violation.rule],
        passwordPolicy: TEST_PASSWORD_POLICY,
      });
    }

    for (const [index, password] of PASSWORD_POLICY_BOUNDARY_PASSWORDS.entries()) {
      const res = await post(
        ADMIN_BOOTSTRAP_PATH,
        {
          name: `Boundary Admin ${String(index)}`,
          email: `boundary-admin-${String(index)}@example.com`,
          password,
        },
        policyEnv,
      );
      expect(res.status).toBe(201);
      await workerEnv.DB.prepare('DELETE FROM "user"').run();
      await workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_guard"').run();
    }
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
        password: 'Another-horse-42',
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
    expect(transcript).not.toContain('Correct-horse-41');
    expect(transcript).not.toContain('Another-horse-42');
    expect(transcript).not.toContain('admin@example.com');
    expect(transcript).not.toContain('second-admin@example.com');
  });
});
