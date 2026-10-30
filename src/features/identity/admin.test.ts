import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import type { AuthMailDeliveryResult, AuthMailer, VerificationMessage } from './mailer.js';
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
  const row = await workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "admin_user"').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

async function adminCount(): Promise<number> {
  const row = await workerEnv.DB.prepare(
    'SELECT COUNT(*) AS total FROM "admin_user" WHERE role = ?',
  )
    .bind('admin')
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function associationCounts(userId: string): Promise<{ accounts: number; sessions: number }> {
  const [accountRow, sessionRow] = await Promise.all([
    workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "admin_account" WHERE user_id = ?')
      .bind(userId)
      .first<{ total: number }>(),
    workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "admin_session" WHERE user_id = ?')
      .bind(userId)
      .first<{ total: number }>(),
  ]);
  return { accounts: accountRow?.total ?? 0, sessions: sessionRow?.total ?? 0 };
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
    return this.sendVerificationEmailWithResult(message).then(() => undefined);
  }

  sendVerificationEmailWithResult(message: VerificationMessage): Promise<AuthMailDeliveryResult> {
    if (this.shouldFail) {
      this.shouldFail = false;
      return Promise.resolve({ status: 'failed' });
    }
    this.sent.push(message);
    return Promise.resolve({ status: 'sent' });
  }

  sendPasswordResetEmail(): Promise<void> {
    return Promise.resolve();
  }
}

const ADMIN_BOOTSTRAP_PATH = '/v1/admin/auth/bootstrap';

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

describe('POST /v1/admin/auth/bootstrap', () => {
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

    const bootstrapState = await workerEnv.DB.prepare(
      'SELECT provisional_user_id, winner_user_id, verification_status FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{
      provisional_user_id: string | null;
      winner_user_id: string | null;
      verification_status: string | null;
    }>();
    expect(bootstrapState).toEqual({
      provisional_user_id: body.id,
      winner_user_id: body.id,
      verification_status: 'delivered',
    });

    const persistedTimestamps = await workerEnv.DB.prepare(
      'SELECT created_at, updated_at FROM "admin_user" WHERE id = ?',
    )
      .bind(body.id)
      .first<{ created_at: number; updated_at: number }>();
    expect(persistedTimestamps).not.toBeNull();
    expect(persistedTimestamps?.created_at).toBeLessThan(100_000_000_000);
    expect(persistedTimestamps?.updated_at).toBeGreaterThan(1_000_000_000);
    expect(persistedTimestamps?.updated_at).toBeLessThan(100_000_000_000);

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

  it('keeps the verification gate, then admits the Administrator only in its own realm', async () => {
    const bootstrap = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(bootstrap.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);

    const gated = await post('/v1/admin/auth/login', {
      email: 'admin@example.com',
      password: 'Correct-horse-41',
    });
    expect(gated.status).toBe(403);
    expect(await gated.json()).toMatchObject({
      code: 'email-verification-required',
      status: 403,
    });

    const verifyRes = await post('/v1/admin/auth/verify-email', { token: tokenFromLastMessage() });
    expect(verifyRes.status).toBe(200);

    // The bootstrapped credential was hashed by the auth engine: only the
    // operator-supplied password establishes a session.
    const wrongPassword = await post('/v1/admin/auth/login', {
      email: 'admin@example.com',
      password: 'wrong-password-99',
    });
    expect(wrongPassword.status).toBe(401);

    const loginRes = await post('/v1/admin/auth/login', {
      email: 'admin@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();

    const meRes = await get('/v1/admin/me', { cookie });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      email: 'admin@example.com',
      emailVerified: true,
      realm: 'administrator',
    });
    expect((await get('/v1/me', { cookie })).status).toBe(401);
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

  it('fences a late create after a second attempt wins an expired lease', async () => {
    let currentNow = TEST_NOW;
    let firstCreate = true;
    let lateProvisionalId = '';
    let markFirstCreateStarted: () => void = () => undefined;
    let releaseFirstCreate: () => void = () => undefined;
    let setRoleCalls = 0;
    let deleteUserCalls = 0;
    const firstCreateStarted = new Promise<void>((resolve) => {
      markFirstCreateStarted = resolve;
    });
    const firstCreateMayFinish = new Promise<void>((resolve) => {
      releaseFirstCreate = resolve;
    });
    const slowApp = createApp({
      authMailer: mailer,
      now: () => currentNow,
      bootstrapLeaseTtlMs: 30,
      bootstrapSetRole: async (auth, userId, headers) => {
        setRoleCalls += 1;
        return auth.api.setRole({ body: { userId, role: 'admin' }, headers });
      },
      bootstrapDeleteUser: async (auth, password, headers) => {
        deleteUserCalls += 1;
        return auth.api.deleteUser({ body: { password }, headers });
      },
      bootstrapCreateUser: async (auth, body) => {
        if (firstCreate) {
          firstCreate = false;
          const created = await auth.api.createUser({ body });
          const createdUser =
            (created as { user?: { id?: string }; id?: string }).user ??
            (created as { id?: string });
          lateProvisionalId = createdUser.id ?? '';
          markFirstCreateStarted();
          await firstCreateMayFinish;
          return created;
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

    const firstAttempt = request({ ...adminInput, email: 'late-admin@example.com' });
    await firstCreateStarted;
    currentNow += 31;
    const secondAttempt = await request({
      name: 'Grace Admin',
      email: 'grace-admin@example.com',
      password: 'Another-horse-42',
    });

    expect(secondAttempt.status).toBe(201);
    expect(await adminCount()).toBe(1);
    const winner = (await secondAttempt.clone().json()) as { id: string };
    releaseFirstCreate();
    const firstResponse = await firstAttempt;
    expect(firstResponse.status).toBe(409);
    expect(await firstResponse.json()).toMatchObject({
      code: 'admin-already-bootstrapped',
      status: 409,
    });
    expect(await adminCount()).toBe(1);
    expect(await userCount()).toBe(1);
    expect(setRoleCalls).toBe(1);
    expect(deleteUserCalls).toBe(1);
    const guard = await workerEnv.DB.prepare(
      'SELECT winner_user_id, completed_at FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ winner_user_id: string | null; completed_at: number | null }>();
    expect(guard).toEqual({ winner_user_id: winner.id, completed_at: TEST_NOW + 31 });
    const lateUser = await workerEnv.DB.prepare('SELECT id FROM "admin_user" WHERE email = ?')
      .bind('late-admin@example.com')
      .first();
    expect(lateUser).toBeNull();
    expect(await associationCounts(winner.id)).toEqual({ accounts: 1, sessions: 0 });
    expect(lateProvisionalId).not.toBe('');
    expect(lateProvisionalId).not.toBe(winner.id);
    expect(await associationCounts(lateProvisionalId)).toEqual({ accounts: 0, sessions: 0 });
  });

  it('recovers the exact provisional persisted before a crash in createUser', async () => {
    let interruptAfterFirstCreate = true;
    const crashableApp = createApp({
      authMailer: mailer,
      now: () => TEST_NOW,
      bootstrapCreateUser: async (auth, body) => {
        if (interruptAfterFirstCreate) {
          interruptAfterFirstCreate = false;
          await auth.api.createUser({ body });
          throw new Error('simulated crash after Better Auth persisted the provisional user');
        }
        return auth.api.createUser({ body });
      },
    });
    const request = async (): Promise<Response> =>
      await crashableApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(adminInput),
        },
        testEnv(),
      );

    const interrupted = await request();
    expect(interrupted.status).toBe(500);
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(0);

    const recoverable = await workerEnv.DB.prepare(
      'SELECT provisional_user_id, winner_user_id, verification_status FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{
      provisional_user_id: string | null;
      winner_user_id: string | null;
      verification_status: string | null;
    }>();
    expect(typeof recoverable?.provisional_user_id).toBe('string');
    expect(recoverable).toMatchObject({ winner_user_id: null, verification_status: null });
    const provisionalId = recoverable?.provisional_user_id;
    expect(provisionalId).not.toBeNull();
    expect(await associationCounts(provisionalId ?? '')).toEqual({ accounts: 1, sessions: 0 });

    const recovered = await request();
    expect(recovered.status).toBe(201);
    expect(await recovered.json()).toMatchObject({ id: provisionalId, role: 'admin' });
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
    expect(await associationCounts(provisionalId ?? '')).toEqual({ accounts: 1, sessions: 0 });
    expect(mailer.sent).toHaveLength(1);

    const completed = await workerEnv.DB.prepare(
      'SELECT provisional_user_id, winner_user_id, verification_status FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{
      provisional_user_id: string | null;
      winner_user_id: string | null;
      verification_status: string | null;
    }>();
    expect(completed).toMatchObject({
      provisional_user_id: provisionalId,
      winner_user_id: provisionalId,
      verification_status: 'delivered',
    });
    const winningAttempt = await workerEnv.DB.prepare(
      'SELECT state FROM admin_bootstrap_attempt WHERE user_id = ?',
    )
      .bind(provisionalId)
      .first<{ state: string }>();
    expect(winningAttempt?.state).toBe('winner');
    const abandonedAttempt = await workerEnv.DB.prepare(
      'SELECT user_id, state FROM admin_bootstrap_attempt WHERE state = ?',
    )
      .bind('abandoned')
      .first<{ user_id: string; state: string }>();
    expect(abandonedAttempt?.state).toBe('abandoned');
    expect(abandonedAttempt?.user_id).not.toBe(provisionalId);
  });

  it('cleans a crash-orphan through Better Auth after a different winner completes', async () => {
    let interruptFirstCreate = true;
    const crashableApp = createApp({
      authMailer: mailer,
      now: () => TEST_NOW,
      bootstrapCreateUser: async (auth, body) => {
        if (body.email === 'orphan-admin@example.com' && interruptFirstCreate) {
          interruptFirstCreate = false;
          await auth.api.createUser({ body });
          throw new Error('simulated process crash after provisional persistence');
        }
        return auth.api.createUser({ body });
      },
    });
    const request = async (body: typeof adminInput): Promise<Response> =>
      await crashableApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
        testEnv(),
      );

    const orphaned = await request({ ...adminInput, email: 'orphan-admin@example.com' });
    expect(orphaned.status).toBe(500);
    const orphan = await workerEnv.DB.prepare(
      'SELECT provisional_user_id FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ provisional_user_id: string | null }>();
    expect(orphan?.provisional_user_id).toBeTruthy();
    const orphanId = orphan?.provisional_user_id ?? '';
    expect(await associationCounts(orphanId)).toEqual({ accounts: 1, sessions: 0 });

    const winnerResponse = await request({
      name: 'Grace Admin',
      email: 'grace-admin@example.com',
      password: 'Another-horse-42',
    });
    expect(winnerResponse.status).toBe(201);
    const winner = (await winnerResponse.json()) as { id: string };
    expect(winner.id).not.toBe(orphanId);
    expect(await adminCount()).toBe(1);

    const retryOrphanOwner = await request({ ...adminInput, email: 'orphan-admin@example.com' });
    expect(retryOrphanOwner.status).toBe(409);
    expect(await adminCount()).toBe(1);
    expect(await userCount()).toBe(1);
    const deletedOrphan = await workerEnv.DB.prepare('SELECT id FROM "admin_user" WHERE id = ?')
      .bind(orphanId)
      .first();
    expect(deletedOrphan).toBeNull();
    expect(await associationCounts(orphanId)).toEqual({ accounts: 0, sessions: 0 });
    expect(await associationCounts(winner.id)).toEqual({ accounts: 1, sessions: 0 });
  });

  it('recovers a durably claimed winner after setRole fails', async () => {
    let failFirstSetRole = true;
    const recoverableApp = createApp({
      authMailer: mailer,
      now: () => TEST_NOW,
      bootstrapSetRole: async (auth, userId, headers) => {
        if (failFirstSetRole) {
          failFirstSetRole = false;
          throw new Error('simulated setRole interruption');
        }
        return auth.api.setRole({ body: { userId, role: 'admin' }, headers });
      },
    });
    const request = async (): Promise<Response> =>
      await recoverableApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(adminInput),
        },
        testEnv(),
      );

    const interrupted = await request();
    expect(interrupted.status).toBe(500);
    expect(await adminCount()).toBe(0);
    expect(await userCount()).toBe(1);

    const guard = await workerEnv.DB.prepare(
      'SELECT winner_user_id, completed_at FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ winner_user_id: string | null; completed_at: number | null }>();
    expect(guard?.winner_user_id).toEqual(expect.any(String));
    expect(guard?.completed_at).toBeNull();

    const recovered = await request();
    expect(recovered.status).toBe(201);
    expect(await recovered.json()).toMatchObject({ id: guard?.winner_user_id, role: 'admin' });
    expect(await adminCount()).toBe(1);
    expect(await userCount()).toBe(1);

    const completedGuard = await workerEnv.DB.prepare(
      'SELECT winner_user_id, completed_at FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ winner_user_id: string | null; completed_at: number | null }>();
    expect(completedGuard?.winner_user_id).toBe(guard?.winner_user_id);
    expect(completedGuard?.completed_at).toBe(TEST_NOW);
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

    const retry = await request('/v1/admin/auth/request-verification', { email: adminInput.email });
    expect(retry.status).toBe(202);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(flakyMailer.sent).toHaveLength(1);
  });

  it('retries bootstrap verification after a completed creation whose mailer failed', async () => {
    const flakyMailer = new FailOnceAuthMailer();
    const retryableApp = createApp({ authMailer: flakyMailer, now: () => TEST_NOW });
    const request = async (): Promise<Response> =>
      await retryableApp.request(
        ADMIN_BOOTSTRAP_PATH,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(adminInput),
        },
        testEnv(),
      );

    const created = await request();
    expect(created.status).toBe(201);
    expect(await adminCount()).toBe(1);
    expect(flakyMailer.sent).toHaveLength(0);
    const pending = await workerEnv.DB.prepare(
      'SELECT completed_at, verification_status FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ completed_at: number | null; verification_status: string | null }>();
    expect(pending?.completed_at).toEqual(expect.any(Number));
    expect(pending?.verification_status).toBe('pending');

    const alreadyBootstrapped = await request();
    expect(alreadyBootstrapped.status).toBe(409);
    expect(await alreadyBootstrapped.json()).toMatchObject({
      code: 'admin-already-bootstrapped',
      status: 409,
    });
    expect(flakyMailer.sent).toHaveLength(1);
    const delivered = await workerEnv.DB.prepare(
      'SELECT verification_status FROM admin_bootstrap_guard WHERE id = 1',
    ).first<{ verification_status: string | null }>();
    expect(delivered?.verification_status).toBe('delivered');
  });

  it('allows the same email in Reader and Administrator realms', async () => {
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
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect(await userCount()).toBe(1);
    expect(await adminCount()).toBe(1);
    const readerUser = await workerEnv.DB.prepare('SELECT id FROM "user" WHERE email = ?')
      .bind('ordinary@example.com')
      .first<{ id: string }>();
    const adminUser = await workerEnv.DB.prepare('SELECT id FROM "admin_user" WHERE email = ?')
      .bind('ordinary@example.com')
      .first<{ id: string }>();
    expect(readerUser).not.toBeNull();
    expect(adminUser).not.toBeNull();
    expect(readerUser?.id).not.toBe(adminUser?.id);
    expect(mailer.sent).toHaveLength(2);
  });

  it('releases the reservation after an email conflict within the Administrator realm', async () => {
    await workerEnv.DB.prepare(
      'INSERT INTO "admin_user" (id, name, email, email_verified, created_at, updated_at, role, banned) VALUES (?, ?, ?, 0, ?, ?, ?, 0)',
    )
      .bind(
        'existing-admin-realm-user',
        'Existing Admin Realm User',
        'admin-conflict@example.com',
        Date.now(),
        Date.now(),
        'user',
      )
      .run();
    const conflict = await post(ADMIN_BOOTSTRAP_PATH, {
      ...adminInput,
      email: 'admin-conflict@example.com',
    });
    expect(conflict.status).toBe(409);
    expect(await adminCount()).toBe(0);

    await workerEnv.DB.prepare('DELETE FROM "admin_user" WHERE id = ?')
      .bind('existing-admin-realm-user')
      .run();
    const retry = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(retry.status).toBe(201);
    await waitForVerificationMessages(1);
    expect(await adminCount()).toBe(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('closes the guard when an administrator predates the reservation migration', async () => {
    const first = await post(ADMIN_BOOTSTRAP_PATH, adminInput);
    expect(first.status).toBe(201);
    await waitForVerificationMessages(1);
    await workerEnv.DB.prepare('DELETE FROM admin_bootstrap_guard').run();
    await workerEnv.DB.prepare('DELETE FROM admin_bootstrap_attempt').run();
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
    expect(await userCount()).toBe(1);
    const readerCount = await workerEnv.DB.prepare('SELECT COUNT(*) AS total FROM "user"').first<{
      total: number;
    }>();
    expect(readerCount?.total).toBe(1);
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
      expect(res.headers.get('cache-control')).toBe('private, no-store');
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
      await workerEnv.DB.prepare('DELETE FROM "admin_user"').run();
      await workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_guard"').run();
      await workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_attempt"').run();
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
