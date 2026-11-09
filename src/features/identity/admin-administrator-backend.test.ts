import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import type { D1Database } from '@cloudflare/workers-types';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { setAdminAdministratorAccess } from './admin-administrators.js';
import { createIdentityRuntime } from './identity-runtime.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];
let rejectNextSchedulingClaim = false;

function testEnv(): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
}

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
const executionContext = {
  waitUntil: () => {
    if (rejectNextSchedulingClaim) {
      rejectNextSchedulingClaim = false;
      throw new Error('scheduler unavailable');
    }
  },
  passThroughOnException: () => undefined,
  props: {},
};

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv(),
    executionContext,
  );
}

async function putWithCookie(
  path: string,
  body: unknown,
  cookie: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    testEnv(),
    executionContext,
  );
}

async function postWithCookie(
  path: string,
  body: unknown,
  cookie: string | undefined,
  headers: Record<string, string> = {},
  targetApp = app,
): Promise<Response> {
  return targetApp.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
        ...headers,
      },
      body: JSON.stringify(body),
    },
    testEnv(),
    executionContext,
  );
}

async function getWithCookie(path: string, cookie: string): Promise<Response> {
  return app.request(path, { headers: { cookie } }, testEnv(), executionContext);
}

function sessionCookieFrom(response: Response): string {
  const pair = response.headers.get('set-cookie')?.split(';')[0]?.trim();
  if (pair === undefined || pair.length === 0) throw new Error('Expected an Administrator cookie.');
  return pair;
}

function verificationToken(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected a verification message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  return token;
}

async function bootstrapAdministrator(): Promise<{ cookie: string; id: string }> {
  const bootstrap = await post('/v1/admin/auth/bootstrap', {
    name: 'Morgan Admin',
    email: 'morgan@example.com',
    password: 'Correct-horse-41',
  });
  expect(bootstrap.status).toBe(201);
  const result = (await bootstrap.json()) as { id: string };
  expect(
    (await post('/v1/admin/auth/request-verification', { email: 'morgan@example.com' })).status,
  ).toBe(202);
  expect((await post('/v1/admin/auth/verify-email', { token: verificationToken() })).status).toBe(
    200,
  );
  const login = await post('/v1/admin/auth/login', {
    email: 'morgan@example.com',
    password: 'Correct-horse-41',
  });
  expect(login.status).toBe(200);
  return { cookie: sessionCookieFrom(login), id: result.id };
}

async function seedAdministrator(input: {
  id: string;
  email: string;
  verified: boolean;
  password: string | null;
  state?: 'active' | 'disabled';
  banned?: boolean;
  banExpires?: number | null;
}): Promise<void> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  const statements = [
    workerEnv.DB.prepare(
      `INSERT INTO admin_user
       (id, name, email, email_verified, created_at, updated_at, role, banned, ban_expires)
       VALUES (?, ?, ?, ?, ?, ?, 'admin', ?, ?)`,
    ).bind(
      input.id,
      input.email,
      input.email,
      input.verified ? 1 : 0,
      nowSeconds,
      nowSeconds,
      input.banned === true ? 1 : 0,
      input.banExpires ?? null,
    ),
  ];
  if (input.password !== null) {
    statements.push(
      workerEnv.DB.prepare(
        `INSERT INTO admin_account
         (id, account_id, provider_id, user_id, password, created_at, updated_at)
         VALUES (?, ?, 'credential', ?, ?, ?, ?)`,
      ).bind(`account-${input.id}`, input.id, input.id, input.password, nowSeconds, nowSeconds),
    );
  }
  if (input.state !== undefined) {
    statements.push(
      workerEnv.DB.prepare(
        `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
         VALUES (?, ?, 4, ?)`,
      ).bind(input.id, input.state, now),
    );
  }
  await workerEnv.DB.batch(statements);
}

async function createAdministrator(input: { email: string; name: string }): Promise<{
  cookie: string;
  id: string;
}> {
  const runtime = createIdentityRuntime({
    env: testEnv(),
    requestUrl: 'http://localhost/v1/admin/administrators',
    executionContext,
    authMailer: mailer,
  });
  const created = await runtime.administration().api.createUser({
    body: {
      email: input.email,
      name: input.name,
      password: 'Correct-horse-42',
      role: 'admin',
    },
  });
  const createdId = (created as { user?: { id?: unknown } }).user?.id;
  if (typeof createdId !== 'string') throw new Error('Expected an Administrator id.');
  expect((await post('/v1/admin/auth/request-verification', { email: input.email })).status).toBe(
    202,
  );
  expect((await post('/v1/admin/auth/verify-email', { token: verificationToken() })).status).toBe(
    200,
  );
  const login = await post('/v1/admin/auth/login', {
    email: input.email,
    password: 'Correct-horse-42',
  });
  expect(login.status).toBe(200);
  return { cookie: sessionCookieFrom(login), id: createdId };
}

async function emptyBodyHash(): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('{}'));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM identity_event'),
    db.prepare('DELETE FROM admin_idempotency_record'),
    db.prepare('DELETE FROM administrator_message_workflow'),
    db.prepare('DELETE FROM administrator_access_state'),
    db.prepare('DELETE FROM admin_session'),
    db.prepare('DELETE FROM admin_account'),
    db.prepare('DELETE FROM admin_verification'),
    db.prepare('DELETE FROM admin_email_verification_token'),
    db.prepare('DELETE FROM admin_user'),
    db.prepare('DELETE FROM admin_bootstrap_attempt'),
    db.prepare('DELETE FROM admin_bootstrap_guard'),
  ]);
  mailer.clear();
});

describe('Administrator access command audit and preconditions', () => {
  it('distinguishes absent and malformed If-Match and audits authenticated failures', async () => {
    const actor = await bootstrapAdministrator();
    const path = `/v1/admin/administrators/${actor.id}/access`;

    const missing = await putWithCookie(path, { state: 'active' }, actor.cookie);
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: 'precondition-required' });

    const malformed = await putWithCookie(path, { state: 'active' }, actor.cookie, {
      'if-match': 'W/"1"',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'bad-request' });

    const stale = await putWithCookie(path, { state: 'active' }, actor.cookie, {
      'if-match': '"8"',
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision' });

    const events = await workerEnv.DB.prepare(
      `SELECT result, problem_code FROM identity_event
       WHERE type = 'access-attempt' ORDER BY occurred_at, id`,
    ).all<{ result: string; problem_code: string | null }>();
    expect(events.results).toEqual([
      { result: 'failure', problem_code: 'precondition-required' },
      { result: 'failure', problem_code: 'bad-request' },
      { result: 'failure', problem_code: 'stale-revision' },
    ]);
  });

  it('audits a no-op access command and returns 500 when that audit cannot be persisted', async () => {
    const actor = await bootstrapAdministrator();
    const path = `/v1/admin/administrators/${actor.id}/access`;

    const noOp = await putWithCookie(path, { state: 'active' }, actor.cookie, {
      'if-match': '"1"',
    });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toEqual({ state: 'active', changed: false, revision: 1 });
    const event = await workerEnv.DB.prepare(
      `SELECT result, problem_code, metadata FROM identity_event WHERE type = 'access-attempt'`,
    ).first<{ result: string; problem_code: string | null; metadata: string | null }>();
    expect(event).toEqual({
      result: 'success',
      problem_code: null,
      metadata: '{"changed":false}',
    });

    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_access_attempt_audit BEFORE INSERT ON identity_event
       WHEN NEW.type = 'access-attempt'
       BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`,
    ).run();
    try {
      const auditFailure = await putWithCookie(path, { state: 'active' }, actor.cookie, {
        'if-match': '"1"',
      });
      expect(auditFailure.status).toBe(500);
      expect(await auditFailure.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_access_attempt_audit').run();
    }
  });

  it('counts only verified Administrators with an enabled usable credential in the atomic last-admin guard', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'operational-target',
      email: 'operational@example.com',
      verified: true,
      password: 'credential-hash',
    });
    await seedAdministrator({
      id: 'unverified-admin',
      email: 'unverified@example.com',
      verified: false,
      password: 'credential-hash',
    });
    await seedAdministrator({
      id: 'credentialless-admin',
      email: 'credentialless@example.com',
      verified: true,
      password: null,
    });
    await seedAdministrator({
      id: 'banned-admin',
      email: 'banned@example.com',
      verified: true,
      password: 'credential-hash',
      banned: true,
      banExpires: Math.floor(Date.now() / 1_000) + 60,
    });
    await workerEnv.DB.batch([
      workerEnv.DB.prepare('UPDATE admin_user SET email_verified = 0 WHERE id = ?').bind(actor.id),
      workerEnv.DB.prepare('UPDATE admin_account SET password = NULL WHERE user_id = ?').bind(
        actor.id,
      ),
    ]);

    const response = await putWithCookie(
      '/v1/admin/administrators/operational-target/access',
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'last-operational-administrator' });
    await workerEnv.DB.prepare('UPDATE admin_user SET ban_expires = ? WHERE id = ?')
      .bind(Math.floor(Date.now() / 1_000) - 60, 'banned-admin')
      .run();
    const afterBanExpiry = await putWithCookie(
      '/v1/admin/administrators/operational-target/access',
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );
    expect(afterBanExpiry.status).toBe(200);
    expect(await afterBanExpiry.json()).toEqual({
      state: 'disabled',
      changed: true,
      revision: 2,
    });
    const state = await workerEnv.DB.prepare(
      'SELECT state, revision FROM administrator_access_state WHERE user_id = ?',
    )
      .bind('operational-target')
      .first<{ state: string; revision: number }>();
    expect(state).toEqual({ state: 'disabled', revision: 2 });
  });

  it('does not record a successful access attempt when its CAS loses after a winner commits', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      email: 'cas-target@example.com',
      name: 'CAS Target',
    });
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state
       (user_id, state, revision, mutation_token, updated_at)
       VALUES (?, 'active', 1, NULL, ?)`,
    )
      .bind(target.id, Date.now())
      .run();

    let intercepted = false;
    const racingDatabase = new Proxy(workerEnv.DB, {
      get(database, property) {
        if (property === 'batch') {
          return async (statements: Parameters<D1Database['batch']>[0]) => {
            if (!intercepted) {
              intercepted = true;
              await workerEnv.DB.prepare(
                `UPDATE administrator_access_state
                 SET state = 'disabled', revision = 2, mutation_token = 'winning-token'
                 WHERE user_id = ? AND revision = 1`,
              )
                .bind(target.id)
                .run();
            }
            return workerEnv.DB.batch(statements);
          };
        }
        if (property === 'prepare') return database.prepare.bind(database);
        return undefined;
      },
    });
    const runtime = createIdentityRuntime({
      env: testEnv(),
      requestUrl: 'http://localhost/v1/admin/administrators',
      executionContext,
      authMailer: mailer,
    });

    const loser = await setAdminAdministratorAccess({
      auth: runtime.administration(),
      db: racingDatabase,
      actorId: actor.id,
      administratorId: target.id,
      headers: new Headers({ cookie: actor.cookie }),
      ifMatch: '"1"',
      request: { state: 'disabled' },
      requestId: 'cas-loser-request',
      emailPasswordEnabled: true,
    });

    expect(loser.kind).toBe('stale-revision');
    expect(intercepted).toBe(true);
    const attempts = await workerEnv.DB.prepare(
      `SELECT result, problem_code FROM identity_event
       WHERE type = 'access-attempt' AND subject_id = ? ORDER BY occurred_at, id`,
    )
      .bind(target.id)
      .all<{ result: string; problem_code: string | null }>();
    expect(attempts.results).toEqual([{ result: 'failure', problem_code: 'stale-revision' }]);
  });
});

describe('Administrator verification and recovery message commands', () => {
  it('terminally marks accepted dispatch when normal response persistence fails', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'accepted-marker-target',
      email: 'accepted-marker@example.com',
      verified: false,
      password: 'credential-hash',
    });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_admin_message_202
       BEFORE UPDATE OF response_status ON admin_idempotency_record
       WHEN NEW.response_status = 202
       BEGIN SELECT RAISE(FAIL, 'normal marker unavailable'); END`,
    ).run();
    try {
      const path = '/v1/admin/administrators/accepted-marker-target/email-verification/messages';
      const first = await postWithCookie(path, {}, actor.cookie, {
        'idempotency-key': 'accepted-marker-key',
      });
      expect(first.status).toBe(202);
      const responseBody = await first.json();
      expect(responseBody).toMatchObject({
        kind: 'email-verification',
        state: 'scheduled',
      });
      expect(
        mailer.sent.filter((message) => message.to === 'accepted-marker@example.com'),
      ).toHaveLength(1);

      const persisted = await workerEnv.DB.prepare(
        `SELECT workflow.state, idem.response_status, idem.retry_payload
         FROM administrator_message_workflow AS workflow
         JOIN admin_idempotency_record AS idem ON idem.target_id = workflow.user_id
         WHERE workflow.user_id = 'accepted-marker-target'
           AND workflow.kind = 'email-verification'`,
      ).first<{ state: string; response_status: number; retry_payload: string | null }>();
      expect(persisted).toEqual({ state: 'scheduled', response_status: 103, retry_payload: null });

      const replay = await postWithCookie(path, {}, actor.cookie, {
        'idempotency-key': 'accepted-marker-key',
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(responseBody);
      expect(
        mailer.sent.filter((message) => message.to === 'accepted-marker@example.com'),
      ).toHaveLength(1);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_admin_message_202').run();
    }
  });

  it('uses the scheduled workflow fence if the terminal idempotency marker also fails', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'fallback-failure-target',
      email: 'fallback-failure@example.com',
      verified: false,
      password: 'credential-hash',
    });
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `CREATE TRIGGER reject_admin_message_202
         BEFORE UPDATE OF response_status ON admin_idempotency_record
         WHEN NEW.response_status = 202
         BEGIN SELECT RAISE(FAIL, 'normal marker unavailable'); END`,
      ),
      workerEnv.DB.prepare(
        `CREATE TRIGGER reject_admin_message_103
         BEFORE UPDATE OF response_status ON admin_idempotency_record
         WHEN NEW.response_status = 103
         BEGIN SELECT RAISE(FAIL, 'terminal marker unavailable'); END`,
      ),
    ]);
    try {
      const path = '/v1/admin/administrators/fallback-failure-target/email-verification/messages';
      const first = await postWithCookie(path, {}, actor.cookie, {
        'idempotency-key': 'fallback-failure-key',
      });
      expect(first.status).toBe(202);
      const responseBody = await first.json();
      const workflow = await workerEnv.DB.prepare(
        `SELECT state, claim_token FROM administrator_message_workflow
         WHERE user_id = 'fallback-failure-target' AND kind = 'email-verification'`,
      ).first<{ state: string; claim_token: string | null }>();
      expect(workflow).toEqual({ state: 'scheduled', claim_token: null });

      const replay = await postWithCookie(path, {}, actor.cookie, {
        'idempotency-key': 'fallback-failure-key',
      });
      expect(replay.status).toBe(202);
      expect(await replay.json()).toEqual(responseBody);
      expect(
        mailer.sent.filter((message) => message.to === 'fallback-failure@example.com'),
      ).toHaveLength(1);
    } finally {
      await workerEnv.DB.batch([
        workerEnv.DB.prepare('DROP TRIGGER reject_admin_message_103'),
        workerEnv.DB.prepare('DROP TRIGGER reject_admin_message_202'),
      ]);
    }
  });

  it('finalizes runtime scheduling throws as retryable 503 and retries with the same sealed payload', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'runtime-throw-target',
      email: 'runtime-throw@example.com',
      verified: false,
      password: 'credential-hash',
    });
    const throwingApp = createApp({
      authMailer: mailer,
      administratorMessageScheduler: () =>
        Promise.reject(new Error('runtime resolution unavailable')),
    });
    const path = '/v1/admin/administrators/runtime-throw-target/email-verification/messages';
    const failed = await postWithCookie(
      path,
      {},
      actor.cookie,
      { 'idempotency-key': 'runtime-throw-key' },
      throwingApp,
    );
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'delivery-scheduling-failed' });
    const persisted = await workerEnv.DB.prepare(
      `SELECT workflow.state, idem.response_status, idem.retry_payload
       FROM administrator_message_workflow AS workflow
       JOIN admin_idempotency_record AS idem ON idem.target_id = workflow.user_id
       WHERE workflow.user_id = 'runtime-throw-target'
         AND workflow.kind = 'email-verification'`,
    ).first<{ state: string; response_status: number; retry_payload: string | null }>();
    expect(persisted?.state).toBe('scheduling-failed');
    expect(persisted?.response_status).toBe(503);
    expect(persisted?.retry_payload).not.toBeNull();

    const retried = await postWithCookie(path, {}, actor.cookie, {
      'idempotency-key': 'runtime-throw-key',
    });
    expect(retried.status).toBe(202);
    expect(
      mailer.sent.filter((message) => message.to === 'runtime-throw@example.com'),
    ).toHaveLength(1);
  });

  it('rejects anonymous and Reader callers and checks a disabled actor before target lookup', async () => {
    const actor = await bootstrapAdministrator();
    const readerEmail = 'reader-credential-actor@example.com';
    const registration = await post('/v2/auth/register', {
      email: readerEmail,
      password: 'Correct-horse-41',
    });
    expect(registration.status).toBe(201);
    const verification = mailer.sent.find((message) => message.to === readerEmail);
    expect(verification).toBeDefined();
    if (verification === undefined) throw new Error('Expected Reader verification message.');
    expect(
      (
        await post('/v1/auth/verify-email', {
          token: new URL(verification.url).searchParams.get('token'),
        })
      ).status,
    ).toBe(200);
    const readerLogin = await post('/v1/auth/login', {
      email: readerEmail,
      password: 'Correct-horse-41',
    });
    const readerCookie = sessionCookieFrom(readerLogin);
    const route = '/v1/admin/administrators/not-found/email-verification/messages';

    const anonymous = await postWithCookie(route, {}, undefined, { 'idempotency-key': 'anon-key' });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });
    const reader = await app.request(
      route,
      {
        method: 'POST',
        headers: {
          cookie: readerCookie,
          'content-type': 'application/json',
          'idempotency-key': 'reader-key',
        },
        body: '{}',
      },
      testEnv(),
    );
    expect(reader.status).toBe(403);
    expect(await reader.json()).toMatchObject({ code: 'forbidden' });

    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)`,
    )
      .bind(actor.id, Date.now())
      .run();
    const disabledActor = await postWithCookie(route, {}, actor.cookie, {
      'idempotency-key': 'disabled-actor-key',
    });
    expect(disabledActor.status).toBe(403);
    expect(await disabledActor.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('returns a verified-state no-op without sending verification mail', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'verified-target',
      email: 'verified-target@example.com',
      verified: true,
      password: 'credential-hash',
    });
    const sentBefore = mailer.sent.filter(
      (message) => message.to === 'verified-target@example.com',
    );

    const response = await postWithCookie(
      '/v1/admin/administrators/verified-target/email-verification/messages',
      {},
      actor.cookie,
      { 'idempotency-key': 'verified-target-noop' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const noOpBody = {
      kind: 'email-verification',
      state: 'verified',
      changed: false,
      revision: 1,
    };
    expect(await response.json()).toEqual(noOpBody);
    const detail = await getWithCookie('/v1/admin/administrators/verified-target', actor.cookie);
    expect(await detail.json()).toMatchObject({
      emailVerified: true,
      messageWorkflows: { emailVerification: null, passwordRecovery: null },
    });
    expect(mailer.sent.filter((message) => message.to === 'verified-target@example.com')).toEqual(
      sentBefore,
    );
    const events = await workerEnv.DB.prepare(
      `SELECT type, result, metadata FROM identity_event WHERE subject_id='verified-target'`,
    ).all<{ type: string; result: string; metadata: string | null }>();
    expect(events.results).toEqual([
      expect.objectContaining({
        type: 'email-verification-attempt',
        result: 'success',
        metadata: JSON.stringify({ changed: false }),
      }),
    ]);
    const replay = await postWithCookie(
      '/v1/admin/administrators/verified-target/email-verification/messages',
      {},
      actor.cookie,
      { 'idempotency-key': 'verified-target-noop' },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(noOpBody);
  });

  it('rejects a reused idempotency key with a different stored payload hash', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'conflict-target',
      email: 'conflict-target@example.com',
      verified: false,
      password: 'credential-hash',
    });
    const path = '/v1/admin/administrators/conflict-target/email-verification/messages';
    const normalizedPath = '/v1/admin/administrators/:administratorId/email-verification/messages';
    const differentBodyHash = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode('{"different":true}'),
    );
    const hash = Array.from(new Uint8Array(differentBodyHash), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const now = Date.now();
    await workerEnv.DB.prepare(
      `INSERT INTO admin_idempotency_record
       (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
        response_body, created_at, expires_at)
       VALUES ('conflict-idempotency', ?, 'conflict-key', 'POST', ?, 'conflict-target', ?, 202,
               '{}', ?, ?)`,
    )
      .bind(actor.id, normalizedPath, hash, now, now + 86_400_000)
      .run();

    const response = await postWithCookie(path, {}, actor.cookie, {
      'idempotency-key': 'conflict-key',
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'idempotency-key-reused' });
    expect(mailer.sent.some((message) => message.to === 'conflict-target@example.com')).toBe(false);
  });

  it('allows only one scheduling claim for concurrent requests with the same key', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'concurrent-message-target',
      email: 'concurrent-message@example.com',
      verified: false,
      password: 'credential-hash',
    });
    const path = '/v1/admin/administrators/concurrent-message-target/email-verification/messages';
    const headers = { 'idempotency-key': 'concurrent-message-key' };

    const responses = await Promise.all([
      postWithCookie(path, {}, actor.cookie, headers),
      postWithCookie(path, {}, actor.cookie, headers),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual(
      expect.arrayContaining([202]),
    );
    expect(responses.every((response) => response.status === 202 || response.status === 503)).toBe(
      true,
    );
    expect(
      mailer.sent.filter((message) => message.to === 'concurrent-message@example.com'),
    ).toHaveLength(1);
    const rows = await workerEnv.DB.prepare(
      `SELECT count(*) AS workflows FROM administrator_message_workflow
       WHERE user_id='concurrent-message-target' AND kind='email-verification'`,
    ).first<{ workflows: number }>();
    expect(rows?.workflows).toBe(1);
  });

  it('schedules against a disabled Administrator without changing access or exposing message secrets', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'disabled-target',
      email: 'disabled@example.com',
      verified: false,
      password: 'credential-hash',
      state: 'disabled',
    });
    const verificationPath = '/v1/admin/administrators/disabled-target/email-verification/messages';
    const recoveryPath = '/v1/admin/administrators/disabled-target/password-recovery/messages';

    const verification = await postWithCookie(verificationPath, {}, actor.cookie, {
      'idempotency-key': 'admin-verification-1',
    });
    expect(verification.status).toBe(202);
    expect(verification.headers.get('cache-control')).toBe('private, no-store');
    const verificationBody = (await verification.json()) as Record<string, unknown>;
    expect(verificationBody).toMatchObject({ kind: 'email-verification', state: 'scheduled' });
    const detailAfterAccepted = await getWithCookie(
      '/v1/admin/administrators/disabled-target',
      actor.cookie,
    );
    expect(detailAfterAccepted.headers.get('cache-control')).toBe('private, no-store');
    expect(await detailAfterAccepted.json()).toMatchObject({
      access: { state: 'disabled' },
      messageWorkflows: {
        emailVerification: { state: 'scheduled', kind: 'email-verification' },
      },
    });
    const recovery = await postWithCookie(recoveryPath, {}, actor.cookie, {
      'idempotency-key': 'admin-recovery-1',
    });
    expect(recovery.status).toBe(202);
    const recoveryBody = (await recovery.json()) as Record<string, unknown>;
    expect(Object.keys(recoveryBody)).not.toContain('token');
    expect(Object.keys(recoveryBody)).not.toContain('actionUrl');
    expect(Object.keys(recoveryBody)).not.toContain('password');
    expect(Object.keys(recoveryBody)).not.toContain('url');
    expect(JSON.stringify(recoveryBody)).not.toContain('disabled@example.com');

    const replay = await postWithCookie(verificationPath, {}, actor.cookie, {
      'idempotency-key': 'admin-verification-1',
    });
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual(verificationBody);
    const cooldown = await postWithCookie(verificationPath, {}, actor.cookie, {
      'idempotency-key': 'admin-verification-2',
    });
    expect(cooldown.status).toBe(429);
    expect(cooldown.headers.get('retry-after')).not.toBeNull();
    const detailAfterCooldown = await getWithCookie(
      '/v1/admin/administrators/disabled-target',
      actor.cookie,
    );
    const cooldownDetail = (await detailAfterCooldown.json()) as {
      messageWorkflows: {
        emailVerification: { state: string; cooldownUntil: string } | null;
      };
    };
    expect(cooldownDetail.messageWorkflows.emailVerification?.state).toBe('scheduled');
    expect(typeof cooldownDetail.messageWorkflows.emailVerification?.cooldownUntil).toBe('string');

    const state = await workerEnv.DB.prepare(
      'SELECT state, revision FROM administrator_access_state WHERE user_id = ?',
    )
      .bind('disabled-target')
      .first<{ state: string; revision: number }>();
    expect(state).toEqual({ state: 'disabled', revision: 4 });
    const events = await workerEnv.DB.prepare(
      `SELECT type, result, subject_realm FROM identity_event
       WHERE subject_id = 'disabled-target' ORDER BY occurred_at, id`,
    ).all<{ type: string; result: string; subject_realm: string }>();
    expect(
      events.results.map((event) => [event.type, event.result, event.subject_realm]),
    ).toContainEqual(['email-verification-requested', 'success', 'administrator']);
    expect(mailer.sent.some((message) => message.to === 'disabled@example.com')).toBe(true);
    expect(mailer.passwordResets.some((message) => message.to === 'disabled@example.com')).toBe(
      true,
    );
  });

  it('completes disabled-Administrator verification and recovery without restoring access or sessions', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Disabled Completion Target',
      email: 'disabled-completion@example.com',
    });
    const disabled = await putWithCookie(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );
    expect(disabled.status).toBe(200);
    const revokedSessions = await workerEnv.DB.prepare(
      'SELECT count(*) AS total FROM admin_session WHERE user_id=?',
    )
      .bind(target.id)
      .first<{ total: number }>();
    expect(revokedSessions).toEqual({ total: 0 });
    await workerEnv.DB.prepare('UPDATE admin_user SET email_verified=0 WHERE id=?')
      .bind(target.id)
      .run();
    const verificationPath = `/v1/admin/administrators/${target.id}/email-verification/messages`;
    const recoveryPath = `/v1/admin/administrators/${target.id}/password-recovery/messages`;

    const verification = await postWithCookie(verificationPath, {}, actor.cookie, {
      'idempotency-key': 'disabled-completion-verification',
    });
    expect(verification.status).toBe(202);
    const verificationMessage = mailer.sent
      .filter((message) => message.to === 'disabled-completion@example.com')
      .at(-1);
    expect(verificationMessage).toBeDefined();
    if (verificationMessage === undefined) throw new Error('Expected verification delivery.');
    const verified = await post('/v1/admin/auth/verify-email', {
      token: new URL(verificationMessage.url).searchParams.get('token'),
    });
    expect(verified.status).toBe(200);

    const recovery = await postWithCookie(recoveryPath, {}, actor.cookie, {
      'idempotency-key': 'disabled-completion-recovery',
    });
    expect(recovery.status).toBe(202);
    const recoveryMessage = mailer.passwordResets.find(
      (message) => message.to === 'disabled-completion@example.com',
    );
    expect(recoveryMessage).toBeDefined();
    if (recoveryMessage === undefined) throw new Error('Expected recovery delivery.');
    const reset = await post('/v1/admin/auth/reset-password', {
      token: new URL(recoveryMessage.url).searchParams.get('token'),
      newPassword: 'New-correct-horse-52',
    });
    expect(reset.status).toBe(200);

    const access = await workerEnv.DB.prepare(
      'SELECT state FROM administrator_access_state WHERE user_id=?',
    )
      .bind(target.id)
      .first<{ state: string }>();
    expect(access).toEqual({ state: 'disabled' });
    const sessions = await workerEnv.DB.prepare(
      'SELECT count(*) AS total FROM admin_session WHERE user_id=?',
    )
      .bind(target.id)
      .first<{ total: number }>();
    expect(sessions).toEqual({ total: 0 });
    const login = await post('/v1/admin/auth/login', {
      email: 'disabled-completion@example.com',
      password: 'New-correct-horse-52',
    });
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('rejects recovery without a usable credential and requires an idempotency key', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'credentialless-target',
      email: 'credentialless@example.com',
      verified: true,
      password: null,
      state: 'disabled',
    });
    const recoveryPath =
      '/v1/admin/administrators/credentialless-target/password-recovery/messages';

    const missingKey = await postWithCookie(recoveryPath, {}, actor.cookie);
    expect(missingKey.status).toBe(428);
    expect(await missingKey.json()).toMatchObject({ code: 'precondition-required' });
    const noCredential = await postWithCookie(recoveryPath, {}, actor.cookie, {
      'idempotency-key': 'credentialless-recovery',
    });
    expect(noCredential.status).toBe(409);
    expect(await noCredential.json()).toMatchObject({ code: 'no-usable-login-method' });
  });

  it('persists scheduling failure, retries the sealed same message, and does not duplicate delivery', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'schedule-retry-target',
      email: 'schedule-retry@example.com',
      verified: false,
      password: 'credential-hash',
    });
    const retryMailer = new InMemoryAuthMailer();
    const retryApp = createApp({ authMailer: retryMailer });
    const path = '/v1/admin/administrators/schedule-retry-target/email-verification/messages';
    const headers = { 'idempotency-key': 'schedule-retry-key' };

    rejectNextSchedulingClaim = true;
    const failed = await postWithCookie(path, {}, actor.cookie, headers, retryApp);
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'delivery-scheduling-failed' });
    expect(retryMailer.sent).toHaveLength(0);
    const persisted = await workerEnv.DB.prepare(
      `SELECT workflow.state, idem.response_status, idem.retry_payload
       FROM administrator_message_workflow AS workflow
       JOIN admin_idempotency_record AS idem ON idem.target_id=workflow.user_id
       WHERE workflow.user_id='schedule-retry-target' AND workflow.kind='email-verification'`,
    ).first<{ state: string; response_status: number; retry_payload: string | null }>();
    expect(persisted?.state).toBe('scheduling-failed');
    expect(persisted?.response_status).toBe(503);
    expect(persisted?.retry_payload).not.toBeNull();
    const detailAfterFailure = await getWithCookie(
      '/v1/admin/administrators/schedule-retry-target',
      actor.cookie,
    );
    expect(await detailAfterFailure.json()).toMatchObject({
      messageWorkflows: {
        emailVerification: {
          kind: 'email-verification',
          state: 'scheduling-failed',
          lastScheduledAt: null,
        },
      },
    });

    const retried = await postWithCookie(path, {}, actor.cookie, headers, retryApp);
    expect(retried.status).toBe(202);
    expect(await retried.json()).toMatchObject({ kind: 'email-verification', state: 'scheduled' });
    expect(retryMailer.sent).toHaveLength(1);
    const detailAfterRetry = await getWithCookie(
      '/v1/admin/administrators/schedule-retry-target',
      actor.cookie,
    );
    const retryDetail = (await detailAfterRetry.json()) as {
      messageWorkflows: {
        emailVerification: { kind: string; state: string; lastScheduledAt: string | null } | null;
      };
    };
    expect(retryDetail.messageWorkflows.emailVerification).toMatchObject({
      kind: 'email-verification',
      state: 'scheduled',
    });
    expect(typeof retryDetail.messageWorkflows.emailVerification?.lastScheduledAt).toBe('string');
    const completed = await workerEnv.DB.prepare(
      `SELECT workflow.state, idem.response_status, idem.retry_payload
       FROM administrator_message_workflow AS workflow
       JOIN admin_idempotency_record AS idem ON idem.target_id=workflow.user_id
       WHERE workflow.user_id='schedule-retry-target' AND workflow.kind='email-verification'`,
    ).first<{ state: string; response_status: number; retry_payload: string | null }>();
    expect(completed).toEqual({ state: 'scheduled', response_status: 202, retry_payload: null });
    const replay = await postWithCookie(path, {}, actor.cookie, headers, retryApp);
    expect(replay.status).toBe(202);
    expect(retryMailer.sent).toHaveLength(1);
  });

  it('rolls back workflow and idempotency when the successful ledger event cannot be written', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'audit-failure-target',
      email: 'audit-failure@example.com',
      verified: false,
      password: 'credential-hash',
    });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_admin_message_ledger
       BEFORE INSERT ON identity_event WHEN NEW.subject_id='audit-failure-target'
       BEGIN SELECT RAISE(FAIL, 'ledger unavailable'); END`,
    ).run();
    try {
      const response = await postWithCookie(
        '/v1/admin/administrators/audit-failure-target/email-verification/messages',
        {},
        actor.cookie,
        { 'idempotency-key': 'audit-failure-key' },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'internal-error' });
      const counts = await workerEnv.DB.prepare(
        `SELECT
           (SELECT count(*) FROM administrator_message_workflow WHERE user_id='audit-failure-target') AS workflows,
           (SELECT count(*) FROM admin_idempotency_record WHERE target_id='audit-failure-target') AS idempotency`,
      ).first<{ workflows: number; idempotency: number }>();
      expect(counts).toEqual({ workflows: 0, idempotency: 0 });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_admin_message_ledger').run();
    }
  });

  it('returns retryable status for a live 102 claim and recovers it after its lease expires', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'lease-target',
      email: 'lease-target@example.com',
      verified: false,
      password: 'credential-hash',
      state: 'disabled',
    });
    const now = Date.now();
    const key = 'lease-recovery-key';
    const bodyHash = await emptyBodyHash();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO administrator_message_workflow
         (id, user_id, kind, state, cooldown_until, created_at, updated_at, claim_token, claimed_at)
         VALUES ('persisted-lease-workflow', 'lease-target', 'email-verification', 'pending', ?, ?, ?, 'fresh-claim', ?)`,
      ).bind(now + 60_000, now - 1_000, now, now),
      workerEnv.DB.prepare(
        `INSERT INTO admin_idempotency_record
         (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
          response_body, created_at, expires_at)
         VALUES ('lease-idempotency', ?, ?, 'POST', ?, 'lease-target', ?, 102, '{}', ?, ?)`,
      ).bind(
        actor.id,
        key,
        '/v1/admin/administrators/:administratorId/email-verification/messages',
        bodyHash,
        now,
        now + 86_400_000,
      ),
    ]);
    const path = '/v1/admin/administrators/lease-target/email-verification/messages';

    const liveClaim = await postWithCookie(path, {}, actor.cookie, { 'idempotency-key': key });
    expect(liveClaim.status).toBe(503);
    expect(await liveClaim.json()).toMatchObject({ code: 'delivery-scheduling-failed' });

    const staleAt = Date.now() - 120_000;
    await workerEnv.DB.prepare(
      `UPDATE administrator_message_workflow
       SET claimed_at = ?, updated_at = ? WHERE id = 'persisted-lease-workflow'`,
    )
      .bind(staleAt, staleAt)
      .run();
    const recovered = await postWithCookie(path, {}, actor.cookie, { 'idempotency-key': key });

    expect(recovered.status).toBe(202);
    expect(await recovered.json()).toMatchObject({
      workflowId: 'persisted-lease-workflow',
      kind: 'email-verification',
      state: 'scheduled',
    });
  });

  it('replaces an expired idempotency record and binds the response to the persisted workflow ID', async () => {
    const actor = await bootstrapAdministrator();
    await seedAdministrator({
      id: 'race-workflow-target',
      email: 'race-workflow@example.com',
      verified: false,
      password: 'credential-hash',
    });
    const now = Date.now();
    const key = 'expired-claim-key';
    const bodyHash = await emptyBodyHash();
    await workerEnv.DB.prepare(
      `INSERT INTO admin_idempotency_record
       (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
        response_body, created_at, expires_at)
       VALUES ('expired-record', ?, ?, 'POST', ?, 'race-workflow-target', ?, 202, '{}', ?, ?)`,
    )
      .bind(
        actor.id,
        key,
        '/v1/admin/administrators/:administratorId/email-verification/messages',
        bodyHash,
        now - 86_400_000,
        now - 1,
      )
      .run();
    await workerEnv.DB.prepare(
      `CREATE TRIGGER race_seed_administrator_message_workflow
       BEFORE INSERT ON administrator_message_workflow
       WHEN NEW.user_id = 'race-workflow-target' AND NEW.id <> 'persisted-race-workflow'
         AND NOT EXISTS (
           SELECT 1 FROM administrator_message_workflow
           WHERE user_id = NEW.user_id AND kind = NEW.kind
         )
       BEGIN
         INSERT INTO administrator_message_workflow
         (id, user_id, kind, state, cooldown_until, created_at, updated_at, claim_token, claimed_at)
         VALUES ('persisted-race-workflow', NEW.user_id, NEW.kind, 'scheduling-failed',
                 NEW.created_at - 1, NEW.created_at - 1, NEW.created_at - 1, 'prior-claim', NEW.created_at - 60000);
       END`,
    ).run();

    try {
      const response = await postWithCookie(
        '/v1/admin/administrators/race-workflow-target/email-verification/messages',
        {},
        actor.cookie,
        { 'idempotency-key': key },
      );

      expect(response.status).toBe(202);
      const body = (await response.json()) as { workflowId: string };
      expect(body.workflowId).toBe('persisted-race-workflow');
      const workflow = await workerEnv.DB.prepare(
        `SELECT id, state FROM administrator_message_workflow WHERE user_id = 'race-workflow-target'`,
      ).first<{ id: string; state: string }>();
      expect(workflow).toEqual({ id: 'persisted-race-workflow', state: 'scheduled' });
      const idempotency = await workerEnv.DB.prepare(
        `SELECT id, response_status, response_body, created_at, expires_at
         FROM admin_idempotency_record WHERE actor_id = ? AND key = ?`,
      )
        .bind(actor.id, key)
        .first<{
          id: string;
          response_status: number;
          response_body: string;
          created_at: number;
          expires_at: number;
        }>();
      expect(idempotency?.id).not.toBe('expired-record');
      expect(idempotency?.response_status).toBe(202);
      expect(idempotency?.created_at).toBeGreaterThan(now);
      expect(idempotency?.expires_at).toBeGreaterThan(Date.now());
      expect(JSON.parse(idempotency?.response_body ?? '{}')).toMatchObject({
        workflowId: 'persisted-race-workflow',
      });
      const requestedEvents = await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM identity_event
         WHERE type = 'email-verification-requested' AND subject_id = 'race-workflow-target'`,
      ).first<{ count: number }>();
      expect(requestedEvents?.count).toBe(1);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER race_seed_administrator_message_workflow').run();
    }
  });
});
