import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { createIdentityRuntime } from './identity-runtime.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (ticket #278): the public Worker HTTP boundary running with
// isolated D1 migrations. Assertions observe only the application-owned
// Administrator contract, never Better Auth or persistence representations.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

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

async function post(path: string, body: unknown): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv(),
  );
}

async function postWithCookie(
  path: string,
  body: unknown,
  cookie: string | undefined,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
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
  );
}

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(
    path,
    { method: 'GET', headers: cookie === undefined ? {} : { cookie } },
    testEnv(),
  );
}

async function put(
  path: string,
  body: unknown,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    path,
    {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie, ...headers },
      body: JSON.stringify(body),
    },
    testEnv(),
  );
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
    name: 'Ada Admin',
    email: 'ada@example.com',
    password: 'Correct-horse-41',
  });
  expect(bootstrap.status).toBe(201);
  const bootstrapBody = (await bootstrap.json()) as { id: string };
  expect(
    (await post('/v1/admin/auth/request-verification', { email: 'ada@example.com' })).status,
  ).toBe(202);
  expect((await post('/v1/admin/auth/verify-email', { token: verificationToken() })).status).toBe(
    200,
  );
  const login = await post('/v1/admin/auth/login', {
    email: 'ada@example.com',
    password: 'Correct-horse-41',
  });
  expect(login.status).toBe(200);
  return { cookie: sessionCookieFrom(login), id: bootstrapBody.id };
}

async function createAdministrator(input: {
  email: string;
  name: string;
}): Promise<{ cookie: string; id: string }> {
  const runtime = createIdentityRuntime({
    env: testEnv(),
    requestUrl: 'http://localhost/v1/admin/administrators',
    executionContext: { waitUntil: () => undefined },
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
  const user = (created as { user?: { id?: unknown } }).user;
  if (typeof user?.id !== 'string') throw new Error('Expected a created Administrator id.');
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
  return { cookie: sessionCookieFrom(login), id: user.id };
}

async function verifiedReaderCookie(email: string): Promise<string> {
  const register = await post('/v1/auth/register', {
    name: 'Reader Caller',
    email,
    password: 'Correct-horse-43',
  });
  expect(register.status).toBe(201);
  expect((await post('/v1/auth/request-verification', { email })).status).toBe(202);
  expect((await post('/v1/auth/verify-email', { token: verificationToken() })).status).toBe(200);
  const login = await post('/v1/auth/login', { email, password: 'Correct-horse-43' });
  expect(login.status).toBe(200);
  return sessionCookieFrom(login);
}

async function seedDisabledAdministrator(): Promise<{ createdAt: string; updatedAt: string }> {
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  await workerEnv.DB.batch([
    workerEnv.DB.prepare(
      `INSERT INTO admin_user
       (id, name, email, email_verified, created_at, updated_at, role, banned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind('admin-disabled', 'Zoe Admin', 'zoe@example.com', 1, nowSeconds, nowSeconds, 'admin', 0),
    workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, ?, ?, ?)`,
    ).bind('admin-disabled', 'disabled', 3, now),
    workerEnv.DB.prepare(
      `INSERT INTO admin_account
       (id, account_id, provider_id, user_id, password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      'account-disabled',
      'admin-disabled',
      'credential',
      'admin-disabled',
      'secret',
      nowSeconds,
      nowSeconds,
    ),
  ]);
  const timestamp = new Date(nowSeconds * 1_000).toISOString();
  return { createdAt: timestamp, updatedAt: timestamp };
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM "identity_event"'),
    db.prepare('DELETE FROM "administrator_access_state"'),
    db.prepare('DELETE FROM "admin_session"'),
    db.prepare('DELETE FROM "admin_account"'),
    db.prepare('DELETE FROM "admin_verification"'),
    db.prepare('DELETE FROM "admin_email_verification_token"'),
    db.prepare('DELETE FROM "admin_user"'),
    db.prepare('DELETE FROM "admin_bootstrap_attempt"'),
    db.prepare('DELETE FROM "admin_bootstrap_guard"'),
  ]);
  mailer.clear();
});

describe('GET /v1/admin/administrators', () => {
  it('lists safe Administrator metadata and access state in ascending email order', async () => {
    const { cookie, id } = await bootstrapAdministrator();
    await seedDisabledAdministrator();

    const response = await get('/v1/admin/administrators', cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      items: [
        {
          id,
          email: 'ada@example.com',
          emailVerified: true,
          realm: 'administrator',
          role: 'admin',
          access: { state: 'active' },
          revision: 1,
        },
        {
          id: 'admin-disabled',
          email: 'zoe@example.com',
          emailVerified: true,
          realm: 'administrator',
          role: 'admin',
          access: { state: 'disabled' },
          revision: 3,
        },
      ],
      total: 2,
    });
  });

  it('rejects a disabled actor before any target lookup can be observed', async () => {
    const actor = await bootstrapAdministrator();
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)`,
    )
      .bind(actor.id, Date.now())
      .run();

    const response = await get('/v1/admin/administrators/not-a-real-target/activity', actor.cookie);

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('filters and paginates safe Administrator metadata', async () => {
    const { cookie } = await bootstrapAdministrator();
    await createAdministrator({ name: 'Grace Admin', email: 'grace@example.com' });
    await createAdministrator({ name: 'Linus Admin', email: 'linus@example.net' });
    await seedDisabledAdministrator();

    const response = await get(
      '/v1/admin/administrators?email=example.com&limit=1&offset=1',
      cookie,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      items: Record<string, unknown>[];
      total: number;
    };
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ email: 'grace@example.com' });
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual([
      'access',
      'email',
      'emailVerified',
      'id',
      'realm',
      'revision',
      'role',
    ]);
    expect(JSON.stringify(body)).not.toContain('secret');
    expect(JSON.stringify(body)).not.toMatch(/password|token|session/i);
  });

  it('does not reveal Administrator existence to anonymous or Reader callers', async () => {
    await bootstrapAdministrator();
    await seedDisabledAdministrator();
    const readerCookie = await verifiedReaderCookie('reader-caller@example.com');
    const targets = ['admin-disabled', 'not-a-real-administrator'];
    const protectedPaths = targets.flatMap((target) => [
      `/v1/admin/administrators/${target}`,
      `/v1/admin/administrators/${target}/activity`,
    ]);

    const anonymousResponses = await Promise.all(protectedPaths.map((path) => get(path)));
    const readerResponses = await Promise.all(
      protectedPaths.map((path) => get(path, readerCookie)),
    );

    expect(anonymousResponses.map((response) => response.status)).toEqual([401, 401, 401, 401]);
    expect(readerResponses.map((response) => response.status)).toEqual([403, 403, 403, 403]);
    for (const response of anonymousResponses) {
      expect(await response.json()).toMatchObject({ code: 'unauthenticated' });
    }
    for (const response of readerResponses) {
      expect(await response.json()).toMatchObject({ code: 'forbidden' });
    }
  });
});

describe('GET /v1/admin/administrators/{administratorId}', () => {
  it('returns one safe Administrator detail with a strong revision ETag', async () => {
    const { cookie } = await bootstrapAdministrator();
    const timestamps = await seedDisabledAdministrator();

    const response = await get('/v1/admin/administrators/admin-disabled', cookie);

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"3"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      id: 'admin-disabled',
      email: 'zoe@example.com',
      emailVerified: true,
      realm: 'administrator',
      role: 'admin',
      access: { state: 'disabled' },
      revision: 3,
      summary: timestamps,
      methods: [{ type: 'password' }],
    });
  });
});

describe('GET /v1/admin/administrators/{administratorId}/activity', () => {
  it('returns only safe allowlisted Administrator lifecycle events with opaque pagination', async () => {
    const { cookie } = await bootstrapAdministrator();
    await seedDisabledAdministrator();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'event-disable',
        1,
        'access-disabled',
        Date.UTC(2026, 0, 2),
        'administrator',
        'actor-admin',
        'administrator',
        'admin-disabled',
        'success',
        'request-1',
        JSON.stringify({
          private: 'must-not-leak',
          email: 'private-event@example.com',
          token: 'event-secret-token',
          actionUrl: 'https://private.example/action?token=event-secret-token',
          password: 'event-secret-password',
          emailBody: 'private message content',
        }),
      ),
      workerEnv.DB.prepare(
        `INSERT INTO identity_event
         (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
          result, request_id, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'event-rehabilitate',
        1,
        'access-rehabilitated',
        Date.UTC(2026, 0, 1),
        'administrator',
        'actor-admin',
        'administrator',
        'admin-disabled',
        'success',
        'request-2',
        '{"private":"also-must-not-leak"}',
      ),
    ]);

    const firstResponse = await get(
      '/v1/admin/administrators/admin-disabled/activity?limit=1',
      cookie,
    );

    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
    const firstPage = (await firstResponse.json()) as {
      items: { id: string; type: string }[];
      nextCursor: string | null;
    };
    expect(firstPage).toMatchObject({
      items: [
        {
          id: 'event-disable',
          type: 'access-disabled',
        },
      ],
    });
    expect(firstPage.nextCursor).not.toBeNull();

    const secondResponse = await get(
      `/v1/admin/administrators/admin-disabled/activity?limit=1&cursor=${encodeURIComponent(String(firstPage.nextCursor))}`,
      cookie,
    );
    expect(secondResponse.status).toBe(200);
    const secondPage = await secondResponse.json();
    expect(secondPage).toMatchObject({
      items: [{ id: 'event-rehabilitate', type: 'access-rehabilitated' }],
      nextCursor: null,
    });
    const serializedPages = JSON.stringify([firstPage, secondPage]);
    for (const sensitiveValue of [
      'must-not-leak',
      'private-event@example.com',
      'event-secret-token',
      'https://private.example/action',
      'event-secret-password',
      'private message content',
    ]) {
      expect(serializedPages).not.toContain(sensitiveValue);
    }
  });
});

describe('PUT /v1/admin/administrators/{administratorId}/access', () => {
  it('returns changed:false for an already active Administrator', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });

    const response = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'active' },
      actor.cookie,
      { 'if-match': '"1"' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"1"');
    expect(await response.json()).toEqual({ state: 'active', changed: false, revision: 1 });
  });

  it('gives two active Administrators equal authority over each other', async () => {
    const first = await bootstrapAdministrator();
    const second = await createAdministrator({ name: 'Grace Admin', email: 'grace@example.com' });
    await createAdministrator({ name: 'Linus Admin', email: 'linus@example.com' });

    const firstDisablesSecond = await put(
      `/v1/admin/administrators/${second.id}/access`,
      { state: 'disabled' },
      first.cookie,
      { 'if-match': '"1"' },
    );
    expect(firstDisablesSecond.status).toBe(200);
    const firstRehabilitatesSecond = await put(
      `/v1/admin/administrators/${second.id}/access`,
      { state: 'active' },
      first.cookie,
      { 'if-match': '"2"' },
    );
    expect(firstRehabilitatesSecond.status).toBe(200);
    const secondLogin = await post('/v1/admin/auth/login', {
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });
    expect(secondLogin.status).toBe(200);

    const secondDisablesFirst = await put(
      `/v1/admin/administrators/${first.id}/access`,
      { state: 'disabled' },
      sessionCookieFrom(secondLogin),
      { 'if-match': '"1"' },
    );

    expect(secondDisablesFirst.status).toBe(200);
    expect(await secondDisablesFirst.json()).toEqual({
      state: 'disabled',
      changed: true,
      revision: 2,
    });
  });

  it('disables another Administrator with revision CAS and revokes their existing sessions', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });

    const response = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('"2"');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({ state: 'disabled', changed: true, revision: 2 });

    const revokedSession = await get('/v1/admin/me', target.cookie);
    expect(revokedSession.status).toBe(401);
    expect(await revokedSession.json()).toMatchObject({ code: 'unauthenticated' });
  });

  it('blocks new login sessions while the Administrator is disabled', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });
    const disabled = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );
    expect(disabled.status).toBe(200);

    const login = await post('/v1/admin/auth/login', {
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });

    expect(login.status).toBe(403);
    expect(login.headers.get('set-cookie')).toBeNull();
    expect(await login.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('rejects self-disable without changing the current Administrator', async () => {
    const actor = await bootstrapAdministrator();

    const response = await put(
      `/v1/admin/administrators/${actor.id}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"1"' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'self-disable-forbidden' });
    expect((await get('/v1/admin/me', actor.cookie)).status).toBe(200);
  });

  it('requires a current strong revision precondition', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });

    const missing = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'disabled' },
      actor.cookie,
    );
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: 'precondition-required' });

    const stale = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"9"' },
    );
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision' });
  });

  it('rehabilitates access without restoring revoked sessions', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });
    expect(
      (
        await put(
          `/v1/admin/administrators/${target.id}/access`,
          { state: 'disabled' },
          actor.cookie,
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(200);

    const rehabilitated = await put(
      `/v1/admin/administrators/${target.id}/access`,
      { state: 'active' },
      actor.cookie,
      { 'if-match': '"2"' },
    );

    expect(rehabilitated.status).toBe(200);
    expect(rehabilitated.headers.get('etag')).toBe('"3"');
    expect(await rehabilitated.json()).toEqual({ state: 'active', changed: true, revision: 3 });
    expect((await get('/v1/admin/me', target.cookie)).status).toBe(401);

    const login = await post('/v1/admin/auth/login', {
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });
    expect(login.status).toBe(200);
  });

  it('keeps verification and recovery available while disabled without exposing secrets or rehabilitating', async () => {
    const actor = await bootstrapAdministrator();
    const target = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });
    expect(
      (
        await put(
          `/v1/admin/administrators/${target.id}/access`,
          { state: 'disabled' },
          actor.cookie,
          { 'if-match': '"1"' },
        )
      ).status,
    ).toBe(200);
    await workerEnv.DB.prepare('UPDATE admin_user SET email_verified = 0 WHERE id = ?')
      .bind(target.id)
      .run();

    // Keep the privacy assertions at the application-owned HTTP boundary:
    // scheduling is accepted without exposing delivery credentials or
    // changing the target's disabled access state.
    const verification = await postWithCookie(
      `/v1/admin/administrators/${target.id}/email-verification/messages`,
      {},
      actor.cookie,
      { 'idempotency-key': 'administrator-verification-1' },
    );
    const recovery = await postWithCookie(
      `/v1/admin/administrators/${target.id}/password-recovery/messages`,
      {},
      actor.cookie,
      { 'idempotency-key': 'administrator-recovery-1' },
    );

    expect(verification.status).toBe(202);
    expect(recovery.status).toBe(202);
    expect(verification.headers.get('cache-control')).toBe('private, no-store');
    expect(recovery.headers.get('cache-control')).toBe('private, no-store');
    const verificationBody = JSON.stringify(await verification.json());
    const recoveryBody = JSON.stringify(await recovery.json());
    const verificationMessage = mailer.sent.at(-1);
    const recoveryMessage = mailer.passwordResets.at(-1);
    expect(verificationMessage).toBeDefined();
    expect(recoveryMessage).toBeDefined();
    for (const [body, message] of [
      [verificationBody, verificationMessage],
      [recoveryBody, recoveryMessage],
    ] as const) {
      expect(body).not.toContain('grace@example.com');
      expect(body).not.toContain('Correct-horse-42');
      if (message !== undefined) {
        expect(body).not.toContain(message.token);
        expect(body).not.toContain(message.url);
      }
      expect(body).not.toMatch(/"(?:to|token|url|password|html|text|body)"\s*:/i);
    }

    const detail = await get(`/v1/admin/administrators/${target.id}`, actor.cookie);
    expect(detail.status).toBe(200);
    expect(await detail.json()).toMatchObject({ access: { state: 'disabled' } });
    const login = await post('/v1/admin/auth/login', {
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });
    expect(login.status).toBe(403);
    expect(await login.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('atomically preserves one Operational Administrator during concurrent disables', async () => {
    const first = await bootstrapAdministrator();
    const second = await createAdministrator({
      name: 'Grace Admin',
      email: 'grace@example.com',
    });

    const responses = await Promise.all([
      put(`/v1/admin/administrators/${second.id}/access`, { state: 'disabled' }, first.cookie, {
        'if-match': '"1"',
      }),
      put(`/v1/admin/administrators/${first.id}/access`, { state: 'disabled' }, second.cookie, {
        'if-match': '"1"',
      }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const conflict = responses.find((response) => response.status === 409);
    expect(conflict).toBeDefined();
    expect(await conflict?.json()).toMatchObject({ code: 'last-operational-administrator' });
  });
});
