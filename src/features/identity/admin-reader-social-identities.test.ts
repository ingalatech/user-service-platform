import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';
import {
  claimReaderSocialIdentityNotice,
  releaseReaderSocialIdentityNoticeClaim,
} from './admin-reader-social-identities.js';

type TestEnvOverrides = Partial<Env> & { readonly AUTH_SOCIAL_PROVIDERS?: string };

const workerEnv = env;
const migrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
let failScheduling = false;
const executionContext = {
  waitUntil: (task: Promise<unknown>) => {
    if (failScheduling) throw new Error('scheduler unavailable');
    return task;
  },
  passThroughOnException: () => undefined,
  props: {},
};

function testEnv(overrides: TestEnvOverrides = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    ...overrides,
  };
}

async function request(
  path: string,
  method: 'DELETE' | 'GET' | 'POST' | 'PUT',
  options: {
    readonly body?: unknown;
    readonly cookie?: string;
    readonly headers?: Record<string, string>;
  } = {},
  envOverrides: TestEnvOverrides = {},
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
    testEnv(envOverrides),
    executionContext,
  );
}

function tokenFromLastMessage(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected an auth verification message.');
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
  const email = 'social-admin@example.com';
  expect(
    (
      await request('/v1/admin/auth/bootstrap', 'POST', {
        body: { name: 'Social Admin', email, password: 'Correct-horse-41' },
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

async function registerReader(
  email: string,
  verified = true,
): Promise<{ id: string; cookie: string }> {
  const registration = await request('/v1/auth/register', 'POST', {
    body: { name: 'Social Reader', email, password: 'Correct-horse-42' },
  });
  expect(registration.status).toBe(201);
  const reader = (await registration.json()) as { id: string };
  if (!verified) return { id: reader.id, cookie: '' };
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
  return { id: reader.id, cookie: cookieFrom(login) };
}

async function addSocialIdentity(input: {
  readonly readerId: string;
  readonly provider: string;
  readonly accountId?: string;
  readonly createdAt?: number;
}): Promise<string> {
  const associationId = crypto.randomUUID();
  const createdAt = input.createdAt ?? Math.floor(Date.now() / 1_000);
  await workerEnv.DB.prepare(
    `INSERT INTO account
     (id, account_id, provider_id, user_id, access_token, refresh_token, id_token,
      access_token_expires_at, refresh_token_expires_at, scope, password, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'access-secret', 'refresh-secret', 'id-secret', ?, ?,
       'profile email', NULL, ?, ?)`,
  )
    .bind(
      associationId,
      input.accountId ?? 'external-account-secret',
      input.provider,
      input.readerId,
      createdAt + 3600,
      createdAt + 7200,
      createdAt,
      createdAt,
    )
    .run();
  return associationId;
}

function unlinkPath(readerId: string, associationId: string): string {
  return `/v1/admin/users/${readerId}/social-identities/${associationId}`;
}

async function unlink(
  readerId: string,
  associationId: string,
  cookie: string,
  accountRevision: number,
  idempotencyKey: string,
  envOverrides: TestEnvOverrides = {},
): Promise<Response> {
  return request(
    unlinkPath(readerId, associationId),
    'DELETE',
    {
      cookie,
      headers: {
        'if-match': `"${String(accountRevision)}"`,
        'idempotency-key': idempotencyKey,
      },
    },
    envOverrides,
  );
}

async function socialEventCount(readerId: string, type: string): Promise<number> {
  const row = await workerEnv.DB.prepare(
    'SELECT count(*) AS total FROM identity_event WHERE subject_id = ? AND type = ?',
  )
    .bind(readerId, type)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function successfulUnlinkAttemptCount(readerId: string): Promise<number> {
  const row = await workerEnv.DB.prepare(
    `SELECT count(*) AS total FROM identity_event
     WHERE subject_id=? AND type='social-unlink-attempt' AND result='success'`,
  )
    .bind(readerId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function socialAssociationCount(readerId: string): Promise<number> {
  const row = await workerEnv.DB.prepare(
    `SELECT count(*) AS total FROM account WHERE user_id = ? AND provider_id IN ('google', 'facebook')`,
  )
    .bind(readerId)
    .first<{ total: number }>();
  return row?.total ?? 0;
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
  failScheduling = false;
});

describe('Reader social identity HTTP boundary', () => {
  it('projects safe local associations as unavailable regardless of provider catalog membership', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-projection@example.com');
    const associationId = await addSocialIdentity({
      readerId: reader.id,
      provider: 'google',
      accountId: 'external-account-never-public',
    });
    const configured = await request(
      `/v1/admin/users/${reader.id}`,
      'GET',
      {
        cookie: administratorCookie,
      },
      { AUTH_SOCIAL_PROVIDERS: 'google' },
    );
    expect(configured.status).toBe(200);
    const raw = await configured.text();
    expect(raw).not.toContain('external-account-never-public');
    expect(raw).not.toContain('access-secret');
    expect(raw).not.toContain('refresh-secret');
    expect(raw).not.toContain('id-secret');
    expect(raw).not.toContain('profile email');
    const detail = JSON.parse(raw) as {
      socialIdentities: {
        associationId: string;
        provider: string;
        providerDisplayName: string;
        linkedAt: string;
        state: string;
      }[];
      methods: { type: string; provider?: string }[];
    };
    expect(detail.socialIdentities).toMatchObject([
      {
        associationId,
        provider: 'google',
        providerDisplayName: 'Google',
        state: 'unavailable',
      },
    ]);
    expect(typeof detail.socialIdentities[0]?.linkedAt).toBe('string');
    expect(Date.parse(detail.socialIdentities[0]?.linkedAt ?? '')).not.toBeNaN();
    expect(detail.methods).toEqual([{ type: 'password' }]);

    const unconfigured = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(await unconfigured.json()).toMatchObject({
      socialIdentities: [
        expect.objectContaining({
          provider: 'google',
          providerDisplayName: 'Social provider',
          state: 'unavailable',
        }),
      ],
      methods: [{ type: 'password' }],
    });
  });

  it('publishes the safe social-identity contract and account-owned unlink route', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-unlink-route@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const before = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(before.status).toBe(200);
    expect(before.headers.get('etag')).toBe('"1"');

    const removed = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-remove-1',
    );
    expect(removed.status).toBe(200);
    expect(removed.headers.get('cache-control')).toBe('private, no-store');
    expect(removed.headers.get('etag')).toBe('"2"');
    expect(await removed.json()).toEqual({ associationId, changed: true, revision: 2 });
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
    const notice = mailer.socialIdentityUnlinkNotices[0];
    expect(notice).toMatchObject({
      to: 'social-unlink-route@example.com',
      providerDisplayName: 'Google',
    });

    const replay = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-remove-1',
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ associationId, changed: true, revision: 2 });
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
    expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(1);
    const socialLifecycle = await workerEnv.DB.prepare(
      `SELECT metadata FROM identity_event WHERE subject_id=? AND type='social-identity-unlinked'`,
    )
      .bind(reader.id)
      .first<{ metadata: string }>();
    expect(JSON.parse(socialLifecycle?.metadata ?? '{}')).toMatchObject({
      associationId,
      provider: 'google',
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

    const activity = await request(`/v1/admin/users/${reader.id}/activity`, 'GET', {
      cookie: administratorCookie,
    });
    expect(activity.status).toBe(200);
    expect(await activity.json()).toMatchObject({
      items: [
        expect.objectContaining({
          type: 'social-identity-unlinked',
          metadata: { associationId, provider: 'google', revision: 2, revokedSessionCount: 1 },
        }),
      ],
    });
    const audit = await request('/v1/admin/audit-events?action=social-identity-unlinked', 'GET', {
      cookie: administratorCookie,
    });
    expect(audit.status).toBe(200);
    const auditBody = await audit.text();
    expect(auditBody).toContain('"associationId":"' + associationId + '"');
    expect(auditBody).toContain('"provider":"google"');
    expect(auditBody).toContain('"revision":2');
    expect(auditBody).toContain('"revokedSessionCount":1');
    expect(auditBody).not.toContain('external-account');
    expect(auditBody).not.toContain('access-secret');

    const after = await request(`/v1/admin/users/${reader.id}`, 'GET', {
      cookie: administratorCookie,
    });
    expect(await after.json()).toMatchObject({
      revision: 2,
      socialIdentities: [],
      methods: [{ type: 'password' }],
    });
  });

  it('does not let a configured social association justify removing the last real password method', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-last-method@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    await workerEnv.DB.prepare(
      "DELETE FROM account WHERE user_id = ? AND provider_id = 'credential'",
    )
      .bind(reader.id)
      .run();

    const response = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-last-method',
      { AUTH_SOCIAL_PROVIDERS: 'google' },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'no-usable-login-method' });
    expect(await socialAssociationCount(reader.id)).toBe(1);
    expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(0);
    expect(await socialEventCount(reader.id, 'social-unlink-attempt')).toBe(1);
  });

  it('does not project social associations as login methods when password is unavailable', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-unverified-method@example.com', false);
    await addSocialIdentity({ readerId: reader.id, provider: 'google' });

    const verificationRequired = await request(
      `/v1/admin/users/${reader.id}`,
      'GET',
      { cookie: administratorCookie },
      { AUTH_SOCIAL_PROVIDERS: 'google', AUTH_REQUIRE_EMAIL_VERIFICATION: 'true' },
    );
    expect(await verificationRequired.json()).toMatchObject({
      methods: [],
    });

    const emailPasswordDisabled = await request(
      `/v1/admin/users/${reader.id}`,
      'GET',
      { cookie: administratorCookie },
      {
        AUTH_SOCIAL_PROVIDERS: '',
        AUTH_EMAIL_PASSWORD_ENABLED: 'false',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
      },
    );
    expect(await emailPasswordDisabled.json()).toMatchObject({
      methods: [],
      socialIdentities: [expect.objectContaining({ state: 'unavailable' })],
    });
  });

  it('unlinks an unverified Reader successfully without scheduling a security notice', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-unverified-notice@example.com', false);
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const beforeNotices = mailer.socialIdentityUnlinkNotices.length;
    const response = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-unverified-no-notice',
      { AUTH_REQUIRE_EMAIL_VERIFICATION: 'false' },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ changed: true, revision: 2 });
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(beforeNotices);
  });

  it('treats absent and another Reader’s selectors as audited no-ops', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const first = await registerReader('social-selector-first@example.com');
    const second = await registerReader('social-selector-second@example.com');
    const foreignAssociation = await addSocialIdentity({
      readerId: second.id,
      provider: 'google',
    });
    const absentAssociation = crypto.randomUUID();

    for (const [associationId, key] of [
      [absentAssociation, 'social-absent-selector'],
      [foreignAssociation, 'social-foreign-selector'],
    ] as const) {
      const response = await unlink(first.id, associationId, administratorCookie, 1, key);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ associationId, changed: false, revision: 1 });
    }

    expect(await socialAssociationCount(second.id)).toBe(1);
    expect((await request('/v1/me', 'GET', { cookie: first.cookie })).status).toBe(200);
    expect(await socialEventCount(first.id, 'social-identity-unlinked')).toBe(0);
    expect(await socialEventCount(first.id, 'social-unlink-attempt')).toBe(2);

    const deletionAfterNoOp = await request(
      `/v1/admin/users/${first.id}/deletion-requests`,
      'POST',
      {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': 'social-no-op-followed-by-deletion' },
        body: {},
      },
    );
    expect(deletionAfterNoOp.status).toBe(201);
  });

  it('requires If-Match and Idempotency-Key and rejects stale revisions', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-preconditions@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const path = unlinkPath(reader.id, associationId);

    const missingMatch = await request(path, 'DELETE', {
      cookie: administratorCookie,
      headers: { 'idempotency-key': 'social-missing-match' },
    });
    expect(missingMatch.status).toBe(428);
    expect(await missingMatch.json()).toMatchObject({ code: 'precondition-required' });

    const missingKey = await request(path, 'DELETE', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"' },
    });
    expect(missingKey.status).toBe(428);
    expect(await missingKey.json()).toMatchObject({ code: 'precondition-required' });

    const stale = await unlink(reader.id, associationId, administratorCookie, 2, 'social-stale');
    expect(stale.status).toBe(412);
    expect(await stale.json()).toMatchObject({ code: 'stale-revision' });
    expect(await socialAssociationCount(reader.id)).toBe(1);
  });

  it('authorizes anonymous, Reader-realm, and disabled Administrator requests before unlinking', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-auth-order-reader@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const path = unlinkPath(reader.id, associationId);
    const headers = { 'if-match': '"1"', 'idempotency-key': 'social-auth-ordering' };

    const anonymous = await request(path, 'DELETE', { headers });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(await socialEventCount(reader.id, 'social-unlink-attempt')).toBe(0);

    const readerRealm = await request(path, 'DELETE', { cookie: reader.cookie, headers });
    expect(readerRealm.status).toBe(403);
    expect(readerRealm.headers.get('cache-control')).toBe('private, no-store');
    expect(await readerRealm.json()).toMatchObject({ code: 'forbidden' });
    expect(await socialEventCount(reader.id, 'social-unlink-attempt')).toBe(0);

    const administrator = await workerEnv.DB.prepare(
      `SELECT id FROM admin_user WHERE email='social-admin@example.com' LIMIT 1`,
    ).first<{ id: string }>();
    expect(administrator).not.toBeNull();
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state(user_id,state,revision,mutation_token,updated_at)
       VALUES(?,'disabled',1,NULL,?)
       ON CONFLICT(user_id) DO UPDATE SET state='disabled', revision=revision+1, updated_at=excluded.updated_at`,
    )
      .bind(administrator?.id, Date.now())
      .run();

    const disabled = await request(path, 'DELETE', { cookie: administratorCookie, headers });
    expect(disabled.status).toBe(403);
    expect(disabled.headers.get('cache-control')).toBe('private, no-store');
    expect(await disabled.json()).toMatchObject({ code: 'administrator-disabled' });
    expect(await socialEventCount(reader.id, 'social-unlink-attempt')).toBe(0);
    const failedAttempt = await workerEnv.DB.prepare(
      `SELECT result, problem_code, subject_id FROM identity_event
       WHERE actor_id=? AND type='social-unlink-attempt' ORDER BY occurred_at DESC LIMIT 1`,
    )
      .bind(administrator?.id)
      .first<{ result: string; problem_code: string | null; subject_id: string | null }>();
    expect(failedAttempt).toEqual({
      result: 'failure',
      problem_code: 'administrator-disabled',
      subject_id: null,
    });
    expect(await socialAssociationCount(reader.id)).toBe(1);
  });

  it('blocks unlink while a deletion request is active', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-active-deletion@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const deletion = await request(`/v1/admin/users/${reader.id}/deletion-requests`, 'POST', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"', 'idempotency-key': 'social-deletion-create' },
      body: {},
    });
    expect(deletion.status).toBe(201);

    const response = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      2,
      'social-blocked',
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: 'active-deletion-request' });
    expect(await socialAssociationCount(reader.id)).toBe(1);
  });

  it('rolls back association removal, session revocation, revision and ledger on D1 failure', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-atomicity@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_social_identity_delete
      BEFORE DELETE ON account WHEN OLD.id = '${associationId}'
      BEGIN SELECT RAISE(ABORT, 'forced unlink failure'); END`,
    ).run();

    try {
      const response = await unlink(
        reader.id,
        associationId,
        administratorCookie,
        1,
        'social-rollback',
      );
      expect(response.status).toBe(500);
      expect(await socialAssociationCount(reader.id)).toBe(1);
      expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(200);
      expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(0);
      expect(await successfulUnlinkAttemptCount(reader.id)).toBe(0);
      const idempotency = await workerEnv.DB.prepare(
        `SELECT count(*) AS total FROM admin_idempotency_record WHERE key = 'social-rollback'`,
      ).first<{ total: number }>();
      expect(idempotency?.total).toBe(0);
      const detail = await request(`/v1/admin/users/${reader.id}`, 'GET', {
        cookie: administratorCookie,
      });
      expect(detail.headers.get('etag')).toBe('"1"');
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER IF EXISTS reject_social_identity_delete').run();
    }
  });

  it('fails closed when the lifecycle audit insert fails', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-audit-failure@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_social_unlink_audit
      BEFORE INSERT ON identity_event WHEN NEW.type = 'social-identity-unlinked'
      BEGIN SELECT RAISE(ABORT, 'forced audit failure'); END`,
    ).run();

    try {
      const response = await unlink(
        reader.id,
        associationId,
        administratorCookie,
        1,
        'social-audit-failure',
      );
      expect(response.status).toBe(500);
      expect(await socialAssociationCount(reader.id)).toBe(1);
      expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(200);
      expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(0);
      expect(await successfulUnlinkAttemptCount(reader.id)).toBe(0);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER IF EXISTS reject_social_unlink_audit').run();
    }
  });

  it('retries post-commit notice scheduling with the same idempotency key', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-notice-retry@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    failScheduling = true;

    const failed = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-notice-retry',
    );
    expect(failed.status).toBe(503);
    expect(await socialAssociationCount(reader.id)).toBe(0);
    expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(1);

    failScheduling = false;
    const retried = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-notice-retry',
    );
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ associationId, changed: true, revision: 2 });
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
    const replay = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-notice-retry',
    );
    expect(replay.status).toBe(200);
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
  });

  it('does not redispatch after scheduling succeeded but the durable marker update failed', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-marker-failure@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    await workerEnv.DB.prepare(
      `CREATE TRIGGER reject_social_notice_marker
       BEFORE UPDATE OF retry_payload ON admin_idempotency_record
       WHEN OLD.key = 'social-marker-failure' AND NEW.retry_payload IS NULL
       BEGIN SELECT RAISE(ABORT, 'forced notice marker failure'); END`,
    ).run();
    try {
      const first = await unlink(
        reader.id,
        associationId,
        administratorCookie,
        1,
        'social-marker-failure',
      );
      expect(first.status).toBe(200);
      expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
      const retry = await unlink(
        reader.id,
        associationId,
        administratorCookie,
        1,
        'social-marker-failure',
      );
      expect(retry.status).toBe(200);
      expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER IF EXISTS reject_social_notice_marker').run();
    }
  });

  it('returns retryable in-progress for a same-key active claim and succeeds after claim release', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-active-claim@example.com');
    const associationId = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    failScheduling = true;
    const initial = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-active-claim',
    );
    expect(initial.status).toBe(503);

    const administrator = await workerEnv.DB.prepare(
      `SELECT id FROM admin_user WHERE email='social-admin@example.com' LIMIT 1`,
    ).first<{ id: string }>();
    expect(administrator).not.toBeNull();
    expect(
      await claimReaderSocialIdentityNotice({
        db: workerEnv.DB,
        administratorId: administrator?.id ?? '',
        readerId: reader.id,
        idempotencyKey: 'social-active-claim',
      }),
    ).toBe(true);
    const inProgress = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-active-claim',
    );
    expect(inProgress.status).toBe(503);
    expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(1);

    await releaseReaderSocialIdentityNoticeClaim({
      db: workerEnv.DB,
      administratorId: administrator?.id ?? '',
      readerId: reader.id,
      idempotencyKey: 'social-active-claim',
    });
    failScheduling = false;
    const eventual = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      1,
      'social-active-claim',
    );
    expect(eventual.status).toBe(200);
    expect(await eventual.json()).toMatchObject({ changed: true, revision: 2 });
    expect(mailer.socialIdentityUnlinkNotices).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key with a different association selector', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-idempotency-conflict@example.com');
    const firstAssociation = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const secondAssociation = await addSocialIdentity({
      readerId: reader.id,
      provider: 'facebook',
    });
    const first = await unlink(
      reader.id,
      firstAssociation,
      administratorCookie,
      1,
      'social-key-reused',
    );
    expect(first.status).toBe(200);

    const reused = await unlink(
      reader.id,
      secondAssociation,
      administratorCookie,
      1,
      'social-key-reused',
    );
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: 'idempotency-key-reused' });
    expect(await socialAssociationCount(reader.id)).toBe(1);
  });

  it('serializes concurrent commands against the account revision', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-concurrent@example.com');
    const association = await addSocialIdentity({ readerId: reader.id, provider: 'google' });
    const [first, second] = await Promise.all([
      unlink(reader.id, association, administratorCookie, 1, 'social-race-first'),
      unlink(reader.id, association, administratorCookie, 1, 'social-race-second'),
    ]);
    expect([first.status, second.status].sort((a, b) => a - b)).toEqual([200, 412]);
    expect(await socialAssociationCount(reader.id)).toBe(0);
    expect(await socialEventCount(reader.id, 'social-identity-unlinked')).toBe(1);
  });

  it('fences a no-op against a concurrent revision change and does not record success', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-noop-revision-race@example.com');
    const absentAssociation = crypto.randomUUID();
    const [noop, revisionChange] = await Promise.all([
      unlink(reader.id, absentAssociation, administratorCookie, 1, 'social-noop-revision-race'),
      request(`/v1/admin/users/${reader.id}/access`, 'PUT', {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"' },
        body: { state: 'disabled' },
      }),
    ]);
    expect([noop.status, revisionChange.status]).toContain(200);
    const stored = await workerEnv.DB.prepare(
      `SELECT count(*) AS total FROM admin_idempotency_record WHERE key='social-noop-revision-race'`,
    ).first<{ total: number }>();
    if (revisionChange.status === 200) {
      expect(noop.status).toBe(412);
      expect(stored?.total).toBe(0);
      expect(await successfulUnlinkAttemptCount(reader.id)).toBe(0);
    } else {
      expect(noop.status).toBe(200);
      expect(stored?.total).toBe(1);
    }
  });

  it('fences a no-op against a concurrent active deletion request', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-noop-deletion-race@example.com');
    const absentAssociation = crypto.randomUUID();
    const [noop, deletion] = await Promise.all([
      unlink(reader.id, absentAssociation, administratorCookie, 1, 'social-noop-deletion-race'),
      request(`/v1/admin/users/${reader.id}/deletion-requests`, 'POST', {
        cookie: administratorCookie,
        headers: { 'if-match': '"1"', 'idempotency-key': 'social-deletion-race' },
        body: {},
      }),
    ]);
    expect(deletion.status).toBe(201);
    if (noop.status === 200) {
      expect(await successfulUnlinkAttemptCount(reader.id)).toBe(1);
    } else {
      expect([409, 412]).toContain(noop.status);
      expect(await successfulUnlinkAttemptCount(reader.id)).toBe(0);
      const stored = await workerEnv.DB.prepare(
        `SELECT count(*) AS total FROM admin_idempotency_record WHERE key='social-noop-deletion-race'`,
      ).first<{ total: number }>();
      expect(stored?.total).toBe(0);
    }
  });

  it('allows managing a disabled Reader and keeps audit metadata free of provider data', async () => {
    const administratorCookie = await bootstrapAdministrator();
    const reader = await registerReader('social-disabled-reader@example.com');
    const associationId = await addSocialIdentity({
      readerId: reader.id,
      provider: 'facebook',
      accountId: 'external-facebook-account-secret',
    });
    const disabled = await request(`/v1/admin/users/${reader.id}/access`, 'PUT', {
      cookie: administratorCookie,
      headers: { 'if-match': '"1"' },
      body: { state: 'disabled' },
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ state: 'disabled', revision: 2 });

    const response = await unlink(
      reader.id,
      associationId,
      administratorCookie,
      2,
      'social-disabled-reader',
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ associationId, changed: true, revision: 3 });
    expect((await request('/v1/me', 'GET', { cookie: reader.cookie })).status).toBe(401);

    const event = await workerEnv.DB.prepare(
      `SELECT metadata FROM identity_event WHERE subject_id = ? AND type = 'social-identity-unlinked'`,
    )
      .bind(reader.id)
      .first<{ metadata: string | null }>();
    expect(event?.metadata).toBeTypeOf('string');
    expect(event?.metadata).not.toContain('external-facebook-account-secret');
    expect(event?.metadata).not.toContain('access-secret');
    expect(event?.metadata).not.toContain('refresh-secret');
    expect(event?.metadata).not.toContain('id-secret');
  });
});
