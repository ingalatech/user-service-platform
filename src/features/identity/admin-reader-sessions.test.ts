import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env;
const migrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
const executionContext = {
  waitUntil: (task: Promise<unknown>) => task,
  passThroughOnException: () => undefined,
  props: {},
};

function testEnv(secret = 'test-selector-secret-v1'): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    BETTER_AUTH_SECRET: secret,
  };
}

async function request(
  path: string,
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  options: {
    readonly body?: unknown;
    readonly cookie?: string;
    readonly headers?: Record<string, string>;
    readonly secret?: string;
  } = {},
): Promise<Response> {
  return app.request(
    path,
    {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    },
    testEnv(options.secret),
    executionContext,
  );
}

function cookieFrom(response: Response): string {
  const pair = response.headers.get('set-cookie')?.split(';')[0]?.trim();
  if (pair === undefined || pair.length === 0) throw new Error('Expected an auth cookie.');
  return pair;
}

function lastVerificationToken(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected a verification message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  return token;
}

async function bootstrapAdministrator(): Promise<string> {
  const email = 'sessions-admin@example.com';
  expect(
    (
      await request('/v1/admin/auth/bootstrap', 'POST', {
        body: { name: 'Sessions Admin', email, password: 'Correct-horse-41' },
      })
    ).status,
  ).toBe(201);
  expect(
    (await request('/v1/admin/auth/request-verification', 'POST', { body: { email } })).status,
  ).toBe(202);
  expect(
    (
      await request('/v1/admin/auth/verify-email', 'POST', {
        body: { token: lastVerificationToken() },
      })
    ).status,
  ).toBe(200);
  const login = await request('/v1/admin/auth/login', 'POST', {
    body: { email, password: 'Correct-horse-41' },
  });
  expect(login.status).toBe(200);
  return cookieFrom(login);
}

async function registerReader(email: string): Promise<{ id: string; cookie: string }> {
  const registration = await request('/v1/auth/register', 'POST', {
    body: { name: 'Sessions Reader', email, password: 'Correct-horse-42' },
  });
  expect(registration.status).toBe(201);
  const reader = (await registration.json()) as { id: string };
  expect((await request('/v1/auth/request-verification', 'POST', { body: { email } })).status).toBe(
    202,
  );
  expect(
    (await request('/v1/auth/verify-email', 'POST', { body: { token: lastVerificationToken() } }))
      .status,
  ).toBe(200);
  const login = await request('/v1/auth/login', 'POST', {
    body: { email, password: 'Correct-horse-42' },
  });
  expect(login.status).toBe(200);
  return { id: reader.id, cookie: cookieFrom(login) };
}

async function insertReaderSession(input: {
  readonly id: string;
  readonly token: string;
  readonly userId: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly expiresAt: number;
  readonly ipAddress?: string;
  readonly userAgent?: string;
}): Promise<void> {
  await workerEnv.DB.prepare(
    `INSERT INTO session (id, token, user_id, created_at, updated_at, expires_at, ip_address, user_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.token,
      input.userId,
      Math.floor(input.createdAt / 1_000),
      Math.floor(input.updatedAt / 1_000),
      Math.floor(input.expiresAt / 1_000),
      input.ipAddress ?? null,
      input.userAgent ?? null,
    )
    .run();
}

async function eventCount(type: string, readerId: string): Promise<number> {
  const row = await workerEnv.DB.prepare(
    'SELECT count(*) AS total FROM identity_event WHERE type = ? AND subject_id = ?',
  )
    .bind(type, readerId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

function expectEventTimeNearNow(value: string): void {
  const occurredAt = Date.parse(value);
  expect(occurredAt).toBeGreaterThan(Date.now() - 60_000);
  expect(occurredAt).toBeLessThanOrEqual(Date.now() + 5_000);
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, migrations);
});

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare('DELETE FROM identity_event'),
    workerEnv.DB.prepare('DELETE FROM admin_idempotency_record'),
    workerEnv.DB.prepare('DELETE FROM reader_deletion_request'),
    workerEnv.DB.prepare('DELETE FROM reader_access_state'),
    workerEnv.DB.prepare('DELETE FROM administrator_access_state'),
    workerEnv.DB.prepare('DELETE FROM admin_session'),
    workerEnv.DB.prepare('DELETE FROM admin_account'),
    workerEnv.DB.prepare('DELETE FROM admin_verification'),
    workerEnv.DB.prepare('DELETE FROM admin_email_verification_token'),
    workerEnv.DB.prepare('DELETE FROM admin_user'),
    workerEnv.DB.prepare('DELETE FROM admin_bootstrap_attempt'),
    workerEnv.DB.prepare('DELETE FROM admin_bootstrap_guard'),
    workerEnv.DB.prepare('DELETE FROM session'),
    workerEnv.DB.prepare('DELETE FROM account'),
    workerEnv.DB.prepare('DELETE FROM verification'),
    workerEnv.DB.prepare('DELETE FROM email_verification_token'),
    workerEnv.DB.prepare('DELETE FROM user'),
  ]);
  mailer.clear();
});

describe('Reader session administration HTTP boundary', () => {
  it('lists only active Reader sessions in newest-first pages with opaque selectors and safe fields', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-list@example.com');
    const now = Date.now();
    await insertReaderSession({
      id: 'reader-session-old',
      token: 'reader-token-old',
      userId: reader.id,
      createdAt: now - 10_000,
      updatedAt: now - 8_000,
      expiresAt: now + 60_000,
      ipAddress: '203.0.113.12',
      userAgent: 'private-agent-value',
    });
    await insertReaderSession({
      id: 'reader-session-new',
      token: 'reader-token-new',
      userId: reader.id,
      createdAt: now - 5_000,
      updatedAt: now - 2_000,
      expiresAt: now + 60_000,
    });
    await insertReaderSession({
      id: 'reader-session-expired',
      token: 'reader-token-expired',
      userId: reader.id,
      createdAt: now - 20_000,
      updatedAt: now - 19_000,
      expiresAt: now - 1,
    });

    const firstResponse = await request(`/v1/admin/users/${reader.id}/sessions?limit=1`, 'GET', {
      cookie: administrator,
    });
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
    const firstText = await firstResponse.text();
    expect(firstText).not.toMatch(
      /reader-session-|reader-token-|203\.0\.113\.12|private-agent-value/,
    );
    const first = JSON.parse(firstText) as {
      items: { selector: string; createdAt: string; updatedAt: string; expiresAt: string }[];
      total: number;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(1);
    expect(first.total).toBe(3);
    const listedSession = first.items[0];
    if (listedSession === undefined) throw new Error('Expected a listed Reader session.');
    expect(Object.keys(listedSession).sort()).toEqual([
      'createdAt',
      'expiresAt',
      'selector',
      'updatedAt',
    ]);
    expect(listedSession.selector).toMatch(/^s1_[A-Za-z0-9_-]{39,208}$/);
    expect(Date.parse(listedSession.createdAt)).toBeGreaterThan(now - 30_000);
    expect(Date.parse(listedSession.updatedAt)).toBeGreaterThan(now - 30_000);
    expect(Date.parse(listedSession.expiresAt)).toBeGreaterThan(now + 30_000);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain('reader-session-old');
    expect(first.nextCursor).not.toContain('reader-session-new');
    expect(first.nextCursor).not.toContain('reader-token');

    const secondResponse = await request(
      `/v1/admin/users/${reader.id}/sessions?limit=1&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      'GET',
      { cookie: administrator },
    );
    expect(secondResponse.status).toBe(200);
    const second = (await secondResponse.json()) as {
      items: { selector: string }[];
      nextCursor: string | null;
    };
    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.selector).not.toBe(first.items[0]?.selector);
    expect(second.nextCursor).not.toBeNull();
    const thirdResponse = await request(
      `/v1/admin/users/${reader.id}/sessions?limit=1&cursor=${encodeURIComponent(second.nextCursor ?? '')}`,
      'GET',
      { cookie: administrator },
    );
    expect(thirdResponse.status).toBe(200);
    const third = (await thirdResponse.json()) as {
      items: { selector: string }[];
      nextCursor: string | null;
    };
    expect(third.items).toHaveLength(1);
    expect(third.items[0]?.selector).not.toBe(first.items[0]?.selector);
    expect(third.items[0]?.selector).not.toBe(second.items[0]?.selector);
    expect(third.nextCursor).toBeNull();
  });

  it('revokes one owned Reader session, audits it, and leaves login available', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-one@example.com');
    const sessionId = 'owned-reader-session';
    const issuedState = await request('/v1/auth/reader-state', 'POST', {
      cookie: reader.cookie,
      body: {},
    });
    expect(issuedState.status).toBe(200);
    const listing = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
      cookie: administrator,
    });
    const page = (await listing.json()) as { items: { selector: string }[] };
    const selector = page.items[0]?.selector;
    if (selector === undefined) throw new Error('Expected a session selector.');
    const prepare = vi.spyOn(workerEnv.DB, 'prepare');
    const response = await request(`/v1/admin/users/${reader.id}/sessions/${selector}`, 'DELETE', {
      cookie: administrator,
    });
    const revokeSql = prepare.mock.calls.map(([sql]) => sql);
    prepare.mockRestore();
    expect(
      revokeSql.some((sql) =>
        sql.includes('FROM session WHERE id=? AND user_id=? AND expires_at>?'),
      ),
    ).toBe(true);
    expect(revokeSql.some((sql) => sql.includes('SELECT id FROM session WHERE user_id='))).toBe(
      false,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as { state: string; changed: boolean; revision: number };
    expect(body.state).toBe('active');
    expect(body.changed).toBe(true);
    expect(body.revision).toBeGreaterThanOrEqual(1);
    expect(await eventCount('session-revoked', reader.id)).toBe(1);
    expect(
      (await request('/v1/auth/reader-state', 'POST', { cookie: reader.cookie, body: {} })).status,
    ).toBe(401);
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);
    const retry = await request(`/v1/admin/users/${reader.id}/sessions/${selector}`, 'DELETE', {
      cookie: administrator,
    });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({ changed: false });
    expect(await eventCount('session-revoked', reader.id)).toBe(1);
    const activity = await request(`/v1/admin/users/${reader.id}/activity`, 'GET', {
      cookie: administrator,
    });
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as {
      items: { type: string; occurredAt: string }[];
    };
    expect(activityBody).toMatchObject({
      items: [
        expect.objectContaining({
          type: 'session-revoked',
          metadata: { selector, revision: 1 },
        }),
      ],
    });
    const activityEvent = activityBody.items.find((item) => item.type === 'session-revoked');
    if (activityEvent === undefined) throw new Error('Expected manual revocation activity.');
    expectEventTimeNearNow(activityEvent.occurredAt);
    const audit = await request('/v1/admin/audit-events?action=session-revoked', 'GET', {
      cookie: administrator,
    });
    expect(audit.status).toBe(200);
    const auditText = await audit.text();
    expect(auditText).toContain(selector);
    expect(auditText).not.toContain(sessionId);
    expect(auditText).not.toContain('owned-reader-token');
    const auditBody = JSON.parse(auditText) as {
      items: { type: string; occurredAt: string }[];
    };
    const auditEvent = auditBody.items.find((item) => item.type === 'session-revoked');
    if (auditEvent === undefined) throw new Error('Expected manual revocation audit.');
    expectEventTimeNearNow(auditEvent.occurredAt);

    const login = await request('/v1/auth/login', 'POST', {
      body: { email: 'sessions-one@example.com', password: 'Correct-horse-42' },
    });
    expect(login.status).toBe(200);
  });

  it('caps pages at fifty and continues a deterministic tie-broken cursor without duplicates', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-pagination@example.com');
    await workerEnv.DB.prepare('DELETE FROM session WHERE user_id=?').bind(reader.id).run();
    const now = Date.now();
    for (let index = 0; index < 52; index += 1) {
      await insertReaderSession({
        id: `pagination-session-${String(index).padStart(2, '0')}`,
        token: `pagination-token-${String(index).padStart(2, '0')}`,
        userId: reader.id,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
      });
    }
    const firstResponse = await request(`/v1/admin/users/${reader.id}/sessions?limit=50`, 'GET', {
      cookie: administrator,
    });
    const first = (await firstResponse.json()) as {
      items: { selector: string }[];
      total: number;
      nextCursor: string | null;
    };
    expect(first.items).toHaveLength(50);
    expect(first.total).toBe(52);
    expect(first.nextCursor).not.toBeNull();
    const secondResponse = await request(
      `/v1/admin/users/${reader.id}/sessions?limit=50&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      'GET',
      { cookie: administrator },
    );
    const second = (await secondResponse.json()) as {
      items: { selector: string }[];
      nextCursor: string | null;
    };
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    const firstSelectors = new Set(first.items.map((item) => item.selector));
    expect(second.items.every((item) => !firstSelectors.has(item.selector))).toBe(true);
  });

  it('treats absent and foreign selectors identically without recording selector as subject', async () => {
    const administrator = await bootstrapAdministrator();
    const target = await registerReader('sessions-target@example.com');
    const other = await registerReader('sessions-other@example.com');
    await insertReaderSession({
      id: 'foreign-reader-session',
      token: 'foreign-reader-token',
      userId: other.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const foreignPage = await request(`/v1/admin/users/${other.id}/sessions`, 'GET', {
      cookie: administrator,
    });
    const foreign = (await foreignPage.json()) as { items: { selector: string }[] };
    const foreignSelector = foreign.items[0]?.selector;
    if (foreignSelector === undefined) throw new Error('Expected a foreign session selector.');
    await workerEnv.DB.prepare('DELETE FROM session WHERE user_id=?').bind(target.id).run();
    await insertReaderSession({
      id: 'removed-target-session',
      token: 'removed-target-token',
      userId: target.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const targetPage = await request(`/v1/admin/users/${target.id}/sessions`, 'GET', {
      cookie: administrator,
    });
    const removedSessionSelector = ((await targetPage.json()) as { items: { selector: string }[] })
      .items[0]?.selector;
    if (removedSessionSelector === undefined) throw new Error('Expected target session selector.');
    await workerEnv.DB.prepare('DELETE FROM session WHERE id=?')
      .bind('removed-target-session')
      .run();
    const absent = await request(
      `/v1/admin/users/${target.id}/sessions/${removedSessionSelector}`,
      'DELETE',
      { cookie: administrator },
    );
    const foreignAttempt = await request(
      `/v1/admin/users/${target.id}/sessions/${foreignSelector}`,
      'DELETE',
      { cookie: administrator },
    );
    expect(absent.status).toBe(200);
    expect(foreignAttempt.status).toBe(200);
    expect(await absent.json()).toMatchObject({ changed: false });
    expect(await foreignAttempt.json()).toMatchObject({ changed: false });
    const rows = await workerEnv.DB.prepare(
      `SELECT subject_id, metadata FROM identity_event WHERE type='session-revoke-attempt' ORDER BY occurred_at`,
    ).all<{ subject_id: string | null; metadata: string | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results.every((row) => row.subject_id === target.id)).toBe(true);
    expect(rows.results.map((row) => row.metadata).join(' ')).not.toContain(foreignSelector);
  });

  it('rejects tampered and secret-rotated selectors as indistinguishable no-ops', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-selector-rotation@example.com');
    await insertReaderSession({
      id: 'selector-rotation-session',
      token: 'selector-rotation-token',
      userId: reader.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const listed = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
      cookie: administrator,
    });
    const selector = ((await listed.json()) as { items: { selector: string }[] }).items[0]
      ?.selector;
    if (selector === undefined) throw new Error('Expected an encrypted selector.');
    expect(selector).not.toContain('selector-rotation-session');

    const tampered = `${selector.slice(0, 3)}${selector[3] === 'A' ? 'B' : 'A'}${selector.slice(4)}`;
    const tamperedResponse = await request(
      `/v1/admin/users/${reader.id}/sessions/${tampered}`,
      'DELETE',
      { cookie: administrator },
    );
    expect(tamperedResponse.status).toBe(200);
    expect(await tamperedResponse.json()).toMatchObject({ changed: false });

    const rotatedAdminLogin = await request('/v1/admin/auth/login', 'POST', {
      body: { email: 'sessions-admin@example.com', password: 'Correct-horse-41' },
      secret: 'test-selector-secret-v2',
    });
    expect(rotatedAdminLogin.status).toBe(200);
    const rotatedCookie = cookieFrom(rotatedAdminLogin);
    const rotatedResponse = await request(
      `/v1/admin/users/${reader.id}/sessions/${selector}`,
      'DELETE',
      { cookie: rotatedCookie, secret: 'test-selector-secret-v2' },
    );
    expect(rotatedResponse.status).toBe(200);
    expect(await rotatedResponse.json()).toMatchObject({ changed: false });
    expect(
      await workerEnv.DB.prepare('SELECT count(*) AS total FROM session WHERE id=?')
        .bind('selector-rotation-session')
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });
    expect(await eventCount('session-revoked', reader.id)).toBe(0);
  });

  it('revokes all Reader sessions with one count-bearing lifecycle event, and makes zero a no-op', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-all@example.com');
    const issuedState = await request('/v1/auth/reader-state', 'POST', {
      cookie: reader.cookie,
      body: {},
    });
    expect(issuedState.status).toBe(200);
    const now = Date.now();
    await insertReaderSession({
      id: 'bulk-expired-session',
      token: 'bulk-expired-token',
      userId: reader.id,
      createdAt: now - 120_000,
      updatedAt: now - 120_000,
      expiresAt: now - 60_000,
    });
    for (const id of ['bulk-session-a', 'bulk-session-b']) {
      await insertReaderSession({
        id,
        token: `${id}-token`,
        userId: reader.id,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + 60_000,
      });
    }
    const response = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: administrator,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as { state: string; changed: boolean; revision: number };
    expect(body.state).toBe('active');
    expect(body.changed).toBe(true);
    expect(body.revision).toBeGreaterThanOrEqual(1);
    expect(await eventCount('sessions-revoked', reader.id)).toBe(1);
    expect(
      await workerEnv.DB.prepare('SELECT count(*) AS total FROM session WHERE id=?')
        .bind('bulk-expired-session')
        .first<{ total: number }>(),
    ).toEqual({ total: 1 });
    expect(
      (await request('/v1/auth/reader-state', 'POST', { cookie: reader.cookie, body: {} })).status,
    ).toBe(401);
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);
    const lifecycle = await workerEnv.DB.prepare(
      `SELECT metadata FROM identity_event WHERE type='sessions-revoked' AND subject_id=?`,
    )
      .bind(reader.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(lifecycle?.metadata ?? '{}')).toMatchObject({ count: 3, revision: 1 });

    const activity = await request(`/v1/admin/users/${reader.id}/activity`, 'GET', {
      cookie: administrator,
    });
    expect(activity.status).toBe(200);
    const activityBody = (await activity.json()) as {
      items: { type: string; occurredAt: string }[];
    };
    expect(activityBody).toMatchObject({
      items: [
        expect.objectContaining({ type: 'sessions-revoked', metadata: { count: 3, revision: 1 } }),
      ],
    });
    const activityEvent = activityBody.items.find((item) => item.type === 'sessions-revoked');
    if (activityEvent === undefined) throw new Error('Expected revoke-all activity.');
    expectEventTimeNearNow(activityEvent.occurredAt);
    const audit = await request('/v1/admin/audit-events?action=sessions-revoked', 'GET', {
      cookie: administrator,
    });
    expect(audit.status).toBe(200);
    const auditText = await audit.text();
    expect(auditText).toContain('"count":3');
    const auditBody = JSON.parse(auditText) as {
      items: { type: string; occurredAt: string }[];
    };
    const auditEvent = auditBody.items.find((item) => item.type === 'sessions-revoked');
    if (auditEvent === undefined) throw new Error('Expected revoke-all audit.');
    expectEventTimeNearNow(auditEvent.occurredAt);

    const attemptAudit = await request(
      '/v1/admin/audit-events?action=sessions-revoke-attempt',
      'GET',
      { cookie: administrator },
    );
    expect(attemptAudit.status).toBe(200);
    expect(await attemptAudit.json()).toMatchObject({
      items: [
        expect.objectContaining({
          type: 'sessions-revoke-attempt',
          metadata: { changed: true, count: 3, revision: 1 },
        }),
      ],
    });

    const noOp = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: administrator,
    });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toMatchObject({ changed: false });
    expect(await eventCount('sessions-revoked', reader.id)).toBe(1);
  });

  it('keeps session management available for disabled Readers without duplicate workflow events', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-disabled-reader@example.com');
    const disabled = await request(`/v1/admin/users/${reader.id}/access`, 'PUT', {
      cookie: administrator,
      headers: { 'if-match': '"1"' },
      body: { state: 'disabled' },
    });
    expect(disabled.status).toBe(200);
    expect(await eventCount('sessions-revoked', reader.id)).toBe(0);
    await insertReaderSession({
      id: 'disabled-reader-session',
      token: 'disabled-reader-session-token',
      userId: reader.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    const listed = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
      cookie: administrator,
    });
    expect(listed.status).toBe(200);
    const listedBody = (await listed.json()) as { items: { selector: string }[] };
    expect(listedBody.items).toHaveLength(1);
    expect(listedBody.items[0]?.selector).toMatch(/^s1_[A-Za-z0-9_-]{39,208}$/);
    const revoked = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: administrator,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toMatchObject({ state: 'disabled', changed: true });
    expect(await eventCount('sessions-revoked', reader.id)).toBe(1);
  });

  it('authorizes before target lookup and marks every problem response no-store', async () => {
    const anonymous = await request('/v1/admin/users/missing-reader/sessions', 'GET');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    const admin = await bootstrapAdministrator();
    const reader = await registerReader('sessions-auth@example.com');
    const readerRealm = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
      cookie: reader.cookie,
    });
    expect(readerRealm.status).toBe(403);
    expect(readerRealm.headers.get('cache-control')).toBe('private, no-store');
    const anonymousMutation = await request('/v1/admin/users/missing-reader/sessions', 'DELETE');
    expect(anonymousMutation.status).toBe(401);
    expect(anonymousMutation.headers.get('cache-control')).toBe('private, no-store');
    const readerMutation = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: reader.cookie,
    });
    expect(readerMutation.status).toBe(403);
    expect(readerMutation.headers.get('cache-control')).toBe('private, no-store');
    const adminId = await workerEnv.DB.prepare(
      `SELECT id FROM admin_user WHERE email='sessions-admin@example.com'`,
    ).first<{ id: string }>();
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state(user_id,state,revision,updated_at) VALUES(?,'disabled',1,?)`,
    )
      .bind(adminId?.id, Date.now())
      .run();
    const disabled = await request('/v1/admin/users/missing-reader/sessions', 'GET', {
      cookie: admin,
    });
    expect(disabled.status).toBe(403);
    expect(disabled.headers.get('cache-control')).toBe('private, no-store');
    expect(await disabled.json()).toMatchObject({ code: 'administrator-disabled' });
    const disabledMutation = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: admin,
    });
    expect(disabledMutation.status).toBe(403);
    expect(disabledMutation.headers.get('cache-control')).toBe('private, no-store');
    expect(await disabledMutation.json()).toMatchObject({ code: 'administrator-disabled' });
    const disabledAttempt = await workerEnv.DB.prepare(
      `SELECT result, problem_code, subject_id FROM identity_event
       WHERE actor_id=? AND type='sessions-revoke-attempt' ORDER BY occurred_at DESC LIMIT 1`,
    )
      .bind(adminId?.id)
      .first<{ result: string; problem_code: string | null; subject_id: string | null }>();
    expect(disabledAttempt).toEqual({
      result: 'failure',
      problem_code: 'administrator-disabled',
      subject_id: null,
    });
  });

  it('rejects invalid cursors and limits and returns reader-not-found only after authorization', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-invalid-query@example.com');
    const invalidCursor = await request(
      `/v1/admin/users/${reader.id}/sessions?cursor=not-a-cursor`,
      'GET',
      { cookie: administrator },
    );
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.headers.get('cache-control')).toBe('private, no-store');
    const invalidLimit = await request(`/v1/admin/users/${reader.id}/sessions?limit=51`, 'GET', {
      cookie: administrator,
    });
    expect(invalidLimit.status).toBe(400);
    expect(invalidLimit.headers.get('cache-control')).toBe('private, no-store');
    const missingMutation = await request('/v1/admin/users/missing-reader/sessions', 'DELETE', {
      cookie: administrator,
    });
    expect(missingMutation.status).toBe(404);
    expect(missingMutation.headers.get('cache-control')).toBe('private, no-store');
    const missing = await request('/v1/admin/users/missing-reader/sessions', 'GET', {
      cookie: administrator,
    });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBe('private, no-store');
    expect(await missing.json()).toMatchObject({ code: 'reader-not-found' });
  });

  it('rolls back session deletion and lifecycle event if audit persistence fails', async () => {
    const administrator = await bootstrapAdministrator();
    const reader = await registerReader('sessions-audit-failure@example.com');
    await insertReaderSession({
      id: 'audit-failure-session',
      token: 'audit-failure-token',
      userId: reader.id,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER fail_session_admin_audit BEFORE INSERT ON identity_event
       WHEN NEW.type='session-revoke-attempt' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`,
    ).run();
    try {
      const listing = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
        cookie: administrator,
      });
      const page = (await listing.json()) as { items: { selector: string }[] };
      const selector = page.items[0]?.selector;
      if (selector === undefined) throw new Error('Expected a session selector.');
      const response = await request(
        `/v1/admin/users/${reader.id}/sessions/${selector}`,
        'DELETE',
        { cookie: administrator },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const remains = await workerEnv.DB.prepare('SELECT count(*) AS total FROM session WHERE id=?')
        .bind('audit-failure-session')
        .first<{ total: number }>();
      expect(remains?.total).toBe(1);
      expect(await eventCount('session-revoked', reader.id)).toBe(0);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_session_admin_audit').run();
    }
  });
});
