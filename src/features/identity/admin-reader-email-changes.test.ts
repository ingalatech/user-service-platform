import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { AdminReaderDetailSchema } from './contract.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

function testEnv(db: Env['DB'] = workerEnv.DB): Env {
  return {
    DB: db,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
}

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
let failScheduling = false;
const executionContext = {
  waitUntil: () => {
    if (failScheduling) throw new Error('scheduler unavailable');
  },
  passThroughOnException: () => undefined,
  props: {},
};

async function post(
  path: string,
  body: unknown,
  cookie?: string,
  headers: Record<string, string> = {},
) {
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
    executionContext,
  );
}

async function get(path: string, cookie?: string) {
  return app.request(
    path,
    { method: 'GET', headers: cookie === undefined ? {} : { cookie } },
    testEnv(),
    executionContext,
  );
}

async function del(
  path: string,
  cookie: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return app.request(
    path,
    { method: 'DELETE', headers: { cookie, ...headers } },
    testEnv(),
    executionContext,
  );
}

function sessionCookieFrom(response: Response): string {
  const pair = response.headers.get('set-cookie')?.split(';')[0]?.trim();
  if (pair === undefined || pair.length === 0) throw new Error('Expected a session cookie.');
  return pair;
}

function verificationToken(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected a verification message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  return token;
}

async function bootstrapAdministrator(): Promise<string> {
  expect(
    (
      await post('/v1/admin/auth/bootstrap', {
        name: 'Email Change Admin',
        email: 'email-change-admin@example.com',
        password: 'Correct-horse-41',
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await post('/v1/admin/auth/request-verification', {
        email: 'email-change-admin@example.com',
      })
    ).status,
  ).toBe(202);
  expect((await post('/v1/admin/auth/verify-email', { token: verificationToken() })).status).toBe(
    200,
  );
  const login = await post('/v1/admin/auth/login', {
    email: 'email-change-admin@example.com',
    password: 'Correct-horse-41',
  });
  expect(login.status).toBe(200);
  return sessionCookieFrom(login);
}

async function registerVerifiedReader(email = 'original-reader@example.com'): Promise<{
  id: string;
  cookie: string;
}> {
  const registration = await post('/v1/auth/register', {
    name: 'Original Reader',
    email,
    password: 'Correct-horse-42',
  });
  expect(registration.status).toBe(201);
  const body = (await registration.json()) as { id: string };
  expect((await post('/v1/auth/request-verification', { email })).status).toBe(202);
  expect((await post('/v1/auth/verify-email', { token: verificationToken() })).status).toBe(200);
  const login = await post('/v1/auth/login', { email, password: 'Correct-horse-42' });
  expect(login.status).toBe(200);
  return { id: body.id, cookie: sessionCookieFrom(login) };
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM identity_event'),
    db.prepare('DELETE FROM identity_reservation'),
    db.prepare('DELETE FROM reader_email_change_workflow'),
    db.prepare('DELETE FROM admin_idempotency_record'),
    db.prepare('DELETE FROM reader_message_workflow'),
    db.prepare('DELETE FROM administrator_message_workflow'),
    db.prepare('DELETE FROM reader_access_state'),
    db.prepare('DELETE FROM administrator_access_state'),
    db.prepare('DELETE FROM admin_session'),
    db.prepare('DELETE FROM admin_account'),
    db.prepare('DELETE FROM admin_verification'),
    db.prepare('DELETE FROM admin_email_verification_token'),
    db.prepare('DELETE FROM admin_user'),
    db.prepare('DELETE FROM admin_bootstrap_attempt'),
    db.prepare('DELETE FROM admin_bootstrap_guard'),
    db.prepare('DELETE FROM session'),
    db.prepare('DELETE FROM account'),
    db.prepare('DELETE FROM verification'),
    db.prepare('DELETE FROM email_verification_token'),
    db.prepare('DELETE FROM user'),
  ]);
  failScheduling = false;
  mailer.clear();
});

describe('Reader administrative email-change workflow', () => {
  it('fails safely upgrading prior-schema cross-realm reservation collisions without stealing either claim', async () => {
    const db = workerEnv.DB;
    const migration = testMigrations.find(({ name }) => name.includes('0021_'));
    if (migration === undefined) throw new Error('Expected the squashed #273 migration.');
    const upgradeMigrationTable = 'email_change_upgrade_migrations';
    await db.prepare(`DROP TABLE IF EXISTS ${upgradeMigrationTable}`).run();
    await db.prepare('DROP TABLE reader_email_change_workflow').run();
    await db.prepare('DROP TRIGGER IF EXISTS reader_email_reservation_guard').run();
    await db.prepare('DROP INDEX identity_reservation_global_value_idx').run();
    await db
      .prepare(
        `CREATE UNIQUE INDEX identity_reservation_scope_value_idx
         ON identity_reservation (kind, realm, normalized_value)`,
      )
      .run();
    await db.batch([
      db
        .prepare(
          `INSERT INTO identity_reservation
         (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
         VALUES ('upgrade-reader-claim', 'email', 'reader', 'upgrade-collision@example.com',
           'reader-owner', 'reader-workflow', ?, ?)`,
        )
        .bind(Date.now(), Date.now() + 60_000),
      db
        .prepare(
          `INSERT INTO identity_reservation
         (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
         VALUES ('upgrade-admin-claim', 'email', 'administrator', 'upgrade-collision@example.com',
           'admin-owner', 'admin-workflow', ?, ?)`,
        )
        .bind(Date.now(), Date.now() + 60_000),
    ]);

    await expect(applyD1Migrations(db, [migration], upgradeMigrationTable)).rejects.toThrow();
    expect(
      await db
        .prepare(
          `SELECT id, realm, subject_id FROM identity_reservation
           WHERE normalized_value = 'upgrade-collision@example.com' ORDER BY realm`,
        )
        .all<{ id: string; realm: string; subject_id: string }>(),
    ).toMatchObject({
      results: [
        { id: 'upgrade-admin-claim', realm: 'administrator', subject_id: 'admin-owner' },
        { id: 'upgrade-reader-claim', realm: 'reader', subject_id: 'reader-owner' },
      ],
    });

    expect(
      await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index'
           AND name = 'identity_reservation_scope_value_idx'`,
        )
        .first<{ name: string }>(),
    ).toEqual({ name: 'identity_reservation_scope_value_idx' });
    expect(
      await db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table'
           AND name = 'reader_email_change_workflow'`,
        )
        .first<{ name: string }>(),
    ).toBeNull();

    // An operator explicitly resolves both claims; retrying the migration then
    // installs the global invariant without changing the surviving reservation.
    await db.prepare("DELETE FROM identity_reservation WHERE id = 'upgrade-admin-claim'").run();
    await applyD1Migrations(db, [migration], upgradeMigrationTable);
    expect(
      await db
        .prepare(
          `SELECT id, realm, subject_id FROM identity_reservation
           WHERE normalized_value = 'upgrade-collision@example.com'`,
        )
        .first<{ id: string; realm: string; subject_id: string }>(),
    ).toEqual({ id: 'upgrade-reader-claim', realm: 'reader', subject_id: 'reader-owner' });
    await db.prepare(`DROP TABLE ${upgradeMigrationTable}`).run();
  });

  it('creates a reserved pending workflow while retaining the canonical email until verification', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader();
    const readerId = reader.id;
    const detail = await get(`/v1/admin/users/${readerId}`, administratorCookie);
    expect(detail.status).toBe(200);
    const etag = detail.headers.get('etag');
    expect(etag).toBe('"1"');
    const workflowRevisionDefault = await workerEnv.DB.prepare(
      `SELECT dflt_value FROM pragma_table_info('reader_email_change_workflow')
       WHERE name = 'revision'`,
    ).first<{ dflt_value: string | null }>();
    expect(workflowRevisionDefault?.dflt_value).toBe('1');

    const created = await post(
      `/v1/admin/users/${readerId}/email-changes`,
      { email: 'new-reader@example.com' },
      administratorCookie,
      { 'if-match': etag ?? '', 'idempotency-key': 'email-change-create-1' },
    );

    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('private, no-store');
    const body = (await created.json()) as { workflowId: string; state: string; email: string };
    expect(body).toMatchObject({ state: 'pending', email: 'new-reader@example.com' });
    expect(JSON.stringify(body)).not.toMatch(/token|actionurl|password|body/i);
    const readerRow = await workerEnv.DB.prepare(
      'SELECT email, email_verified FROM user WHERE id = ?',
    )
      .bind(readerId)
      .first<{ email: string; email_verified: number }>();
    expect(readerRow).toEqual({ email: 'original-reader@example.com', email_verified: 1 });
    expect(mailer.sent.some((message) => message.to === 'new-reader@example.com')).toBe(true);
    expect(
      mailer.emailChangeMessages.some((message) => message.to === 'original-reader@example.com'),
    ).toBe(true);
    const detailAfterCreate = await get(`/v1/admin/users/${readerId}`, administratorCookie);
    expect(detailAfterCreate.status).toBe(200);
    const detailBody = (await detailAfterCreate.json()) as {
      activeWorkflows: {
        id: string;
        type: string;
        email?: string;
        expiresAt?: string;
        revision?: number;
      }[];
    };
    expect(detailBody.activeWorkflows).toContainEqual(
      expect.objectContaining({
        id: body.workflowId,
        type: 'email-change',
        email: 'new-reader@example.com',
        state: 'pending',
        revision: 1,
      }),
    );
    expect(typeof detailBody.activeWorkflows[0]?.expiresAt).toBe('string');
    const ledger = await workerEnv.DB.prepare(
      `SELECT type, result, metadata FROM identity_event WHERE subject_id = ?`,
    )
      .bind(readerId)
      .all<{ type: string; result: string; metadata: string | null }>();
    expect(ledger.results.map((event) => [event.type, event.result])).toEqual([
      ['email-change-requested', 'success'],
      ['email-change-attempt', 'success'],
    ]);
    expect(JSON.stringify(ledger.results)).not.toContain('@example.com');
  });

  it('requires account ETags, replays idempotently, and replaces workflows with token rotation', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader();
    const first = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'first-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'email-change-first' },
    );
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { workflowId: string; accountRevision: number };
    expect(firstBody.accountRevision).toBe(2);
    const oldToken = mailer.sent.at(-1)?.token;
    if (oldToken === undefined) throw new Error('Expected an initial email-change token.');

    const replay = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'first-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'email-change-first' },
    );
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(firstBody);

    const reused = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'different-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'email-change-first' },
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: 'idempotency-key-reused' });

    const replaced = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'second-new@example.com' },
      administratorCookie,
      { 'if-match': '"2"', 'idempotency-key': 'email-change-second' },
    );
    expect(replaced.status).toBe(200);
    const replacement = (await replaced.json()) as { workflowId: string; email: string };
    expect(replacement.email).toBe('second-new@example.com');
    expect(replacement.workflowId).not.toBe(firstBody.workflowId);
    const currentToken = mailer.sent.at(-1)?.token;
    if (currentToken === undefined) throw new Error('Expected a replacement email-change token.');
    expect(currentToken).not.toBe(oldToken);
    const oldWorkflow = await workerEnv.DB.prepare(
      'SELECT state FROM reader_email_change_workflow WHERE id = ?',
    )
      .bind(firstBody.workflowId)
      .first<{ state: string }>();
    expect(oldWorkflow).toEqual({ state: 'superseded' });
    const reservations = await workerEnv.DB.prepare(
      `SELECT normalized_value FROM identity_reservation
       WHERE subject_id = ? AND kind = 'email' AND realm = 'reader'`,
    )
      .bind(reader.id)
      .all<{ normalized_value: string }>();
    expect(reservations.results).toEqual([{ normalized_value: 'second-new@example.com' }]);

    const staleToken = await post('/v1/auth/verify-email', { token: oldToken });
    expect(staleToken.status).toBe(400);
    expect(staleToken.headers.get('cache-control')).toBe('no-store');
    expect(await staleToken.json()).toMatchObject({ code: 'verification-invalid' });
    const secondSession = await post('/v1/auth/login', {
      email: 'original-reader@example.com',
      password: 'Correct-horse-42',
    });
    expect(secondSession.status).toBe(200);
    const now = Date.now();
    const creatorId = await workerEnv.DB.prepare(
      'SELECT creator_id FROM reader_email_change_workflow WHERE id = ?',
    )
      .bind(replacement.workflowId)
      .first<{ creator_id: string }>();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO reader_message_workflow
         (id, user_id, kind, state, cooldown_until, created_at, updated_at)
         VALUES ('pending-recovery-before-email-change', ?, 'password-recovery', 'scheduled', ?, ?, ?)`,
      ).bind(reader.id, now + 60_000, now, now),
      workerEnv.DB.prepare(
        `UPDATE email_verification_token
         SET token_digest = 'old-verification-digest', expires_at = ?, issued_at = ?, consumed_at = NULL
         WHERE target_email = 'original-reader@example.com'`,
      ).bind(now + 60_000, now),
      workerEnv.DB.prepare(
        `INSERT INTO verification (id, identifier, value, expires_at, created_at, updated_at)
         VALUES ('old-verification-row', 'original-reader@example.com', 'stale', ?, ?, ?)`,
      ).bind(now + 60_000, now, now),
      workerEnv.DB.prepare(
        `INSERT INTO admin_idempotency_record
         (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
          response_body, retry_payload, created_at, expires_at)
         VALUES
         ('pending-verify-retry', ?, 'pending-verify-retry', 'POST',
          '/v1/admin/users/:userId/email-verification/messages', ?, 'hash', 503, '{}', 'sealed-retry', ?, ?),
         ('pending-recovery-retry', ?, 'pending-recovery-retry', 'POST',
          '/v1/admin/users/:userId/password-recovery/messages', ?, 'hash', 503, '{}', 'sealed-retry', ?, ?),
         ('pending-create-retry', ?, 'pending-create-retry', 'POST',
          '/v1/admin/users/:userId/email-changes', ?, 'hash', 503, '{}', 'sealed-retry', ?, ?),
         ('pending-resend-retry', ?, 'pending-resend-retry', 'POST',
          '/v1/admin/users/:userId/email-changes/:emailChangeId/messages', ?, 'hash', 503, '{}', 'sealed-retry', ?, ?)`,
      ).bind(
        creatorId?.creator_id,
        reader.id,
        now,
        now + 86_400_000,
        creatorId?.creator_id,
        reader.id,
        now,
        now + 86_400_000,
        creatorId?.creator_id,
        reader.id,
        now,
        now + 86_400_000,
        creatorId?.creator_id,
        replacement.workflowId,
        now,
        now + 86_400_000,
      ),
    ]);
    const completion = await post('/v1/auth/verify-email', { token: currentToken });
    expect(completion.status).toBe(200);
    expect(completion.headers.get('cache-control')).toBe('no-store');
    expect(await completion.json()).toEqual({ emailVerified: true });
    const readerAfterCompletion = await workerEnv.DB.prepare(
      'SELECT email, email_verified FROM user WHERE id = ?',
    )
      .bind(reader.id)
      .first<{ email: string; email_verified: number }>();
    expect(readerAfterCompletion).toEqual({ email: 'second-new@example.com', email_verified: 1 });
    const completedDetail = await get(`/v1/admin/users/${reader.id}`, administratorCookie);
    expect(completedDetail.status).toBe(200);
    const completedDetailRaw: unknown = await completedDetail.json();
    const parsedCompletedDetail = AdminReaderDetailSchema.safeParse(completedDetailRaw);
    expect(parsedCompletedDetail.success).toBe(true);
    if (!parsedCompletedDetail.success)
      throw new Error('Expected a valid Reader detail projection.');
    const completedDetailBody = parsedCompletedDetail.data;
    const updatedAt = Date.parse(completedDetailBody.summary.updatedAt);
    expect(updatedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(updatedAt).toBeLessThanOrEqual(Date.now());
    expect((await get('/v1/me', reader.cookie)).status).toBe(401);
    const secondCookie = sessionCookieFrom(secondSession);
    expect((await get('/v1/me', secondCookie)).status).toBe(401);
    const completedWorkflow = await workerEnv.DB.prepare(
      'SELECT state, creator_id FROM reader_email_change_workflow WHERE id = ?',
    )
      .bind(replacement.workflowId)
      .first<{ state: string; creator_id: string }>();
    expect(completedWorkflow?.state).toBe('completed');
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM identity_reservation WHERE subject_id = ?`,
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const emailChanged = await workerEnv.DB.prepare(
      `SELECT count(*) AS count FROM identity_event
       WHERE type = 'email-changed' AND subject_id = ? AND actor_id = ?`,
    )
      .bind(reader.id, completedWorkflow?.creator_id ?? '')
      .first<{ count: number }>();
    expect(emailChanged?.count).toBe(1);
    expect(
      await workerEnv.DB.prepare(
        'SELECT count(*) AS count FROM reader_message_workflow WHERE user_id = ?',
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM email_verification_token
         WHERE target_email IN ('original-reader@example.com', 'second-new@example.com')`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const retries = await workerEnv.DB.prepare(
      `SELECT expires_at, retry_payload FROM admin_idempotency_record
       WHERE key LIKE 'pending-%-retry'`,
    ).all<{ expires_at: number; retry_payload: string | null }>();
    expect(retries.results).toHaveLength(4);
    expect(
      retries.results.every((row) => row.expires_at <= Date.now() && row.retry_payload === null),
    ).toBe(true);
    const terminalCancel = await del(
      `/v1/admin/users/${reader.id}/email-changes/${replacement.workflowId}`,
      administratorCookie,
      { 'if-match': '"2"', 'idempotency-key': 'cancel-completed-email-change' },
    );
    expect(terminalCancel.status).toBe(409);
    expect(await terminalCancel.json()).toMatchObject({ code: 'invalid-transition' });
  });

  it('distinguishes missing and stale account ETags and reserves normalized addresses globally', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const first = await registerVerifiedReader('first-reader@example.com');
    const second = await registerVerifiedReader('second-reader@example.com');
    const firstPath = `/v1/admin/users/${first.id}/email-changes`;
    const secondPath = `/v1/admin/users/${second.id}/email-changes`;

    const missing = await post(firstPath, { email: 'shared@example.com' }, administratorCookie, {
      'idempotency-key': 'missing-account-etag',
    });
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: 'precondition-required' });
    const malformed = await post(firstPath, { email: 'shared@example.com' }, administratorCookie, {
      'if-match': 'W/"1"',
      'idempotency-key': 'malformed-account-etag',
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: 'bad-request' });
    const stale = await post(firstPath, { email: 'shared@example.com' }, administratorCookie, {
      'if-match': '"9"',
      'idempotency-key': 'stale-account-etag',
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision' });

    const reserved = await post(firstPath, { email: 'Shared@Example.com' }, administratorCookie, {
      'if-match': '"1"',
      'idempotency-key': 'reserve-shared-email',
    });
    expect(reserved.status).toBe(201);
    const normalizedConflict = await post(
      secondPath,
      { email: 'shared@example.COM' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'conflict-shared-email' },
    );
    expect(normalizedConflict.status).toBe(409);
    expect(await normalizedConflict.json()).toMatchObject({ code: 'email-conflict' });
    const sameCanonical = await post(
      firstPath,
      { email: 'FIRST-READER@example.com' },
      administratorCookie,
      { 'if-match': '"2"', 'idempotency-key': 'same-canonical-email' },
    );
    expect(sameCanonical.status).toBe(409);
    expect(await sameCanonical.json()).toMatchObject({ code: 'same-email' });
  });

  it('rejects Administrator canonical emails and pending reservations for Reader email changes', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('global-reservation-reader@example.com');
    const path = `/v1/admin/users/${reader.id}/email-changes`;
    const adminCanonical = await post(
      path,
      { email: 'email-change-admin@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'admin-canonical-conflict' },
    );
    expect(adminCanonical.status).toBe(409);
    expect(adminCanonical.headers.get('cache-control')).toBe('private, no-store');
    expect(await adminCanonical.clone().text()).not.toContain('email-change-admin@example.com');
    expect(await adminCanonical.json()).toMatchObject({ code: 'email-conflict' });

    await workerEnv.DB.prepare(
      `INSERT INTO identity_reservation
       (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
       VALUES ('admin-realm-pending-reservation', 'email', 'administrator', ?, 'admin-subject',
         'admin-workflow', ?, ?)`,
    )
      .bind('pending-admin@example.com', Date.now(), Date.now() + 60_000)
      .run();
    const pendingAdminConflict = await post(
      path,
      { email: 'pending-admin@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'admin-pending-conflict' },
    );
    expect(pendingAdminConflict.status).toBe(409);
    expect(await pendingAdminConflict.json()).toMatchObject({ code: 'email-conflict' });
    await expect(
      workerEnv.DB.prepare(
        `INSERT INTO identity_reservation
         (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
         VALUES ('duplicate-global-reservation', 'email', 'reader', ?, 'reader-other',
           'reader-workflow', ?, ?)`,
      )
        .bind('pending-admin@example.com', Date.now(), Date.now() + 60_000)
        .run(),
    ).rejects.toThrow();
  });

  it('does not commit a Reader workflow when an Administrator reservation wins the race', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('cross-realm-race-reader@example.com');
    let injectedReservation = false;
    const racingDatabase = new Proxy(workerEnv.DB, {
      get(database, property) {
        if (property === 'batch') {
          return async (statements: Parameters<Env['DB']['batch']>[0]) => {
            if (!injectedReservation) {
              injectedReservation = true;
              await workerEnv.DB.prepare(
                `INSERT INTO identity_reservation
                 (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
                 VALUES ('cross-realm-race-winner', 'email', 'administrator', ?, 'admin-race',
                   'admin-race-workflow', ?, ?)`,
              )
                .bind('race-admin-pending@example.com', Date.now(), Date.now() + 60_000)
                .run();
            }
            return workerEnv.DB.batch(statements);
          };
        }
        const value: unknown = Reflect.get(database, property, database);
        if (typeof value === 'function') {
          const bound: unknown = value.bind(database);
          return bound;
        }
        return value;
      },
    });
    const response = await app.request(
      `/v1/admin/users/${reader.id}/email-changes`,
      {
        method: 'POST',
        headers: {
          cookie: administratorCookie,
          'content-type': 'application/json',
          'if-match': '"1"',
          'idempotency-key': 'cross-realm-pending-race',
        },
        body: JSON.stringify({ email: 'race-admin-pending@example.com' }),
      },
      testEnv(racingDatabase),
      executionContext,
    );
    expect(injectedReservation).toBe(true);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'email-conflict' });
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_email_change_workflow
         WHERE user_id = ? AND state = 'pending'`,
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await workerEnv.DB.prepare('SELECT revision FROM reader_access_state WHERE user_id = ?')
        .bind(reader.id)
        .first<{ revision: number }>(),
    ).toEqual({ revision: 1 });
  });

  it('rejects anonymous and Reader actors before looking up the target', async () => {
    const reader = await registerVerifiedReader('authorization-order-reader@example.com');
    const path = `/v1/admin/users/missing-reader/email-changes`;
    const anonymous = await post(path, { email: 'new@example.com' }, undefined, {
      'if-match': '"1"',
      'idempotency-key': 'anonymous-order',
    });
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });
    const readerActor = await post(path, { email: 'new@example.com' }, reader.cookie, {
      'if-match': '"1"',
      'idempotency-key': 'reader-order',
    });
    expect(readerActor.status).toBe(403);
    expect(await readerActor.json()).toMatchObject({ code: 'forbidden' });

    const administratorCookie = await bootstrapAdministrator();
    const adminId = await workerEnv.DB.prepare('SELECT id FROM admin_user LIMIT 1').first<{
      id: string;
    }>();
    if (adminId === null) throw new Error('Expected the bootstrapped Administrator.');
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = 'disabled', revision = 2, updated_at = excluded.updated_at`,
    )
      .bind(adminId.id, Date.now())
      .run();
    expect(
      await workerEnv.DB.prepare('SELECT state FROM administrator_access_state WHERE user_id = ?')
        .bind(adminId.id)
        .first<{ state: string }>(),
    ).toEqual({ state: 'disabled' });
    const disabledActor = await post(path, { email: 'new@example.com' }, administratorCookie, {
      'if-match': '"1"',
      'idempotency-key': 'disabled-order',
    });
    expect(disabledActor.status).toBe(403);
    expect(await disabledActor.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('rejects email changes on disabled and deletion-suspended Readers', async () => {
    const administratorCookie = await bootstrapAdministrator();
    for (const state of ['disabled', 'suspended'] as const) {
      const reader = await registerVerifiedReader(`${state}-reader@example.com`);
      await workerEnv.DB.prepare(
        `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
         VALUES (?, ?, 2, ?)`,
      )
        .bind(reader.id, state, Date.now())
        .run();
      const response = await post(
        `/v1/admin/users/${reader.id}/email-changes`,
        { email: `${state}-new@example.com` },
        administratorCookie,
        { 'if-match': '"2"', 'idempotency-key': `${state}-email-change` },
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: 'invalid-transition' });
    }
  });

  it('serializes concurrent global reservations and concurrent changes for one Reader', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const first = await registerVerifiedReader('race-first@example.com');
    const second = await registerVerifiedReader('race-second@example.com');
    const reservationRace = await Promise.all([
      post(
        `/v1/admin/users/${first.id}/email-changes`,
        { email: 'race-shared@example.com' },
        administratorCookie,
        { 'if-match': '"1"', 'idempotency-key': 'race-global-a' },
      ),
      post(
        `/v1/admin/users/${second.id}/email-changes`,
        { email: 'RACE-SHARED@example.com' },
        administratorCookie,
        { 'if-match': '"1"', 'idempotency-key': 'race-global-b' },
      ),
    ]);
    expect(reservationRace.map((response) => response.status).sort()).toEqual([201, 409]);
    const sharedReservations = await workerEnv.DB.prepare(
      `SELECT count(*) AS count FROM identity_reservation
       WHERE kind = 'email' AND realm = 'reader' AND normalized_value = 'race-shared@example.com'`,
    ).first<{ count: number }>();
    expect(sharedReservations?.count).toBe(1);

    const sameReader = await registerVerifiedReader('race-same-reader@example.com');
    const sameReaderRace = await Promise.all([
      post(
        `/v1/admin/users/${sameReader.id}/email-changes`,
        { email: 'race-same-a@example.com' },
        administratorCookie,
        { 'if-match': '"1"', 'idempotency-key': 'race-same-a' },
      ),
      post(
        `/v1/admin/users/${sameReader.id}/email-changes`,
        { email: 'race-same-b@example.com' },
        administratorCookie,
        { 'if-match': '"1"', 'idempotency-key': 'race-same-b' },
      ),
    ]);
    expect(sameReaderRace.map((response) => response.status).sort()).toEqual([201, 412]);
    const pending = await workerEnv.DB.prepare(
      `SELECT count(*) AS count FROM reader_email_change_workflow
       WHERE user_id = ? AND state = 'pending'`,
    )
      .bind(sameReader.id)
      .first<{ count: number }>();
    expect(pending?.count).toBe(1);
  });

  it('fails closed when an authenticated email-change failure cannot be audited', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('audit-email-change@example.com');
    await workerEnv.DB.prepare(
      `CREATE TRIGGER fail_email_change_audit BEFORE INSERT ON identity_event
       WHEN NEW.type = 'email-change-attempt' AND NEW.result = 'failure'
       BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`,
    ).run();
    try {
      const response = await post(
        `/v1/admin/users/${reader.id}/email-changes`,
        { email: 'AUDIT-EMAIL-CHANGE@example.com' },
        administratorCookie,
        { 'if-match': '"1"', 'idempotency-key': 'same-email-audit-failure' },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_email_change_audit').run();
    }
  });

  it('cancels with the workflow ETag, reports no-op cancellation, and rejects terminal changes', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('cancel-reader@example.com');
    const created = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'cancel-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'cancel-create' },
    );
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as { workflowId: string };
    const path = `/v1/admin/users/${reader.id}/email-changes/${workflow.workflowId}`;

    const missing = await del(path, administratorCookie, {
      'idempotency-key': 'cancel-missing-etag',
    });
    expect(missing.status).toBe(428);
    const stale = await del(path, administratorCookie, {
      'if-match': '"9"',
      'idempotency-key': 'cancel-stale-etag',
    });
    expect(stale.status).toBe(412);
    const cancelled = await del(path, administratorCookie, {
      'if-match': '"1"',
      'idempotency-key': 'cancel-workflow-1',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({
      workflowId: workflow.workflowId,
      state: 'cancelled',
      changed: true,
      revision: 2,
    });
    const noOp = await del(path, administratorCookie, {
      'if-match': '"2"',
      'idempotency-key': 'cancel-workflow-2',
    });
    expect(noOp.status).toBe(200);
    expect(await noOp.json()).toEqual({
      workflowId: workflow.workflowId,
      state: 'cancelled',
      changed: false,
      revision: 2,
    });
    await workerEnv.DB.prepare('DELETE FROM user WHERE id = ?').bind(reader.id).run();
    const replayAfterTargetDeletion = await del(path, administratorCookie, {
      'if-match': '"1"',
      'idempotency-key': 'cancel-workflow-1',
    });
    expect(replayAfterTargetDeletion.status).toBe(200);
    expect(await replayAfterTargetDeletion.json()).toEqual({
      workflowId: workflow.workflowId,
      state: 'cancelled',
      changed: true,
      revision: 2,
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM identity_reservation WHERE workflow_id = ?`,
      )
        .bind(workflow.workflowId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('returns 412 to a concurrent cancellation that loses the workflow revision CAS', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('cancel-race-reader@example.com');
    const created = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'cancel-race-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'cancel-race-create' },
    );
    const workflow = (await created.json()) as { workflowId: string };
    const path = `/v1/admin/users/${reader.id}/email-changes/${workflow.workflowId}`;
    const results = await Promise.all([
      del(path, administratorCookie, {
        'if-match': '"1"',
        'idempotency-key': 'cancel-race-first',
      }),
      del(path, administratorCookie, {
        'if-match': '"1"',
        'idempotency-key': 'cancel-race-second',
      }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 412]);
    const loser = results.find((response) => response.status === 412);
    expect(loser).toBeDefined();
    expect(await loser?.json()).toMatchObject({ code: 'stale-revision' });
  });

  it('rejects a cancellation whose workflow CAS loses to a concurrent cancel', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('cancel-race-reader@example.com');
    const created = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'cancel-race-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'cancel-race-create' },
    );
    expect(created.status).toBe(201);
    const workflow = (await created.json()) as { workflowId: string };
    let injectedWinner = false;
    const racingDatabase = new Proxy(workerEnv.DB, {
      get(database, property) {
        if (property === 'batch') {
          return async (statements: Parameters<Env['DB']['batch']>[0]) => {
            if (!injectedWinner) {
              injectedWinner = true;
              await workerEnv.DB.prepare(
                `UPDATE reader_email_change_workflow
                 SET state = 'cancelled', revision = 2,
                     claim_token = 'concurrent-cancel-winner', claimed_at = NULL
                 WHERE id = ? AND state = 'pending' AND revision = 1`,
              )
                .bind(workflow.workflowId)
                .run();
            }
            return workerEnv.DB.batch(statements);
          };
        }
        const value: unknown = Reflect.get(database, property, database);
        if (typeof value === 'function') {
          const bound: unknown = value.bind(database);
          return bound;
        }
        return value;
      },
    });

    const response = await app.request(
      `/v1/admin/users/${reader.id}/email-changes/${workflow.workflowId}`,
      {
        method: 'DELETE',
        headers: {
          cookie: administratorCookie,
          'if-match': '"1"',
          'idempotency-key': 'cancel-race-loser',
        },
      },
      testEnv(racingDatabase),
      executionContext,
    );

    expect(injectedWinner).toBe(true);
    expect(response.status).toBe(412);
    expect(await response.json()).toMatchObject({ code: 'stale-revision' });
  });

  it('enforces resend cooldown and retries the same persisted scheduling attempt after 503', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('resend-reader@example.com');
    const created = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'resend-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'resend-create' },
    );
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { workflowId: string };
    const path = `/v1/admin/users/${reader.id}/email-changes/${createdBody.workflowId}/messages`;

    const cooldown = await post(path, {}, administratorCookie, {
      'idempotency-key': 'resend-too-soon',
    });
    expect(cooldown.status).toBe(429);
    expect(cooldown.headers.get('retry-after')).not.toBeNull();

    await workerEnv.DB.prepare(
      `UPDATE reader_email_change_workflow SET cooldown_until = ? WHERE id = ?`,
    )
      .bind(Date.now() - 1, createdBody.workflowId)
      .run();
    failScheduling = true;
    let failed: Response;
    try {
      failed = await post(path, {}, administratorCookie, {
        'idempotency-key': 'resend-scheduling-failure',
      });
    } finally {
      failScheduling = false;
    }
    expect(failed.status).toBe(503);
    expect(failed.headers.get('cache-control')).toBe('private, no-store');
    expect(await failed.json()).toMatchObject({ code: 'delivery-scheduling-failed' });
    const persisted = await workerEnv.DB.prepare(
      `SELECT state, revision, claim_token FROM reader_email_change_workflow WHERE id = ?`,
    )
      .bind(createdBody.workflowId)
      .first<{ state: string; revision: number; claim_token: string | null }>();
    expect(persisted).toMatchObject({ state: 'pending', revision: 2 });
    expect(persisted?.claim_token).not.toBeNull();
    const failedCommand = await workerEnv.DB.prepare(
      `SELECT response_status, retry_payload FROM admin_idempotency_record
       WHERE target_id = ? AND key = 'resend-scheduling-failure'`,
    )
      .bind(createdBody.workflowId)
      .first<{ response_status: number; retry_payload: string | null }>();
    expect(failedCommand?.response_status).toBe(503);
    expect(failedCommand?.retry_payload).not.toBeNull();

    const retry = await post(path, {}, administratorCookie, {
      'idempotency-key': 'resend-scheduling-failure',
    });
    expect(retry.status).toBe(202);
    expect(await retry.json()).toMatchObject({
      workflowId: createdBody.workflowId,
      state: 'pending',
    });
    await workerEnv.DB.prepare('DELETE FROM user WHERE id = ?').bind(reader.id).run();
    const replayAfterTargetDeletion = await post(path, {}, administratorCookie, {
      'idempotency-key': 'resend-scheduling-failure',
    });
    expect(replayAfterTargetDeletion.status).toBe(202);
    expect(await replayAfterTargetDeletion.json()).toMatchObject({
      workflowId: createdBody.workflowId,
      state: 'pending',
    });
  });

  it('persists a new workflow when initial scheduling fails and retries with the same key', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('create-scheduling-reader@example.com');
    const path = `/v1/admin/users/${reader.id}/email-changes`;
    failScheduling = true;
    let failed: Response;
    try {
      failed = await post(
        path,
        { email: 'create-scheduling-new@example.com' },
        administratorCookie,
        {
          'if-match': '"1"',
          'idempotency-key': 'create-scheduling-retry',
        },
      );
    } finally {
      failScheduling = false;
    }

    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: 'delivery-scheduling-failed' });
    const persisted = await workerEnv.DB.prepare(
      `SELECT id, state, revision, claim_token FROM reader_email_change_workflow
       WHERE user_id = ? AND state = 'pending'`,
    )
      .bind(reader.id)
      .first<{ id: string; state: string; revision: number; claim_token: string | null }>();
    expect(persisted).toMatchObject({ state: 'pending', revision: 1 });
    expect(persisted?.claim_token).not.toBeNull();

    const retry = await post(
      path,
      { email: 'create-scheduling-new@example.com' },
      administratorCookie,
      {
        'if-match': '"1"',
        'idempotency-key': 'create-scheduling-retry',
      },
    );
    expect(retry.status).toBe(201);
    expect(await retry.json()).toMatchObject({ workflowId: persisted?.id, state: 'pending' });
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_email_change_workflow
         WHERE user_id = ? AND state = 'pending'`,
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('keeps canonical identity and workflow unchanged when atomic completion fails', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('atomic-failure-reader@example.com');
    const created = await post(
      `/v1/admin/users/${reader.id}/email-changes`,
      { email: 'atomic-failure-new@example.com' },
      administratorCookie,
      { 'if-match': '"1"', 'idempotency-key': 'atomic-failure-create' },
    );
    const workflow = (await created.json()) as { workflowId: string };
    const token = mailer.sent.at(-1)?.token;
    if (token === undefined) throw new Error('Expected the email-change token.');
    await workerEnv.DB.prepare(
      `CREATE TRIGGER fail_email_change_promotion BEFORE UPDATE OF email ON user
       WHEN NEW.id = '${reader.id}' BEGIN SELECT RAISE(FAIL, 'promotion unavailable'); END`,
    ).run();
    try {
      const response = await post('/v1/auth/verify-email', { token });
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(await response.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_email_change_promotion').run();
    }
    expect(
      await workerEnv.DB.prepare('SELECT email FROM user WHERE id = ?')
        .bind(reader.id)
        .first<{ email: string }>(),
    ).toEqual({ email: 'atomic-failure-reader@example.com' });
    expect(
      await workerEnv.DB.prepare('SELECT state FROM reader_email_change_workflow WHERE id = ?')
        .bind(workflow.workflowId)
        .first<{ state: string }>(),
    ).toEqual({ state: 'pending' });
    expect((await get('/v1/me', reader.cookie)).status).toBe(200);
  });
});
