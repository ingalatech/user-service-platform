import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

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
const executionContext = {
  waitUntil: () => undefined,
  passThroughOnException: () => undefined,
  props: {},
};
const app = createApp({ authMailer: mailer });

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    testEnv(),
    executionContext,
  );
}

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(
    path,
    { method: 'GET', headers: cookie === undefined ? {} : { cookie } },
    testEnv(),
    executionContext,
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
    executionContext,
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
    name: 'Audit Administrator',
    email: 'audit-admin@example.com',
    password: 'Correct-horse-41',
  });
  expect(bootstrap.status).toBe(201);
  const result = (await bootstrap.json()) as { id: string };
  expect(
    (await post('/v1/admin/auth/request-verification', { email: 'audit-admin@example.com' }))
      .status,
  ).toBe(202);
  expect((await post('/v1/admin/auth/verify-email', { token: verificationToken() })).status).toBe(
    200,
  );
  const login = await post('/v1/admin/auth/login', {
    email: 'audit-admin@example.com',
    password: 'Correct-horse-41',
  });
  expect(login.status).toBe(200);
  return { cookie: sessionCookieFrom(login), id: result.id };
}

async function registerVerifiedReader(email: string): Promise<{ id: string; cookie: string }> {
  const registration = await post('/v1/auth/register', {
    name: 'Audit Reader',
    email,
    password: 'Correct-horse-42',
  });
  expect(registration.status).toBe(201);
  const reader = (await registration.json()) as { id: string };
  expect((await post('/v1/auth/request-verification', { email })).status).toBe(202);
  expect((await post('/v1/auth/verify-email', { token: verificationToken() })).status).toBe(200);
  const login = await post('/v1/auth/login', { email, password: 'Correct-horse-42' });
  expect(login.status).toBe(200);
  return { id: reader.id, cookie: sessionCookieFrom(login) };
}

async function seedEvent(input: {
  readonly id: string;
  readonly version?: number;
  readonly type: string;
  readonly occurredAt: number;
  readonly actorRealm: string;
  readonly actorId: string;
  readonly subjectRealm?: string | null;
  readonly subjectId?: string | null;
  readonly result: 'success' | 'failure';
  readonly requestId: string;
  readonly problemCode?: string | null;
  readonly metadata?: unknown;
}): Promise<void> {
  await workerEnv.DB.prepare(
    `INSERT INTO identity_event
     (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
      result, request_id, problem_code, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      input.id,
      input.version ?? 1,
      input.type,
      input.occurredAt,
      input.actorRealm,
      input.actorId,
      input.subjectRealm ?? null,
      input.subjectId ?? null,
      input.result,
      input.requestId,
      input.problemCode ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}

async function ledgerCount(): Promise<number> {
  const result = await workerEnv.DB.prepare('SELECT count(*) AS count FROM identity_event').first<{
    count: number;
  }>();
  return result?.count ?? 0;
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
    db.prepare('DELETE FROM session'),
    db.prepare('DELETE FROM account'),
    db.prepare('DELETE FROM verification'),
    db.prepare('DELETE FROM email_verification_token'),
    db.prepare('DELETE FROM user'),
  ]);
  mailer.clear();
});

describe('GET /v1/admin/audit-events', () => {
  it('publishes its filters and responses in the generated OpenAPI document', async () => {
    const response = await get('/v1/openapi.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as {
      paths: Record<
        string,
        {
          get?: {
            parameters?: { name: string }[];
            responses?: Record<string, unknown>;
          };
        }
      >;
    };
    const operation = document.paths['/v1/admin/audit-events']?.get;
    expect(operation).toBeDefined();
    expect(operation?.parameters?.map((parameter) => parameter.name).sort()).toEqual([
      'action',
      'actorId',
      'cursor',
      'from',
      'limit',
      'result',
      'to',
    ]);
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '500',
      'default',
    ]);
    const schemas = (
      document as typeof document & {
        components: { schemas: Record<string, Record<string, unknown>> };
      }
    ).components.schemas;
    const auditEvent = schemas.AdminAuditEvent;
    const eventProperties = auditEvent?.properties as Record<string, Record<string, unknown>>;
    expect(schemas.AdminAuditEvents?.additionalProperties).toBe(false);
    expect(auditEvent?.additionalProperties).toBe(false);
    expect(eventProperties.actor?.additionalProperties).toBe(false);
    expect(eventProperties.subject?.additionalProperties).toBe(false);
    expect(schemas.AdminAuditMetadata?.additionalProperties).toBe(false);
  });

  it('authorizes before reading and leaves anonymous, Reader, disabled, validation, and unknown-route failures unaudited', async () => {
    const actor = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('audit-reader@example.com');
    await workerEnv.DB.prepare(
      `INSERT INTO administrator_access_state (user_id, state, revision, updated_at)
       VALUES (?, 'disabled', 2, ?)`,
    )
      .bind(actor.id, Date.now())
      .run();
    await workerEnv.DB.prepare('DELETE FROM identity_event').run();

    const anonymous = await get('/v1/admin/audit-events');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('private, no-store');
    expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });

    const readerResponse = await get('/v1/admin/audit-events', reader.cookie);
    expect(readerResponse.status).toBe(403);
    expect(readerResponse.headers.get('cache-control')).toBe('private, no-store');

    const disabledActor = await get('/v1/admin/audit-events', actor.cookie);
    expect(disabledActor.status).toBe(403);
    expect(await disabledActor.json()).toMatchObject({ code: 'administrator-disabled' });

    const invalidQuery = await get('/v1/admin/audit-events?limit=51', actor.cookie);
    expect(invalidQuery.status).toBe(400);
    expect(invalidQuery.headers.get('cache-control')).toBe('private, no-store');
    const missingRoute = await get('/v1/admin/audit-events/unknown', actor.cookie);
    expect(missingRoute.status).toBe(404);
    expect(await ledgerCount()).toBe(0);
  });

  it('returns allowlisted administrative rows and separates failed attempts from Account Activity', async () => {
    const actor = await bootstrapAdministrator();
    const reader = await registerVerifiedReader('ledger-subject@example.com');
    await workerEnv.DB.prepare('DELETE FROM identity_event').run();
    const occurredAt = Date.UTC(2026, 0, 2);
    await seedEvent({
      id: 'audit-success',
      type: 'email-verification-requested',
      occurredAt,
      actorRealm: 'administrator',
      actorId: actor.id,
      subjectRealm: 'reader',
      subjectId: reader.id,
      result: 'success',
      requestId: 'request-audit-success',
      metadata: {
        workflowId: 'opaque-workflow-1',
        email: 'private@example.com',
        name: 'Private Person',
        token: 'secret-token',
        password: 'secret-password',
        ip: '192.0.2.44',
        userAgent: 'private user agent',
        emailBody: 'private message body',
        sql: 'select * from user',
        providerResponse: 'provider payload',
      },
    });
    await seedEvent({
      id: 'audit-failure',
      type: 'email-verification-attempt',
      occurredAt: occurredAt + 1_000,
      actorRealm: 'administrator',
      actorId: actor.id,
      subjectRealm: 'reader',
      subjectId: reader.id,
      result: 'failure',
      requestId: 'request-audit-failure',
      problemCode: 'stale-revision',
      metadata: { changed: false, token: 'second-secret', email: 'hidden@example.com' },
    });
    await seedEvent({
      id: 'reader-origin-event',
      type: 'email-verified',
      occurredAt: occurredAt + 2_000,
      actorRealm: 'reader',
      actorId: reader.id,
      subjectRealm: 'reader',
      subjectId: reader.id,
      result: 'success',
      requestId: 'reader-request',
    });
    await seedEvent({
      id: 'system-origin-event',
      type: 'provider.delivery-failed',
      occurredAt: occurredAt + 3_000,
      actorRealm: 'system',
      actorId: 'system',
      subjectRealm: 'reader',
      subjectId: reader.id,
      result: 'failure',
      requestId: 'system-request',
    });
    await seedEvent({
      id: 'unknown-admin-event',
      type: 'future-admin-action',
      occurredAt: occurredAt + 4_000,
      actorRealm: 'administrator',
      actorId: actor.id,
      result: 'success',
      requestId: 'unknown-admin-request',
    });
    await seedEvent({
      id: 'unsupported-event-version',
      version: 0,
      type: 'email-verification-attempt',
      occurredAt: occurredAt + 5_000,
      actorRealm: 'administrator',
      actorId: actor.id,
      result: 'failure',
      requestId: 'unsupported-version-request',
      problemCode: 'stale-revision',
    });

    const auditResponse = await get(`/v1/admin/audit-events?actorId=${actor.id}`, actor.cookie);

    expect(auditResponse.status).toBe(200);
    expect(auditResponse.headers.get('cache-control')).toBe('private, no-store');
    const audit = (await auditResponse.json()) as {
      items: {
        id: string;
        version: number;
        type: string;
        occurredAt: string;
        actor: { id: string; realm: string };
        subject: { id: string; realm: string } | null;
        result: string;
        requestId: string;
        problemCode: string | null;
        metadata: Record<string, unknown> | null;
      }[];
      nextCursor: string | null;
    };
    expect(audit.items.map((event) => event.id)).toEqual(['audit-failure', 'audit-success']);
    expect(audit.items[0]).toMatchObject({
      version: 1,
      type: 'email-verification-attempt',
      actor: { id: actor.id, realm: 'administrator' },
      subject: { id: reader.id, realm: 'reader' },
      result: 'failure',
      requestId: 'request-audit-failure',
      problemCode: 'stale-revision',
      metadata: { changed: false },
    });
    expect(Object.keys(audit.items[0] ?? {}).sort()).toEqual([
      'actor',
      'id',
      'metadata',
      'occurredAt',
      'problemCode',
      'requestId',
      'result',
      'subject',
      'type',
      'version',
    ]);
    const serializedAudit = JSON.stringify(audit);
    for (const secret of [
      'private@example.com',
      'Private Person',
      'secret-token',
      'secret-password',
      '192.0.2.44',
      'private user agent',
      'private message body',
      'select * from user',
      'provider payload',
      'second-secret',
      'hidden@example.com',
      'reader-origin-event',
      'system-origin-event',
      'unknown-admin-event',
      'unsupported-event-version',
    ]) {
      expect(serializedAudit).not.toContain(secret);
    }

    const activityResponse = await get(`/v1/admin/users/${reader.id}/activity`, actor.cookie);
    expect(activityResponse.status).toBe(200);
    const activity = JSON.stringify(await activityResponse.json());
    expect(activity).toContain('audit-success');
    expect(activity).not.toContain('audit-failure');
  });

  it('paginates newest-first and applies actor, action, result, and time filters', async () => {
    const actor = await bootstrapAdministrator();
    await workerEnv.DB.prepare('DELETE FROM identity_event').run();
    const occurredAt = Date.UTC(2025, 0, 1);
    for (const [id, offset, result] of [
      ['audit-page-1', 1_000, 'success'],
      ['audit-page-2', 2_000, 'failure'],
      ['audit-page-3', 3_000, 'success'],
    ] as const) {
      await seedEvent({
        id,
        type: 'access-attempt',
        occurredAt: occurredAt + offset,
        actorRealm: 'administrator',
        actorId: actor.id,
        result,
        requestId: `request-${id}`,
        problemCode: result === 'failure' ? 'stale-revision' : null,
        metadata: { changed: result === 'success' },
      });
    }

    const firstPage = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&limit=2`,
      actor.cookie,
    );
    expect(firstPage.status).toBe(200);
    const first = (await firstPage.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(first.items.map((event) => event.id)).toEqual(['audit-page-3', 'audit-page-2']);
    expect(first.nextCursor).not.toBeNull();
    expect(first.nextCursor).not.toContain('audit-page-2');

    const secondPage = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      actor.cookie,
    );
    expect(secondPage.status).toBe(200);
    expect(await secondPage.json()).toMatchObject({
      items: [{ id: 'audit-page-1' }],
      nextCursor: null,
    });

    const invalidCursor = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&cursor=not-a-cursor`,
      actor.cookie,
    );
    expect(invalidCursor.status).toBe(400);
    expect(invalidCursor.headers.get('cache-control')).toBe('private, no-store');

    const filtered = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&result=failure&from=${encodeURIComponent(new Date(occurredAt + 1_500).toISOString())}&to=${encodeURIComponent(new Date(occurredAt + 2_500).toISOString())}`,
      actor.cookie,
    );
    expect(filtered.status).toBe(200);
    expect(await filtered.json()).toMatchObject({
      items: [{ id: 'audit-page-2' }],
      nextCursor: null,
    });

    const absentActor = await get('/v1/admin/audit-events?actorId=no-such-actor', actor.cookie);
    expect(absentActor.status).toBe(200);
    expect(await absentActor.json()).toEqual({ items: [], nextCursor: null });
  });

  it('continues opaque pagination after redacting rows that fail the safe projection', async () => {
    const actor = await bootstrapAdministrator();
    await workerEnv.DB.prepare('DELETE FROM identity_event').run();
    const occurredAt = Date.UTC(2025, 0, 1);
    await seedEvent({
      id: 'audit-invalid-time-shape',
      type: 'access-attempt',
      occurredAt: 8_640_000_000_000_000,
      actorRealm: 'administrator',
      actorId: actor.id,
      result: 'success',
      requestId: 'invalid-time-shape-request',
    });
    await seedEvent({
      id: 'audit-invalid-newest',
      type: 'access-attempt',
      occurredAt: occurredAt + 4_000,
      actorRealm: 'administrator',
      actorId: actor.id,
      result: 'success',
      requestId: 'private@example.com',
    });
    for (const [id, offset] of [
      ['audit-valid-3', 3_000],
      ['audit-valid-2', 2_000],
      ['audit-valid-1', 1_000],
    ] as const) {
      await seedEvent({
        id,
        type: 'access-attempt',
        occurredAt: occurredAt + offset,
        actorRealm: 'administrator',
        actorId: actor.id,
        result: 'success',
        requestId: `request-${id}`,
      });
    }

    const firstResponse = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&limit=2`,
      actor.cookie,
    );
    expect(firstResponse.status).toBe(200);
    expect(firstResponse.headers.get('cache-control')).toBe('private, no-store');
    const firstPage = (await firstResponse.json()) as {
      items: { id: string }[];
      nextCursor: string | null;
    };
    expect(firstPage.items.map((event) => event.id)).toEqual(['audit-valid-3', 'audit-valid-2']);
    expect(firstPage.nextCursor).not.toBeNull();
    expect(JSON.stringify(firstPage)).not.toContain('private@example.com');
    expect(JSON.stringify(firstPage)).not.toContain('audit-invalid-time-shape');

    const secondResponse = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&limit=2&cursor=${encodeURIComponent(firstPage.nextCursor ?? '')}`,
      actor.cookie,
    );
    expect(secondResponse.status).toBe(200);
    expect(await secondResponse.json()).toMatchObject({
      items: [{ id: 'audit-valid-1' }],
      nextCursor: null,
    });
    expect(JSON.stringify([firstPage])).not.toContain('private@example.com');
  });

  it('shows an authenticated command failure with its stable problem code', async () => {
    const actor = await bootstrapAdministrator();
    const target = await workerEnv.DB.prepare(
      `SELECT id FROM admin_user WHERE id <> ? AND role = 'admin' LIMIT 1`,
    )
      .bind(actor.id)
      .first<{ id: string }>();
    if (target !== null)
      await workerEnv.DB.prepare('DELETE FROM admin_user WHERE id = ?').bind(target.id).run();
    const targetId = 'audit-stale-target';
    const now = Math.floor(Date.now() / 1_000);
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO admin_user
         (id, name, email, email_verified, created_at, updated_at, role, banned)
         VALUES (?, 'Audit Target', 'audit-target@example.com', 1, ?, ?, 'admin', 0)`,
      ).bind(targetId, now, now),
      workerEnv.DB.prepare(
        `INSERT INTO administrator_access_state
         (user_id, state, revision, mutation_token, updated_at)
         VALUES (?, 'active', 1, NULL, ?)`,
      ).bind(targetId, Date.now()),
      workerEnv.DB.prepare('DELETE FROM identity_event'),
    ]);

    const stale = await put(
      `/v1/admin/administrators/${targetId}/access`,
      { state: 'disabled' },
      actor.cookie,
      { 'if-match': '"9"' },
    );
    expect(stale.status).toBe(412);

    const audit = await get(
      `/v1/admin/audit-events?actorId=${actor.id}&action=access-attempt&result=failure`,
      actor.cookie,
    );
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({
      items: [{ actor: { id: actor.id }, result: 'failure', problemCode: 'stale-revision' }],
      nextCursor: null,
    });
  });
});
