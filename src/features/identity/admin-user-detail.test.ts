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

async function patchWithCookie(
  path: string,
  body: unknown,
  cookie: string | null,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null && cookie.length > 0) headers.cookie = cookie;
  return app.request(
    path,
    { method: 'PATCH', headers, body: JSON.stringify(body) },
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

async function registerVerifiedUser(name: string, email: string): Promise<void> {
  const registerRes = await post('/v1/auth/register', {
    name,
    email,
    password: 'Correct-horse-41',
  });
  expect(registerRes.status).toBe(201);
  await verifyEmailAddress(email);
}

async function userIdForCookie(cookie: string, administrator = false): Promise<string> {
  const res = await get(administrator ? '/v1/admin/me' : '/v1/me', { cookie });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { id?: unknown };
  expect(typeof body.id).toBe('string');
  return body.id as string;
}

async function bootstrapVerifiedAdmin(
  email = 'admin@example.com',
): Promise<{ cookie: string; adminId: string }> {
  const bootstrapRes = await post('/v1/admin/auth/bootstrap', {
    name: 'Ada Admin',
    email,
    password: 'Correct-horse-41',
  });
  expect(bootstrapRes.status).toBe(201);
  await verifyEmailAddress(email, true);
  const loginRes = await post('/v1/admin/auth/login', {
    email,
    password: 'Correct-horse-41',
  });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  expect(cookie).not.toBeNull();
  if (cookie === null) {
    throw new Error('Expected a session cookie for the verified administrator.');
  }
  return { cookie, adminId: await userIdForCookie(cookie, true) };
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
    db.prepare('DELETE FROM "admin_session"'),
    db.prepare('DELETE FROM "admin_account"'),
    db.prepare('DELETE FROM "admin_verification"'),
    db.prepare('DELETE FROM "admin_email_verification_token"'),
    db.prepare('DELETE FROM "identity_event"'),
    db.prepare('DELETE FROM "admin_idempotency_record"'),
    db.prepare('DELETE FROM "identity_reservation"'),
    db.prepare('DELETE FROM "administrator_access_state"'),
    db.prepare('DELETE FROM "admin_user"'),
    db.prepare('DELETE FROM "reader_access_state"'),
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
    expect(Object.keys(body).sort()).toEqual([
      'access',
      'activeWorkflows',
      'email',
      'emailVerified',
      'id',
      'methods',
      'realm',
      'revision',
      'role',
      'summary',
    ]);
    expect(body.realm).toBe('reader');
    expect(body).toMatchObject({
      id: userId,
      email: 'ordinary@example.com',
      emailVerified: true,
      realm: 'reader',
      role: 'user',
      revision: 1,
      access: {
        state: 'active',
        effectiveState: 'active',
      },
      activeWorkflows: [],
    });
    expect(body.methods).toEqual([{ type: 'password' }]);
    expect(res.headers.get('etag')).toBe('"1"');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toContain('passwordhash');
    expect(serialized).not.toContain('password_hash');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('session');
  });

  it('returns a distinct not-found problem for an authorized missing User', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();

    const res = await get('/v1/admin/users/does-not-exist-41', { cookie });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'reader-not-found', status: 404 });
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects overlong identifiers through the public validation contract', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();

    const res = await get(`/v1/admin/users/${'a'.repeat(129)}`, { cookie });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'bad-request', status: 400 });
  });

  it('does not resolve a Reader session for a missing administrative target', async () => {
    await bootstrapVerifiedAdmin();
    const { cookie } = await verifiedRegularCookie('ordinary@example.com');

    const res = await get('/v1/admin/users/does-not-exist-41', { cookie });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('rejects a revoked session as unauthenticated', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    const signOutRes = await postWithCookie('/v1/admin/auth/sign-out', {}, cookie);
    expect(signOutRes.status).toBe(200);

    const res = await get(`/v1/admin/users/${encodeURIComponent(adminId)}`, { cookie });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects an expired session as unauthenticated', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    await workerEnv.DB.prepare('UPDATE "admin_session" SET expires_at = 0').run();

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
    await workerEnv.DB.prepare(
      'ALTER TABLE "user" RENAME TO "reader_user_detail_unavailable"',
    ).run();
    const { logs, restore } = capturedLogs();
    try {
      const res = await get(`/v1/admin/users/${encodeURIComponent(adminId)}`, { cookie });
      expect(res.status).toBe(500);
      expect(res.headers.get('cache-control')).toBe('private, no-store');
      await res.arrayBuffer();
    } finally {
      restore();
      await workerEnv.DB.prepare(
        'ALTER TABLE "reader_user_detail_unavailable" RENAME TO "user"',
      ).run();
    }

    const joined = logs.join('\n');
    expect(joined).not.toContain(adminId);
    const paths = loggedPaths(logs);
    expect(paths).toContain('/v1/admin/users/:userId');
  });

  it('returns the same disabled-actor problem before existing or missing Reader lookup', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('disabled-actor-target@example.com');
    await workerEnv.DB.prepare(
      'INSERT INTO administrator_access_state (user_id, state, revision, updated_at) VALUES (?, ?, ?, ?)',
    )
      .bind(adminId, 'disabled', 2, Date.now())
      .run();

    for (const target of [userId, 'does-not-exist-41']) {
      const response = await get(`/v1/admin/users/${encodeURIComponent(target)}`, { cookie });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        code: 'administrator-disabled',
        status: 403,
      });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('GET /v1/admin/users/{userId}/activity', () => {
  it('returns allowlisted successful lifecycle events newest-first with an opaque cursor', async () => {
    const { cookie, adminId } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('activity-target@example.com');
    const insert = workerEnv.DB.prepare(
      `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, problem_code, metadata)
       VALUES (?, 1, ?, ?, 'administrator', ?, 'reader', ?, ?, ?, ?, ?)`,
    );
    await workerEnv.DB.batch([
      insert.bind(
        'event-1',
        'email-verified',
        1_700_000_001_000,
        adminId,
        userId,
        'success',
        'request-1',
        null,
        JSON.stringify({ token: 'never-project-me' }),
      ),
      insert.bind(
        'event-2',
        'access-disabled',
        1_700_000_002_000,
        adminId,
        userId,
        'success',
        'request-2',
        null,
        JSON.stringify({ ip: '192.0.2.1' }),
      ),
      insert.bind(
        'event-3',
        'access-rehabilitated',
        1_700_000_003_000,
        adminId,
        userId,
        'success',
        'request-3',
        null,
        JSON.stringify({ userAgent: 'secret' }),
      ),
      insert.bind(
        'routine-login',
        'login',
        1_700_000_004_000,
        adminId,
        userId,
        'success',
        'request-4',
        null,
        null,
      ),
      insert.bind(
        'failed-event',
        'email-changed',
        1_700_000_005_000,
        adminId,
        userId,
        'failure',
        'request-5',
        'conflict',
        null,
      ),
    ]);

    const first = await get(`/v1/admin/users/${encodeURIComponent(userId)}/activity?limit=2`, {
      cookie,
    });
    expect(first.status).toBe(200);
    expect(first.headers.get('cache-control')).toBe('private, no-store');
    const firstBody = (await first.json()) as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(firstBody.items.map((event) => event.id)).toEqual(['event-3', 'event-2']);
    expect(firstBody.nextCursor).toEqual(expect.any(String));
    expect(JSON.stringify(firstBody)).not.toMatch(/token|192\.0\.2\.1|userAgent|request-/i);

    const second = await get(
      `/v1/admin/users/${encodeURIComponent(userId)}/activity?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? '')}`,
      { cookie },
    );
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as {
      items: Record<string, unknown>[];
      nextCursor: string | null;
    };
    expect(secondBody.items.map((event) => event.id)).toEqual(['event-1']);
    expect(secondBody.nextCursor).toBeNull();
  });

  it('is empty for existing history and validates cursor and maximum page size privately', async () => {
    const { cookie } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('empty-activity@example.com');

    const empty = await get(`/v1/admin/users/${encodeURIComponent(userId)}/activity`, { cookie });
    expect(empty.status).toBe(200);
    expect(await empty.json()).toEqual({ items: [], nextCursor: null });

    for (const suffix of ['?limit=51', '?cursor=not-a-cursor']) {
      const invalid = await get(`/v1/admin/users/${encodeURIComponent(userId)}/activity${suffix}`, {
        cookie,
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ code: 'bad-request' });
      expect(invalid.headers.get('cache-control')).toBe('private, no-store');
    }
  });
});

describe('administrative lifecycle persistence foundation', () => {
  it('provides revision defaults, scoped reservations and 24-hour idempotency expiry', async () => {
    const { adminId } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('foundation@example.com');
    const now = 1_700_000_000_000;
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        'INSERT INTO reader_access_state (user_id, updated_at) VALUES (?, ?)',
      ).bind(userId, now),
      workerEnv.DB.prepare(
        'INSERT INTO administrator_access_state (user_id, updated_at) VALUES (?, ?)',
      ).bind(adminId, now),
      workerEnv.DB.prepare(
        `INSERT INTO identity_reservation
           (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'reservation-1',
        'email',
        'reader',
        'future@example.com',
        userId,
        'workflow-1',
        now,
        now + 1,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        'idempotency-1',
        adminId,
        'retry-key',
        'POST',
        '/v1/admin/users/:userId/email-changes',
        userId,
        'body-hash',
        201,
        '{}',
        now,
        now + 86_400_000,
      ),
    ]);

    const readerState = await workerEnv.DB.prepare(
      'SELECT state, revision FROM reader_access_state WHERE user_id = ?',
    )
      .bind(userId)
      .first();
    const administratorState = await workerEnv.DB.prepare(
      'SELECT state, revision FROM administrator_access_state WHERE user_id = ?',
    )
      .bind(adminId)
      .first();
    expect(readerState).toEqual({ state: 'active', revision: 1 });
    expect(administratorState).toEqual({ state: 'active', revision: 1 });
    const idempotency = await workerEnv.DB.prepare(
      'SELECT expires_at - created_at AS retention FROM admin_idempotency_record WHERE id = ?',
    )
      .bind('idempotency-1')
      .first();
    expect(idempotency).toEqual({ retention: 86_400_000 });
  });
});

describe('GET /v1/admin/users/{userId}/account-details', () => {
  it('lets an authorized administrator inspect another User’s optional details', async () => {
    const { cookie: adminCookie } = await bootstrapVerifiedAdmin();
    const { userId } = await verifiedRegularCookie('account-details-target@example.com');

    const res = await get(`/v1/admin/users/${encodeURIComponent(userId)}/account-details`, {
      cookie: adminCookie,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.json()).toEqual({
      firstName: null,
      lastName: null,
      birthDate: null,
      phone: null,
      image: null,
    });
  });

  it('authorizes before target lookup and returns not-found only to an Administrator', async () => {
    const { cookie: adminCookie } = await bootstrapVerifiedAdmin();
    const { cookie: userCookie, userId } = await verifiedRegularCookie(
      'account-details-reader@example.com',
    );
    const path = '/v1/admin/users/no-such-user-248/account-details';
    const existingPath = `/v1/admin/users/${encodeURIComponent(userId)}/account-details`;

    const anonymous = await get(path);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });

    const ordinaryExisting = await get(existingPath, { cookie: userCookie });
    const ordinaryMissing = await get(path, { cookie: userCookie });
    expect(ordinaryExisting.status).toBe(403);
    expect(ordinaryMissing.status).toBe(403);
    expect(await ordinaryExisting.json()).toMatchObject({ code: 'forbidden' });
    expect(await ordinaryMissing.json()).toMatchObject({ code: 'forbidden' });

    const administrator = await get(path, { cookie: adminCookie });
    expect(administrator.status).toBe(404);
    expect(await administrator.json()).toMatchObject({ code: 'not-found' });
  });
});

describe('PATCH /v1/admin/users/{userId}/account-details', () => {
  it('updates only validated Account Details and keeps failed requests atomic', async () => {
    const { cookie: adminCookie } = await bootstrapVerifiedAdmin();
    const { cookie: userCookie, userId } = await verifiedRegularCookie(
      'account-details-patch@example.com',
    );
    const path = `/v1/admin/users/${encodeURIComponent(userId)}/account-details`;

    const updated = await patchWithCookie(
      path,
      {
        firstName: '  Ada  ',
        lastName: '',
        birthDate: '2000-02-29',
        phone: '  ',
        image: 'https://images.example.test/ada.png',
      },
      adminCookie,
    );
    expect(updated.status).toBe(200);
    expect(updated.headers.get('cache-control')).toBe('private, no-store');
    expect(await updated.json()).toEqual({
      firstName: 'Ada',
      lastName: null,
      birthDate: '2000-02-29',
      phone: null,
      image: 'https://images.example.test/ada.png',
    });

    const invalidDate = await patchWithCookie(
      path,
      { lastName: 'Lovelace', birthDate: '1900-02-29' },
      adminCookie,
    );
    expect(invalidDate.status).toBe(400);
    expect(invalidDate.headers.get('content-type')).toContain('application/problem+json');
    expect(await invalidDate.json()).toMatchObject({ code: 'bad-request' });

    const malicious = await patchWithCookie(
      path,
      {
        firstName: 'Injected',
        email: 'attacker@example.test',
        emailVerified: false,
        role: 'admin',
        banned: true,
        banReason: 'forged',
        banExpires: 1,
        name: 'Injected technical name',
        password: 'replace-password',
        session: { token: 'forged-session' },
        arbitraryField: 'unexpected',
      },
      adminCookie,
    );
    expect(malicious.status).toBe(400);
    expect(await malicious.json()).toMatchObject({ code: 'bad-request', status: 400 });

    const genericEngineRouter = await postWithCookie(
      '/api/auth/admin/update-user',
      { userId, data: { role: 'admin' } },
      adminCookie,
    );
    expect(genericEngineRouter.status).toBe(404);

    const ordinaryUserWrite = await patchWithCookie(path, { firstName: 'Not allowed' }, userCookie);
    expect(ordinaryUserWrite.status).toBe(403);
    expect(await ordinaryUserWrite.json()).toMatchObject({ code: 'forbidden' });

    const anonymousWrite = await patchWithCookie(path, { firstName: 'Not allowed' }, null);
    expect(anonymousWrite.status).toBe(401);
    expect(await anonymousWrite.json()).toMatchObject({ code: 'unauthenticated' });

    const noTargetWrite = await patchWithCookie(
      '/v1/admin/users/no-such-user-248/account-details',
      { firstName: 'Not allowed' },
      userCookie,
    );
    expect(noTargetWrite.status).toBe(403);
    expect(await noTargetWrite.json()).toMatchObject({ code: 'forbidden' });

    const afterFailures = await get(path, { cookie: adminCookie });
    expect(afterFailures.status).toBe(200);
    expect(await afterFailures.json()).toEqual({
      firstName: 'Ada',
      lastName: null,
      birthDate: '2000-02-29',
      phone: null,
      image: 'https://images.example.test/ada.png',
    });
    expect((await get('/v1/admin/users', { cookie: adminCookie })).status).toBe(200);
  });

  it('rejects anonymous, ordinary and unknown-target writes without exposing target existence', async () => {
    const { cookie: adminCookie } = await bootstrapVerifiedAdmin();
    const { cookie: userCookie, userId } = await verifiedRegularCookie(
      'account-details-denied@example.com',
    );
    const existingPath = `/v1/admin/users/${encodeURIComponent(userId)}/account-details`;
    const missingPath = '/v1/admin/users/no-such-user-248/account-details';

    const anonymous = await patchWithCookie(existingPath, { firstName: 'Intruder' }, null);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });

    const ordinaryExisting = await patchWithCookie(
      existingPath,
      { firstName: 'Intruder' },
      userCookie,
    );
    const ordinaryMissing = await patchWithCookie(
      missingPath,
      { firstName: 'Intruder' },
      userCookie,
    );
    expect(ordinaryExisting.status).toBe(403);
    expect(ordinaryMissing.status).toBe(403);
    expect(await ordinaryExisting.json()).toMatchObject({ code: 'forbidden' });
    expect(await ordinaryMissing.json()).toMatchObject({ code: 'forbidden' });

    const adminMissing = await patchWithCookie(
      missingPath,
      { firstName: 'Missing target' },
      adminCookie,
    );
    expect(adminMissing.status).toBe(404);
    expect(await adminMissing.json()).toMatchObject({ code: 'not-found' });
    expect((await get(existingPath, { cookie: adminCookie })).status).toBe(200);
  });
});
