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

function testEnv(db: Env['DB'] = workerEnv.DB): Env {
  return {
    DB: db,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
}

async function request(
  path: string,
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  options: { body?: unknown; cookie?: string; headers?: Record<string, string> } = {},
  db: Env['DB'] = workerEnv.DB,
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
    testEnv(db),
  );
}

function tokenFromLastMessage(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected a verification message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  return token;
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';')[0]?.trim();
  if (cookie === undefined || cookie.length === 0) throw new Error('Expected an auth cookie.');
  return cookie;
}

async function bootstrapAdministrator(): Promise<string> {
  const email = 'deletion-admin@example.com';
  expect(
    (
      await request('/v1/admin/auth/bootstrap', 'POST', {
        body: { name: 'Deletion Admin', email, password: 'Correct-horse-41' },
      })
    ).status,
  ).toBe(201);
  expect(
    (await request('/v1/admin/auth/request-verification', 'POST', { body: { email } })).status,
  ).toBe(202);
  expect(
    (
      await request('/v1/admin/auth/verify-email', 'POST', {
        body: { token: tokenFromLastMessage() },
      })
    ).status,
  ).toBe(200);
  const login = await request('/v1/admin/auth/login', 'POST', {
    body: { email, password: 'Correct-horse-41' },
  });
  expect(login.status).toBe(200);
  return cookieFrom(login);
}

async function registerReader(email = 'deletion-reader@example.com'): Promise<{
  readonly id: string;
  readonly cookie: string;
}> {
  const registered = await request('/v1/auth/register', 'POST', {
    body: { name: 'Deletion Reader', email, password: 'Correct-horse-42' },
  });
  expect(registered.status).toBe(201);
  const identity = (await registered.json()) as { id: string };
  expect((await request('/v1/auth/request-verification', 'POST', { body: { email } })).status).toBe(
    202,
  );
  expect(
    (await request('/v1/auth/verify-email', 'POST', { body: { token: tokenFromLastMessage() } }))
      .status,
  ).toBe(200);
  const login = await request('/v1/auth/login', 'POST', {
    body: { email, password: 'Correct-horse-42' },
  });
  expect(login.status).toBe(200);
  return { id: identity.id, cookie: cookieFrom(login) };
}

async function registerUnverifiedReader(email: string): Promise<string> {
  const registered = await request('/v1/auth/register', 'POST', {
    body: { name: 'Unverified Reader', email, password: 'Correct-horse-42' },
  });
  expect(registered.status).toBe(201);
  const identity = (await registered.json()) as { id: string };
  return identity.id;
}

function raceDeletionIntoNextBatch(readerId: string): {
  readonly db: Env['DB'];
  injected(): boolean;
} {
  let inserted = false;
  const db = new Proxy(workerEnv.DB, {
    get(database, property) {
      if (property === 'batch') {
        return async (statements: Parameters<Env['DB']['batch']>[0]) => {
          if (!inserted) {
            inserted = true;
            const now = Date.now();
            await workerEnv.DB.prepare(
              `INSERT INTO reader_deletion_request
               (id, user_id, state, revision, previous_access_state, created_by, updated_by,
                created_at, updated_at)
               VALUES (?, ?, 'pending_review', 1, 'active', 'race-admin', 'race-admin', ?, ?)`,
            )
              .bind(crypto.randomUUID(), readerId, now, now)
              .run();
          }
          return database.batch(statements);
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
  return { db, injected: () => inserted };
}

async function createDeletionRequest(input: {
  readonly readerId: string;
  readonly cookie: string;
  readonly accountRevision: number;
  readonly key: string;
  readonly note?: string;
}): Promise<Response> {
  return request(`/v1/admin/users/${input.readerId}/deletion-requests`, 'POST', {
    cookie: input.cookie,
    headers: {
      'if-match': `"${String(input.accountRevision)}"`,
      'idempotency-key': input.key,
    },
    body: input.note === undefined ? {} : { note: input.note },
  });
}

async function transitionDeletionRequest(input: {
  readonly readerId: string;
  readonly requestId: string;
  readonly cookie: string;
  readonly revision: number;
  readonly key: string;
  readonly state: 'pending_review' | 'approved' | 'rejected' | 'cancelled';
  readonly note?: string;
}): Promise<Response> {
  return request(
    `/v1/admin/users/${input.readerId}/deletion-requests/${input.requestId}/status`,
    'PUT',
    {
      cookie: input.cookie,
      headers: { 'if-match': `"${String(input.revision)}"`, 'idempotency-key': input.key },
      body:
        input.note === undefined
          ? { state: input.state }
          : { state: input.state, note: input.note },
    },
  );
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, migrations);
});

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare('DELETE FROM reader_deletion_request'),
    workerEnv.DB.prepare('DELETE FROM identity_event'),
    workerEnv.DB.prepare('DELETE FROM admin_idempotency_record'),
    workerEnv.DB.prepare('DELETE FROM reader_access_state'),
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

describe('Reader deletion-request HTTP workflow', () => {
  it('upgrades existing Reader access rows and preserves the request revision default', async () => {
    const migration = migrations.find(({ name }) => name.includes('0022_'));
    if (migration === undefined) throw new Error('Expected the #274 migration.');
    const activeReader = await registerReader('upgrade-active-reader@example.com');
    const disabledReader = await registerReader('upgrade-disabled-reader@example.com');
    const now = Date.now();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
         VALUES (?, 'active', 4, ?)`,
      ).bind(activeReader.id, now),
      workerEnv.DB.prepare(
        `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
         VALUES (?, 'disabled', 7, ?)`,
      ).bind(disabledReader.id, now),
    ]);
    await workerEnv.DB.prepare('DROP TRIGGER reader_deletion_snapshot_immutable').run();
    await workerEnv.DB.prepare('DROP TABLE reader_deletion_request').run();
    const upgradeTable = 'reader_deletion_upgrade_migrations';
    await workerEnv.DB.prepare(`DROP TABLE IF EXISTS ${upgradeTable}`).run();
    await applyD1Migrations(workerEnv.DB, [migration], upgradeTable);

    const states = await workerEnv.DB.prepare(
      `SELECT user_id, state, revision FROM reader_access_state
       WHERE user_id IN (?, ?) ORDER BY user_id`,
    )
      .bind(activeReader.id, disabledReader.id)
      .all<{ user_id: string; state: string; revision: number }>();
    expect(states.results).toEqual(
      expect.arrayContaining([
        { user_id: activeReader.id, state: 'active', revision: 4 },
        { user_id: disabledReader.id, state: 'disabled', revision: 7 },
      ]),
    );
    expect(states.results).toHaveLength(2);
    const insert = await workerEnv.DB.prepare(
      `INSERT INTO reader_deletion_request
       (id, user_id, state, previous_access_state, created_by, updated_by, created_at, updated_at)
       VALUES ('migration-default-request', ?, 'pending_review', 'active', 'admin', 'admin', ?, ?)`,
    )
      .bind(activeReader.id, now, now)
      .run();
    expect(insert.success).toBe(true);
    expect(
      await workerEnv.DB.prepare(
        `SELECT revision FROM reader_deletion_request WHERE id = 'migration-default-request'`,
      ).first<{ revision: number }>(),
    ).toEqual({ revision: 1 });
    await workerEnv.DB.prepare(`DROP TABLE ${upgradeTable}`).run();
  });

  it('creates a pending request, snapshots access state, revokes sessions and separates effective access', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader();
    const expiredSessionNow = Math.floor(Date.now() / 1_000);
    await workerEnv.DB.prepare(
      `INSERT INTO session(id,expires_at,token,created_at,updated_at,user_id)
       VALUES('expired-before-deletion',?,'expired-token',?,?,?)`,
    )
      .bind(expiredSessionNow - 60, expiredSessionNow - 120, expiredSessionNow - 120, reader.id)
      .run();
    const detail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(detail.status).toBe(200);
    expect(detail.headers.get('etag')).toBe('"1"');
    const verificationMessageCount = mailer.sent.length;

    const created = await request(`/v1/admin/users/${reader.id}/deletion-requests`, 'POST', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'delete-reader-create-1' },
      body: { note: 'Review requested by account holder.' },
    });
    expect(created.status).toBe(201);
    expect(created.headers.get('cache-control')).toBe('private, no-store');
    expect(mailer.sent).toHaveLength(verificationMessageCount);
    const createdBody = (await created.json()) as { requestId: string };
    expect(createdBody).toMatchObject({
      state: 'pending_review',
      changed: true,
      previousAccessState: 'active',
      revision: 1,
    });
    expect(JSON.stringify(createdBody)).not.toContain('Review requested by account holder.');
    expect(
      await workerEnv.DB.prepare(
        'SELECT count(*) AS count FROM session WHERE user_id = ? AND expires_at > ?',
      )
        .bind(reader.id, expiredSessionNow)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await workerEnv.DB.prepare('SELECT count(*) AS count FROM session WHERE id=?')
        .bind('expired-before-deletion')
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const suspendedSessions = await request(`/v1/admin/users/${reader.id}/sessions`, 'GET', {
      cookie: administratorCookie,
    });
    expect(suspendedSessions.status).toBe(200);
    expect(await suspendedSessions.json()).toMatchObject({ items: [], total: 0, nextCursor: null });
    const suspendedCleanup = await request(`/v1/admin/users/${reader.id}/sessions`, 'DELETE', {
      cookie: administratorCookie,
    });
    expect(suspendedCleanup.status).toBe(200);
    expect(await suspendedCleanup.json()).toMatchObject({ state: 'suspended', changed: false });
    const events = await workerEnv.DB.prepare(
      `SELECT type, result, metadata FROM identity_event WHERE subject_id = ? ORDER BY type`,
    )
      .bind(reader.id)
      .all<{ type: string; result: string; metadata: string | null }>();
    expect(events.results.map((event) => [event.type, event.result])).toEqual([
      ['deletion-request-attempt', 'success'],
      ['deletion-requested', 'success'],
      ['sessions-revoke-attempt', 'success'],
    ]);
    const deletionLifecycle = events.results.find((event) => event.type === 'deletion-requested');
    expect(JSON.parse(deletionLifecycle?.metadata ?? '{}')).toMatchObject({
      revokedSessionCount: 1,
    });
    expect(
      events.results.some(
        (event) => event.type === 'session-revoked' || event.type === 'sessions-revoked',
      ),
    ).toBe(false);
    expect(JSON.stringify(events.results)).not.toContain('Review requested by account holder.');
    expect(
      await workerEnv.DB.prepare(
        `SELECT method, normalized_path, target_id, expires_at - created_at AS retention
         FROM admin_idempotency_record WHERE key = 'delete-reader-create-1'`,
      ).first<{
        method: string;
        normalized_path: string;
        target_id: string;
        retention: number;
      }>(),
    ).toEqual({
      method: 'POST',
      normalized_path: '/v1/admin/users/:userId/deletion-requests',
      target_id: reader.id,
      retention: 86_400_000,
    });
    const loginAfterRequest = await request('/v1/auth/login', 'POST', {
      body: { email: 'deletion-reader@example.com', password: 'Correct-horse-42' },
    });
    expect(loginAfterRequest.status).not.toBe(200);
    expect(loginAfterRequest.headers.get('set-cookie')).toBeNull();
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);
    const readerState = await request('/v1/auth/reader-state', 'POST', {
      cookie: reader.cookie,
      body: {},
    });
    expect(readerState.status).toBe(401);
    expect(readerState.headers.get('cache-control')).toBe('private, no-store');

    const updatedDetail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    const updatedDetailText = await updatedDetail.text();
    expect(JSON.parse(updatedDetailText)).toMatchObject({
      revision: 2,
      access: { state: 'active', effectiveState: 'suspended' },
      deletionState: 'pending_review',
      activeWorkflows: [
        expect.objectContaining({
          id: createdBody.requestId,
          type: 'deletion-request',
          state: 'pending_review',
          revision: 1,
        }),
      ],
    });
    expect(updatedDetailText).not.toContain('Review requested by account holder.');
  });

  it('enforces decision notes, state transitions, no-ops and terminal contradictions', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('state-machine-reader@example.com');
    const created = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'state-machine-create',
    });
    const requestBody = (await created.json()) as { requestId: string };

    const missingDecisionNote = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'approval-note-required',
      state: 'approved',
    });
    expect(missingDecisionNote.status).toBe(400);
    expect(missingDecisionNote.headers.get('cache-control')).toBe('private, no-store');
    expect(await missingDecisionNote.json()).toMatchObject({ code: 'bad-request' });
    const missingRejectionNote = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'rejection-note-required',
      state: 'rejected',
    });
    expect(missingRejectionNote.status).toBe(400);
    expect(await missingRejectionNote.json()).toMatchObject({ code: 'bad-request' });

    const samePending = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'same-pending-noop',
      state: 'pending_review',
    });
    expect(samePending.status).toBe(200);
    expect(await samePending.json()).toMatchObject({
      requestId: requestBody.requestId,
      state: 'pending_review',
      changed: false,
      revision: 1,
      accountRevision: 2,
    });

    const approved = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'approve-deletion',
      state: 'approved',
      note: 'Approval reviewed by the account team.',
    });
    expect(approved.status).toBe(200);
    expect(approved.headers.get('etag')).toBe('"2"');
    expect(await approved.json()).toMatchObject({ state: 'approved', changed: true, revision: 2 });
    const approvedDetail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(await approvedDetail.json()).toMatchObject({
      access: { state: 'active', effectiveState: 'suspended' },
      deletionState: 'approved',
    });

    const sameApproved = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 2,
      key: 'same-approved-noop',
      state: 'approved',
      note: 'Approval remains confirmed.',
    });
    expect(sameApproved.status).toBe(200);
    expect(await sameApproved.json()).toMatchObject({
      state: 'approved',
      changed: false,
      revision: 2,
    });

    const contradiction = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 2,
      key: 'approved-to-rejected',
      state: 'rejected',
      note: 'Contradictory terminal action.',
    });
    expect(contradiction.status).toBe(409);
    expect(await contradiction.json()).toMatchObject({ code: 'invalid-transition' });

    const cancelled = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 2,
      key: 'cancel-approved',
      state: 'cancelled',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      state: 'cancelled',
      previousAccessState: 'active',
      changed: true,
      revision: 3,
      accountRevision: 4,
    });
    const terminalNoop = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 3,
      key: 'same-cancelled-noop',
      state: 'cancelled',
    });
    expect(terminalNoop.status).toBe(200);
    expect(await terminalNoop.json()).toMatchObject({
      state: 'cancelled',
      changed: false,
      revision: 3,
    });
    const terminalContradiction = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 3,
      key: 'cancelled-to-approved',
      state: 'approved',
      note: 'Cannot re-open.',
    });
    expect(terminalContradiction.status).toBe(409);
    expect(await terminalContradiction.json()).toMatchObject({ code: 'invalid-transition' });
    const approvalReplayAfterCancellation = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'approve-deletion',
      state: 'approved',
      note: 'Approval reviewed by the account team.',
    });
    expect(approvalReplayAfterCancellation.status).toBe(200);
    expect(await approvalReplayAfterCancellation.json()).toMatchObject({
      state: 'approved',
      changed: true,
      revision: 2,
    });

    const latestDetail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(await latestDetail.json()).toMatchObject({
      access: { state: 'active', effectiveState: 'active' },
      deletionState: null,
    });
  });

  it('restores a disabled access snapshot exactly when a request is rejected', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('disabled-snapshot-reader@example.com');
    await workerEnv.DB.prepare(
      `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)`,
    )
      .bind(reader.id, Date.now())
      .run();
    const created = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 2,
      key: 'disabled-snapshot-create',
    });
    const createdText = await created.text();
    const requestBody = JSON.parse(createdText) as { requestId: string };
    expect(created.status).toBe(201);
    expect(JSON.parse(createdText)).toMatchObject({ previousAccessState: 'disabled' });
    await expect(
      workerEnv.DB.prepare(
        `UPDATE reader_deletion_request SET previous_access_state = 'active' WHERE id = ?`,
      )
        .bind(requestBody.requestId)
        .run(),
    ).rejects.toThrow();
    const rejected = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'disabled-snapshot-reject',
      state: 'rejected',
      note: 'Request rejected after review.',
    });
    expect(rejected.status).toBe(200);
    expect(await rejected.json()).toMatchObject({
      state: 'rejected',
      previousAccessState: 'disabled',
      changed: true,
    });
    expect(
      await workerEnv.DB.prepare('SELECT state FROM reader_access_state WHERE user_id = ?')
        .bind(reader.id)
        .first<{ state: string }>(),
    ).toEqual({ state: 'disabled' });
    const detail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(await detail.json()).toMatchObject({
      access: { state: 'disabled', effectiveState: 'disabled' },
      deletionState: null,
    });
  });

  it('replays creation and transitions, rejects idempotency-key reuse and excludes notes from projections', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-idempotency-reader@example.com');
    const requestNote = 'Private request context that must never enter the ledger.';
    const logSpy = vi.spyOn(console, 'log');
    const created = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-create-idempotency',
      note: requestNote,
    });
    expect(logSpy.mock.calls.flat().join(' ')).not.toContain(requestNote);
    logSpy.mockRestore();
    const createdBody = (await created.json()) as { requestId: string };
    const replay = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-create-idempotency',
      note: requestNote,
    });
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(createdBody);
    const reused = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-create-idempotency',
      note: 'Different private context.',
    });
    expect(reused.status).toBe(409);
    expect(reused.headers.get('cache-control')).toBe('private, no-store');
    expect(await reused.json()).toMatchObject({ code: 'idempotency-key-reused' });

    const blockedEmailChange = await request(`/v1/admin/users/${reader.id}/email-changes`, 'POST', {
      cookie: administratorCookie,
      headers: { 'if-match': '"2"', 'idempotency-key': 'deletion-blocks-email-change' },
      body: { email: 'deletion-blocked-email@example.com' },
    });
    expect(blockedEmailChange.status).toBe(409);
    expect(await blockedEmailChange.json()).toMatchObject({ code: 'active-deletion-request' });

    const decisionNote = 'Confidential decision note.';
    const decisionLog = vi.spyOn(console, 'log');
    const rejected = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: createdBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'deletion-transition-idempotency',
      state: 'rejected',
      note: decisionNote,
    });
    expect(decisionLog.mock.calls.flat().join(' ')).not.toContain(decisionNote);
    decisionLog.mockRestore();
    expect(rejected.status).toBe(200);
    const rejectedBody = await rejected.json();
    expect(JSON.stringify(rejectedBody)).not.toContain(decisionNote);
    const transitionReplay = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: createdBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'deletion-transition-idempotency',
      state: 'rejected',
      note: decisionNote,
    });
    expect(transitionReplay.status).toBe(200);
    expect(await transitionReplay.json()).toEqual(rejectedBody);
    const createReplayAfterTerminalTransition = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-create-idempotency',
      note: requestNote,
    });
    expect(createReplayAfterTerminalTransition.status).toBe(201);
    expect(await createReplayAfterTerminalTransition.json()).toEqual(createdBody);
    const transitionKeyReuse = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: createdBody.requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'deletion-transition-idempotency',
      state: 'rejected',
      note: 'Changed decision note.',
    });
    expect(transitionKeyReuse.status).toBe(409);
    expect(await transitionKeyReuse.json()).toMatchObject({ code: 'idempotency-key-reused' });

    const activity = await request(`/v1/admin/users/${reader.id}/activity`, 'GET', {
      cookie: administratorCookie,
    });
    expect(activity.status).toBe(200);
    const activityBody = await activity.text();
    const activityValue = JSON.parse(activityBody) as { items: { type: string }[] };
    expect(activityValue.items.map((item) => item.type)).toEqual(
      expect.arrayContaining(['deletion-requested', 'deletion-rejected']),
    );
    expect(activityBody).not.toContain(requestNote);
    expect(activityBody).not.toContain(decisionNote);
    const audit = await request('/v1/admin/audit-events', 'GET', { cookie: administratorCookie });
    expect(audit.status).toBe(200);
    const auditBody = await audit.text();
    const auditValue = JSON.parse(auditBody) as {
      items: { type: string; result: string }[];
    };
    expect(auditValue.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'deletion-requested', result: 'success' }),
        expect.objectContaining({ type: 'deletion-rejected', result: 'success' }),
      ]),
    );
    expect(auditBody).not.toContain(requestNote);
    expect(auditBody).not.toContain(decisionNote);
    const notes = await workerEnv.DB.prepare(
      `SELECT metadata FROM identity_event WHERE subject_id = ?`,
    )
      .bind(reader.id)
      .all<{ metadata: string | null }>();
    expect(JSON.stringify(notes.results)).not.toContain(requestNote);
    expect(JSON.stringify(notes.results)).not.toContain(decisionNote);
  });

  it('replays committed deletion commands before looking up a Reader that no longer exists', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-replay-after-delete@example.com');
    const createInput = {
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-create-before-reader-delete',
    } as const;
    const created = await createDeletionRequest(createInput);
    const creationResult = await created.json();
    const requestId = (creationResult as { requestId: string }).requestId;
    const transitionInput = {
      readerId: reader.id,
      requestId,
      cookie: administratorCookie,
      revision: 1,
      key: 'deletion-cancel-before-reader-delete',
      state: 'cancelled',
    } as const;
    const transitioned = await transitionDeletionRequest(transitionInput);
    const transitionResult = await transitioned.json();
    expect(transitioned.status).toBe(200);
    await workerEnv.DB.prepare('DELETE FROM user WHERE id = ?').bind(reader.id).run();

    const createReplay = await createDeletionRequest(createInput);
    expect(createReplay.status).toBe(201);
    expect(await createReplay.json()).toEqual(creationResult);
    const transitionReplay = await transitionDeletionRequest(transitionInput);
    expect(transitionReplay.status).toBe(200);
    expect(await transitionReplay.json()).toEqual(transitionResult);
  });

  it('blocks force verification, verification resend, recovery, and all email-change commands while deletion is active', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-blocks-email-reader@example.com');
    const emailChange = await request(`/v1/admin/users/${reader.id}/email-changes`, 'POST', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'prepare-email-workflow' },
      body: { email: 'deletion-blocked-target@example.com' },
    });
    expect(emailChange.status).toBe(201);
    const emailChangeBody = (await emailChange.json()) as { workflowId: string };
    const deletion = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 2,
      key: 'deletion-block-email-workflow',
    });
    expect(deletion.status).toBe(201);
    const messagesBefore = mailer.sent.length;
    const emailChangePath = `/v1/admin/users/${reader.id}/email-changes/${emailChangeBody.workflowId}`;
    const blockedResponses = await Promise.all([
      request(`/v1/admin/users/${reader.id}/email-verification`, 'PUT', {
        cookie: administratorCookie,
        headers: { 'if-match': '"3"' },
      }),
      request(`/v1/admin/users/${reader.id}/email-verification/messages`, 'POST', {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'blocked-verification-message' },
        body: {},
      }),
      request(`/v1/admin/users/${reader.id}/password-recovery/messages`, 'POST', {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'blocked-recovery-message' },
        body: {},
      }),
      request(`/v1/admin/users/${reader.id}/email-changes`, 'POST', {
        cookie: administratorCookie,
        headers: { 'if-match': '"3"', 'idempotency-key': 'blocked-email-create' },
        body: { email: 'another-deletion-blocked@example.com' },
      }),
      request(`${emailChangePath}/messages`, 'POST', {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'blocked-email-resend' },
        body: {},
      }),
      request(emailChangePath, 'DELETE', {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': 'blocked-email-cancel' },
      }),
    ]);
    for (const response of blockedResponses) {
      expect(response.status).toBe(409);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'active-deletion-request' });
    }
    expect(mailer.sent).toHaveLength(messagesBefore);
  });

  it('rechecks active deletion transactionally against force-verification, resend and email-change races', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const forceReaderId = await registerUnverifiedReader('deletion-force-race@example.com');
    const forceRace = raceDeletionIntoNextBatch(forceReaderId);
    const forced = await request(
      `/v1/admin/users/${forceReaderId}/email-verification`,
      'PUT',
      { cookie: administratorCookie, headers: { 'if-match': '"1"' } },
      forceRace.db,
    );
    expect(forceRace.injected()).toBe(true);
    expect(forced.status).toBe(409);
    expect(await forced.json()).toMatchObject({ code: 'active-deletion-request' });
    expect(
      await workerEnv.DB.prepare('SELECT email_verified FROM user WHERE id = ?')
        .bind(forceReaderId)
        .first<{ email_verified: number }>(),
    ).toEqual({ email_verified: 0 });

    const messageReaderId = await registerUnverifiedReader('deletion-message-race@example.com');
    const messagesBefore = mailer.sent.length;
    const messageRace = raceDeletionIntoNextBatch(messageReaderId);
    const message = await request(
      `/v1/admin/users/${messageReaderId}/email-verification/messages`,
      'POST',
      {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'deletion-message-race' },
        body: {},
      },
      messageRace.db,
    );
    expect(messageRace.injected()).toBe(true);
    expect(message.status).toBe(409);
    expect(await message.json()).toMatchObject({ code: 'active-deletion-request' });
    expect(mailer.sent).toHaveLength(messagesBefore);
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_message_workflow WHERE user_id = ?`,
      )
        .bind(messageReaderId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });

    const emailReader = await registerReader('deletion-email-change-race@example.com');
    const emailMessagesBefore = mailer.sent.length;
    const emailRace = raceDeletionIntoNextBatch(emailReader.id);
    const emailChange = await request(
      `/v1/admin/users/${emailReader.id}/email-changes`,
      'POST',
      {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': 'deletion-email-change-race' },
        body: { email: 'deletion-email-race-target@example.com' },
      },
      emailRace.db,
    );
    expect(emailRace.injected()).toBe(true);
    expect(emailChange.status).toBe(409);
    expect(await emailChange.json()).toMatchObject({ code: 'active-deletion-request' });
    expect(mailer.sent).toHaveLength(emailMessagesBefore);
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_email_change_workflow WHERE user_id = ?`,
      )
        .bind(emailReader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('authorizes before approving/rejecting note validation and audits note failures', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-note-order-reader@example.com');
    const created = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-note-order-create',
    });
    const requestBody = (await created.json()) as { requestId: string };
    const transitionPath = `/v1/admin/users/${reader.id}/deletion-requests/${requestBody.requestId}/status`;

    const anonymous = await request(
      '/v1/admin/users/missing/deletion-requests/missing/status',
      'PUT',
      {
        headers: { 'if-match': '"1"', 'idempotency-key': 'anonymous-missing-note' },
        body: { state: 'approved' },
      },
    );
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });
    const readerActor = await request(transitionPath, 'PUT', {
      cookie: reader.cookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'reader-missing-note' },
      body: { state: 'approved' },
    });
    expect(readerActor.status).toBe(403);
    expect(await readerActor.json()).toMatchObject({ code: 'forbidden' });
    const anonymousInvalidNote = await request(
      '/v1/admin/users/missing/deletion-requests/missing/status',
      'PUT',
      {
        headers: { 'if-match': '"1"', 'idempotency-key': 'anonymous-invalid-note' },
        body: { state: 'approved', note: 12_345 },
      },
    );
    expect(anonymousInvalidNote.status).toBe(401);

    for (const [key, note] of [
      ['missing-approved-note', undefined],
      ['blank-rejected-note', '  '],
      ['oversized-rejected-note', 'x'.repeat(2_001)],
      ['non-string-rejected-note', 12_345],
    ] as const) {
      const response = await request(transitionPath, 'PUT', {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': key },
        body: {
          state: key === 'missing-approved-note' ? 'approved' : 'rejected',
          ...(note === undefined ? {} : { note }),
        },
      });
      expect(response.status).toBe(400);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'bad-request' });
    }
    const noteFailures = await workerEnv.DB.prepare(
      `SELECT result, problem_code, metadata FROM identity_event
       WHERE type = 'deletion-request-attempt' AND result = 'failure'
         AND problem_code = 'bad-request' ORDER BY occurred_at`,
    ).all<{ result: string; problem_code: string | null; metadata: string | null }>();
    expect(noteFailures.results.slice(-4)).toEqual([
      { result: 'failure', problem_code: 'bad-request', metadata: null },
      { result: 'failure', problem_code: 'bad-request', metadata: null },
      { result: 'failure', problem_code: 'bad-request', metadata: null },
      { result: 'failure', problem_code: 'bad-request', metadata: null },
    ]);

    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_deletion_note_audit BEFORE INSERT ON identity_event
         WHEN NEW.type = 'deletion-request-attempt' AND NEW.result = 'failure'
           AND NEW.problem_code = 'bad-request'
         BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`,
    ).run();
    try {
      const unauditable = await request(transitionPath, 'PUT', {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': 'unauditable-note-failure' },
        body: { state: 'approved' },
      });
      expect(unauditable.status).toBe(500);
      expect(await unauditable.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_deletion_note_audit').run();
    }
    const administratorId = await workerEnv.DB.prepare('SELECT id FROM admin_user LIMIT 1').first<{
      id: string;
    }>();
    if (administratorId === null) throw new Error('Expected a bootstrapped Administrator.');
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = 'disabled', revision = 2, updated_at = excluded.updated_at`,
    )
      .bind(administratorId.id, Date.now())
      .run();
    const disabledActor = await request(transitionPath, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'disabled-missing-note' },
      body: { state: 'approved' },
    });
    expect(disabledActor.status).toBe(403);
    expect(await disabledActor.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('serializes concurrent creates and authorizes the Administrator before Reader lookup', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-race-reader@example.com');
    const missingAccountPrecondition = await request(
      `/v1/admin/users/${reader.id}/deletion-requests`,
      'POST',
      {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'deletion-missing-account-etag' },
        body: {},
      },
    );
    expect(missingAccountPrecondition.status).toBe(428);
    expect(await missingAccountPrecondition.json()).toMatchObject({
      code: 'precondition-required',
    });
    const missingIdempotency = await request(
      `/v1/admin/users/${reader.id}/deletion-requests`,
      'POST',
      { cookie: administratorCookie, headers: { 'if-match': '"1"' }, body: {} },
    );
    expect(missingIdempotency.status).toBe(428);
    expect(await missingIdempotency.json()).toMatchObject({ code: 'precondition-required' });
    const staleAccountPrecondition = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 9,
      key: 'deletion-stale-account-etag',
    });
    expect(staleAccountPrecondition.status).toBe(412);
    expect(await staleAccountPrecondition.json()).toMatchObject({ code: 'stale-revision' });
    const races = await Promise.all([
      createDeletionRequest({
        readerId: reader.id,
        cookie: administratorCookie,
        accountRevision: 1,
        key: 'deletion-race-one',
      }),
      createDeletionRequest({
        readerId: reader.id,
        cookie: administratorCookie,
        accountRevision: 1,
        key: 'deletion-race-two',
      }),
    ]);
    expect(races.map((response) => response.status).sort()).toEqual([201, 412]);
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_deletion_request
         WHERE user_id = ? AND state IN ('pending_review', 'approved')`,
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const activeConflict = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 2,
      key: 'deletion-second-request',
    });
    expect(activeConflict.status).toBe(409);
    expect(await activeConflict.json()).toMatchObject({ code: 'active-deletion-request' });

    const missingReaderPath = '/v1/admin/users/missing-reader/deletion-requests';
    const anonymous = await request(missingReaderPath, 'POST', {
      headers: { 'if-match': '"1"', 'idempotency-key': 'anonymous-deletion' },
      body: {},
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });
    const readerActor = await request(missingReaderPath, 'POST', {
      cookie: reader.cookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'reader-deletion' },
      body: {},
    });
    expect(readerActor.status).toBe(403);
    expect(await readerActor.json()).toMatchObject({ code: 'forbidden' });

    const administratorId = await workerEnv.DB.prepare('SELECT id FROM admin_user LIMIT 1').first<{
      id: string;
    }>();
    if (administratorId === null) throw new Error('Expected a bootstrapped Administrator.');
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)
       ON CONFLICT(user_id) DO UPDATE SET state = 'disabled', revision = 2, updated_at = excluded.updated_at`,
    )
      .bind(administratorId.id, Date.now())
      .run();
    const disabledActor = await request(missingReaderPath, 'POST', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'disabled-deletion' },
      body: {},
    });
    expect(disabledActor.status).toBe(403);
    expect(await disabledActor.json()).toMatchObject({ code: 'administrator-disabled' });
  });

  it('requires If-Match and rejects stale and concurrent transition revisions', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-cas-reader@example.com');
    const created = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 1,
      key: 'deletion-cas-create',
    });
    const requestBody = (await created.json()) as { requestId: string };
    const missing = await request(
      `/v1/admin/users/${reader.id}/deletion-requests/${requestBody.requestId}/status`,
      'PUT',
      {
        cookie: administratorCookie,
        headers: { 'idempotency-key': 'deletion-missing-etag' },
        body: { state: 'cancelled' },
      },
    );
    expect(missing.status).toBe(428);
    expect(await missing.json()).toMatchObject({ code: 'precondition-required' });
    const stale = await transitionDeletionRequest({
      readerId: reader.id,
      requestId: requestBody.requestId,
      cookie: administratorCookie,
      revision: 8,
      key: 'deletion-stale-etag',
      state: 'cancelled',
    });
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision' });
    const race = await Promise.all([
      transitionDeletionRequest({
        readerId: reader.id,
        requestId: requestBody.requestId,
        cookie: administratorCookie,
        revision: 1,
        key: 'deletion-race-approve',
        state: 'approved',
        note: 'Approve race winner.',
      }),
      transitionDeletionRequest({
        readerId: reader.id,
        requestId: requestBody.requestId,
        cookie: administratorCookie,
        revision: 1,
        key: 'deletion-race-cancel',
        state: 'cancelled',
      }),
    ]);
    expect(race.map((response) => response.status).sort()).toEqual([200, 412]);
  });

  it('disables and rehabilitates Reader access with account ETags, revocation and no session restoration', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('reader-access-transition@example.com');
    const path = `/v1/admin/users/${reader.id}/access`;
    const missingEtag = await request(path, 'PUT', {
      cookie: administratorCookie,
      body: { state: 'disabled' },
    });
    expect(missingEtag.status).toBe(428);
    expect(await missingEtag.json()).toMatchObject({ code: 'precondition-required' });
    const staleEtag = await request(path, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"9"' },
      body: { state: 'disabled' },
    });
    expect(staleEtag.status).toBe(412);
    expect(await staleEtag.json()).toMatchObject({ code: 'stale-revision' });
    const disabled = await request(path, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"' },
      body: { state: 'disabled' },
    });
    expect(disabled.status).toBe(200);
    expect(disabled.headers.get('cache-control')).toBe('private, no-store');
    expect(await disabled.json()).toEqual({ state: 'disabled', changed: true, revision: 2 });
    expect(disabled.headers.get('etag')).toBe('"2"');
    const disabledEvent = await workerEnv.DB.prepare(
      `SELECT metadata FROM identity_event WHERE subject_id=? AND type='access-disabled'`,
    )
      .bind(reader.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(disabledEvent?.metadata ?? '{}')).toMatchObject({
      revision: 2,
      revokedSessionCount: 1,
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS total FROM identity_event WHERE subject_id=? AND type IN ('session-revoked','sessions-revoked')`,
      )
        .bind(reader.id)
        .first<{ total: number }>(),
    ).toEqual({ total: 0 });
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);

    const rehabilitated = await request(path, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"2"' },
      body: { state: 'active' },
    });
    expect(rehabilitated.status).toBe(200);
    expect(await rehabilitated.json()).toEqual({ state: 'active', changed: true, revision: 3 });
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);
    const newReaderSession = await request('/v1/auth/login', 'POST', {
      body: { email: 'reader-access-transition@example.com', password: 'Correct-horse-42' },
    });
    expect(newReaderSession.status).toBe(200);
    expect((await request('/v1/me', 'GET', { cookie: cookieFrom(newReaderSession) })).status).toBe(
      200,
    );
    const noop = await request(path, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"3"' },
      body: { state: 'active' },
    });
    expect(noop.status).toBe(200);
    expect(await noop.json()).toEqual({ state: 'active', changed: false, revision: 3 });
    const accessEvents = await workerEnv.DB.prepare(
      `SELECT type, result, metadata FROM identity_event
       WHERE subject_id = ? AND type IN ('access-disabled', 'access-rehabilitated', 'access-attempt')`,
    )
      .bind(reader.id)
      .all<{ type: string; result: string; metadata: string | null }>();
    expect(accessEvents.results.map((event) => [event.type, event.result])).toEqual(
      expect.arrayContaining([
        ['access-disabled', 'success'],
        ['access-rehabilitated', 'success'],
        ['access-attempt', 'success'],
      ]),
    );
    expect(
      accessEvents.results.filter(
        (event) => event.type === 'access-attempt' && event.result === 'success',
      ),
    ).toHaveLength(3);
    expect(
      accessEvents.results.filter(
        (event) => event.type === 'access-attempt' && event.result === 'failure',
      ),
    ).toHaveLength(2);

    const deletion = await createDeletionRequest({
      readerId: reader.id,
      cookie: administratorCookie,
      accountRevision: 3,
      key: 'access-blocked-deletion-create',
    });
    expect(deletion.status).toBe(201);
    const blockedAccessChange = await request(path, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"4"' },
      body: { state: 'disabled' },
    });
    expect(blockedAccessChange.status).toBe(409);
    expect(await blockedAccessChange.json()).toMatchObject({ code: 'active-deletion-request' });

    const raceReader = await registerReader('reader-access-deletion-race@example.com');
    const raceDatabase = raceDeletionIntoNextBatch(raceReader.id);
    const raceResponse = await request(
      `/v1/admin/users/${raceReader.id}/access`,
      'PUT',
      {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"' },
        body: { state: 'disabled' },
      },
      raceDatabase.db,
    );
    expect(raceDatabase.injected()).toBe(true);
    expect(raceResponse.status).toBe(409);
    expect(await raceResponse.json()).toMatchObject({ code: 'active-deletion-request' });
    expect(
      await workerEnv.DB.prepare(
        'SELECT state, revision FROM reader_access_state WHERE user_id = ?',
      )
        .bind(raceReader.id)
        .first<{ state: string; revision: number }>(),
    ).toEqual({ state: 'active', revision: 1 });
  });

  it('fails closed and rolls back the request when its atomic audit write fails', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-audit-failure-reader@example.com');
    const sessionsBefore = await workerEnv.DB.prepare(
      'SELECT count(*) AS count FROM session WHERE user_id = ?',
    )
      .bind(reader.id)
      .first<{ count: number }>();
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_deletion_success_audit BEFORE INSERT ON identity_event
       WHEN NEW.type = 'deletion-request-attempt' AND NEW.result = 'success'
       BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`,
    ).run();
    try {
      const response = await createDeletionRequest({
        readerId: reader.id,
        cookie: administratorCookie,
        accountRevision: 1,
        key: 'deletion-audit-failure',
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_deletion_success_audit').run();
    }
    expect(
      await workerEnv.DB.prepare(
        'SELECT count(*) AS count FROM reader_deletion_request WHERE user_id = ?',
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await workerEnv.DB.prepare('SELECT revision FROM reader_access_state WHERE user_id = ?')
        .bind(reader.id)
        .first<{ revision: number }>(),
    ).toBeNull();
    expect(
      await workerEnv.DB.prepare('SELECT count(*) AS count FROM session WHERE user_id = ?')
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual(sessionsBefore);
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM admin_idempotency_record WHERE key = 'deletion-audit-failure'`,
      ).first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('returns 500 rather than an unaudited active-request conflict when failure audit is unavailable', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('deletion-failure-audit-reader@example.com');
    expect(
      (
        await createDeletionRequest({
          readerId: reader.id,
          cookie: administratorCookie,
          accountRevision: 1,
          key: 'deletion-failure-audit-first',
        })
      ).status,
    ).toBe(201);
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_deletion_failure_audit BEFORE INSERT ON identity_event
       WHEN NEW.type = 'deletion-request-attempt' AND NEW.result = 'failure'
       BEGIN SELECT RAISE(FAIL, 'audit unavailable'); END`,
    ).run();
    try {
      const response = await createDeletionRequest({
        readerId: reader.id,
        cookie: administratorCookie,
        accountRevision: 2,
        key: 'deletion-failure-audit-second',
      });
      expect(response.status).toBe(500);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(await response.json()).toMatchObject({ code: 'internal-error' });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER reject_deletion_failure_audit').run();
    }
    expect(
      await workerEnv.DB.prepare(
        `SELECT count(*) AS count FROM reader_deletion_request
         WHERE user_id = ? AND state IN ('pending_review', 'approved')`,
      )
        .bind(reader.id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
