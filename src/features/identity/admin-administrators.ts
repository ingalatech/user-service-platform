import type { D1Database } from '@cloudflare/workers-types';
import { and, asc, count, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { createAdministrationAuth } from './auth.js';
import { authorizeAdministrator } from './admin-authorization.js';
import type {
  AdminAdministratorAccessRequest,
  AdminAdministratorAccessResult,
  AdminAdministratorDetail,
  AdminAdministratorActivity,
  AdminAdministratorList,
  AdminAdministratorListQuery,
} from './contract.js';
import {
  adminAccount,
  administratorAccessState,
  administratorMessageWorkflow,
  adminUser,
  identitySchema,
} from './schema.js';

function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

export type AdminAdministratorListOutcome =
  | { readonly kind: 'success'; readonly value: AdminAdministratorList }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' };

export type AdminAdministratorDetailOutcome =
  | { readonly kind: 'success'; readonly value: AdminAdministratorDetail }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'administrator-not-found' };

export type AdminAdministratorAccessOutcome =
  | { readonly kind: 'success'; readonly value: AdminAdministratorAccessResult }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'administrator-not-found' }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'precondition-required' }
  | { readonly kind: 'stale-revision' }
  | { readonly kind: 'self-disable-forbidden' }
  | { readonly kind: 'last-operational-administrator' }
  | { readonly kind: 'internal-error' };

type IfMatchResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'revision'; readonly revision: number };

function parseIfMatch(value: string | undefined): IfMatchResult {
  if (value === undefined) return { kind: 'missing' };
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return { kind: 'malformed' };
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? { kind: 'revision', revision } : { kind: 'malformed' };
}

type AccessFailureKind = Exclude<
  AdminAdministratorAccessOutcome,
  { readonly kind: 'success' } | { readonly kind: 'internal-error' }
>['kind'];

async function auditAccessAttempt(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string | null;
  readonly requestId: string;
  readonly result: 'success' | 'failure';
  readonly problemCode?: AccessFailureKind | 'internal-error';
  readonly changed?: boolean;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO identity_event
       (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
        result, request_id, problem_code, metadata)
       VALUES (?, 1, 'access-attempt', ?, 'administrator', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      Date.now(),
      input.actorId,
      input.subjectId === null ? null : 'administrator',
      input.subjectId,
      input.result,
      input.requestId,
      input.problemCode ?? null,
      input.changed === undefined ? null : JSON.stringify({ changed: input.changed }),
    )
    .run();
}

async function auditedAccessFailure(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string | null;
  readonly requestId: string;
  readonly kind: AccessFailureKind;
}): Promise<AdminAdministratorAccessOutcome> {
  try {
    await auditAccessAttempt({
      ...input,
      result: 'failure',
      problemCode: input.kind,
    });
    return { kind: input.kind };
  } catch {
    return { kind: 'internal-error' };
  }
}

interface AdministratorAccessTarget {
  readonly id: string;
  readonly state: string | null;
  readonly revision: number | null;
}

async function readAccessTarget(
  db: D1Database,
  administratorId: string,
): Promise<AdministratorAccessTarget | null> {
  return db
    .prepare(
      `SELECT admin_user.id, administrator_access_state.state, administrator_access_state.revision
			 FROM admin_user
			 LEFT JOIN administrator_access_state
			   ON administrator_access_state.user_id = admin_user.id
			 WHERE admin_user.id = ? AND admin_user.role = 'admin'`,
    )
    .bind(administratorId)
    .first<AdministratorAccessTarget>();
}

export async function setAdminAdministratorAccess(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly actorId: string;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly request: AdminAdministratorAccessRequest;
  readonly requestId: string;
  readonly emailPasswordEnabled: boolean;
}): Promise<AdminAdministratorAccessOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.auth,
      db: input.db,
      administratorId: input.actorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: authorization.kind,
    });
  }
  const parsedIfMatch = parseIfMatch(input.ifMatch);
  if (parsedIfMatch.kind === 'missing') {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }
  if (parsedIfMatch.kind === 'malformed') {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'bad-request',
    });
  }
  const target = await readAccessTarget(input.db, input.administratorId);
  if (target === null) {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'administrator-not-found',
    });
  }
  const expected = parsedIfMatch.revision;
  const revision = target.revision ?? 1;
  if (expected !== revision) {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: target.id,
      requestId: input.requestId,
      kind: 'stale-revision',
    });
  }
  const currentState = target.state === 'disabled' ? 'disabled' : 'active';
  if (input.request.state === 'disabled' && input.actorId === target.id) {
    return auditedAccessFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: target.id,
      requestId: input.requestId,
      kind: 'self-disable-forbidden',
    });
  }
  if (input.request.state === currentState) {
    try {
      await auditAccessAttempt({
        db: input.db,
        actorId: input.actorId,
        subjectId: target.id,
        requestId: input.requestId,
        result: 'success',
        changed: false,
      });
    } catch {
      return { kind: 'internal-error' };
    }
    return {
      kind: 'success',
      value: { state: currentState, changed: false, revision },
    };
  }

  const nextRevision = revision + 1;
  const now = Date.now();
  const nowSeconds = Math.floor(now / 1_000);
  const mutationToken = crypto.randomUUID();
  const eventType = input.request.state === 'disabled' ? 'access-disabled' : 'access-rehabilitated';
  const operationalGuard =
    input.request.state === 'disabled'
      ? `AND (
           NOT EXISTS (
             SELECT 1 FROM admin_user AS target_user
             WHERE target_user.id = ? AND target_user.role = 'admin'
               AND target_user.email_verified = 1 AND ? = 1
               AND (target_user.banned = 0 OR
                    (target_user.ban_expires IS NOT NULL AND target_user.ban_expires <= ?))
               AND EXISTS (
                 SELECT 1 FROM admin_account AS target_account
                 WHERE target_account.user_id = target_user.id
                   AND target_account.provider_id = 'credential'
                   AND target_account.password IS NOT NULL
                   AND length(target_account.password) > 0
               )
           )
           OR EXISTS (
             SELECT 1 FROM admin_user AS other
             LEFT JOIN administrator_access_state AS other_access ON other_access.user_id = other.id
             WHERE other.role = 'admin' AND other.id <> ? AND other.email_verified = 1
               AND COALESCE(other_access.state, 'active') = 'active' AND ? = 1
               AND (other.banned = 0 OR
                    (other.ban_expires IS NOT NULL AND other.ban_expires <= ?))
               AND EXISTS (
                 SELECT 1 FROM admin_account AS other_account
                 WHERE other_account.user_id = other.id
                    AND other_account.provider_id = 'credential'
                    AND other_account.password IS NOT NULL
                    AND length(other_account.password) > 0
               )
           )
         )`
      : '';
  try {
    const updateBindings: (string | number)[] = [
      input.request.state,
      nextRevision,
      mutationToken,
      now,
      target.id,
      revision,
    ];
    if (input.request.state === 'disabled') {
      updateBindings.push(
        target.id,
        input.emailPasswordEnabled ? 1 : 0,
        nowSeconds,
        target.id,
        input.emailPasswordEnabled ? 1 : 0,
        nowSeconds,
      );
    }
    const results = await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO administrator_access_state
           (user_id, state, revision, mutation_token, updated_at)
           VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(target.id, currentState, revision, mutationToken, now),
      input.db
        .prepare(
          `UPDATE administrator_access_state
						 SET state = ?, revision = ?, mutation_token = ?, updated_at = ?
						 WHERE user_id = ? AND revision = ? ${operationalGuard}`,
        )
        .bind(...updateBindings),
      input.db
        .prepare(
          `DELETE FROM admin_session WHERE user_id = ?
					 AND ? = 'disabled'
					 AND EXISTS (
					   SELECT 1 FROM administrator_access_state
					   WHERE user_id = ? AND state = 'disabled' AND revision = ?
					     AND mutation_token = ?
					 )`,
        )
        .bind(target.id, input.request.state, target.id, nextRevision, mutationToken),
      input.db
        .prepare(
          `INSERT INTO identity_event
					 (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
					  result, request_id, problem_code, metadata)
					 SELECT ?, 1, ?, ?, 'administrator', ?, 'administrator', ?, 'success', ?, NULL, ?
					 WHERE EXISTS (
					   SELECT 1 FROM administrator_access_state
						   WHERE user_id = ? AND state = ? AND revision = ?
						     AND mutation_token = ?
					 ) AND NOT EXISTS (
					   SELECT 1 FROM identity_event
					   WHERE subject_realm = 'administrator' AND subject_id = ? AND type = ?
					     AND json_extract(metadata, '$.revision') = ?
					 )`,
        )
        .bind(
          crypto.randomUUID(),
          eventType,
          now,
          input.actorId,
          target.id,
          input.requestId,
          JSON.stringify({ revision: nextRevision }),
          target.id,
          input.request.state,
          nextRevision,
          mutationToken,
          target.id,
          eventType,
          nextRevision,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'access-attempt', ?, 'administrator', ?, 'administrator', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM administrator_access_state
             WHERE user_id = ? AND state = ? AND revision = ? AND mutation_token = ?
           )`,
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.actorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed: true }),
          target.id,
          input.request.state,
          nextRevision,
          mutationToken,
        ),
    ]);
    if (results[1]?.meta.changes !== 1) {
      const current = await readAccessTarget(input.db, target.id);
      if (current !== null && (current.revision ?? 1) !== revision) {
        return await auditedAccessFailure({
          db: input.db,
          actorId: input.actorId,
          subjectId: target.id,
          requestId: input.requestId,
          kind: 'stale-revision',
        });
      }
      return await auditedAccessFailure({
        db: input.db,
        actorId: input.actorId,
        subjectId: target.id,
        requestId: input.requestId,
        kind:
          input.request.state === 'disabled' ? 'last-operational-administrator' : 'stale-revision',
      });
    }
    return {
      kind: 'success',
      value: { state: input.request.state, changed: true, revision: nextRevision },
    };
  } catch {
    try {
      await auditAccessAttempt({
        db: input.db,
        actorId: input.actorId,
        subjectId: target.id,
        requestId: input.requestId,
        result: 'failure',
        problemCode: 'internal-error',
      });
    } catch {
      // Return the same internal failure whether the mutation or its audit failed.
    }
    return { kind: 'internal-error' };
  }
}

const ADMINISTRATOR_ACTIVITY_TYPES = [
  'email-verified',
  'email-verification-requested',
  'password-recovery-requested',
  'sessions-revoked',
  'access-disabled',
  'access-rehabilitated',
] as const;

export type AdminAdministratorActivityOutcome =
  | { readonly kind: 'success'; readonly value: AdminAdministratorActivity }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'administrator-not-found' }
  | { readonly kind: 'bad-cursor' };

function decodeActivityCursor(value: string): { occurredAt: number; id: string } | null {
  try {
    const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
    const decoded: unknown = JSON.parse(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')));
    if (
      typeof decoded !== 'object' ||
      decoded === null ||
      !('occurredAt' in decoded) ||
      !('id' in decoded) ||
      typeof decoded.occurredAt !== 'number' ||
      !Number.isSafeInteger(decoded.occurredAt) ||
      typeof decoded.id !== 'string' ||
      decoded.id.length === 0
    ) {
      return null;
    }
    return { occurredAt: decoded.occurredAt, id: decoded.id };
  } catch {
    return null;
  }
}

function encodeActivityCursor(cursor: { occurredAt: number; id: string }): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export async function readAdminAdministratorActivity(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly actorId: string;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<AdminAdministratorActivityOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.auth,
    db: input.db,
    administratorId: input.actorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') return { kind: authorization.kind };
  const target = await input.db
    .prepare(`SELECT id FROM admin_user WHERE id = ? AND role = 'admin'`)
    .bind(input.administratorId)
    .first();
  if (target === null) return { kind: 'administrator-not-found' };
  const cursor = input.cursor === undefined ? undefined : decodeActivityCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) return { kind: 'bad-cursor' };
  const placeholders = ADMINISTRATOR_ACTIVITY_TYPES.map(() => '?').join(', ');
  const cursorClause =
    cursor === undefined ? '' : 'AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
  const bindings: (string | number)[] = [input.administratorId, ...ADMINISTRATOR_ACTIVITY_TYPES];
  if (cursor !== undefined && cursor !== null) {
    bindings.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  bindings.push(input.limit + 1);
  const result = await input.db
    .prepare(
      `SELECT id, type, occurred_at, actor_id
			 FROM identity_event
			 WHERE subject_realm = 'administrator' AND subject_id = ?
			   AND actor_realm = 'administrator' AND result = 'success' AND version = 1
			   AND type IN (${placeholders}) ${cursorClause}
			 ORDER BY occurred_at DESC, id DESC LIMIT ?`,
    )
    .bind(...bindings)
    .all<{
      id: string;
      type: (typeof ADMINISTRATOR_ACTIVITY_TYPES)[number];
      occurred_at: number;
      actor_id: string;
    }>();
  const rows = result.results.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    kind: 'success',
    value: {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        occurredAt: new Date(row.occurred_at).toISOString(),
        actor: { id: row.actor_id, realm: 'administrator' },
      })),
      nextCursor:
        result.results.length > input.limit && last !== undefined
          ? encodeActivityCursor({ occurredAt: last.occurred_at, id: last.id })
          : null,
    },
  };
}

export async function getAdminAdministrator(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly actorId: string;
  readonly administratorId: string;
  readonly headers: Headers;
}): Promise<AdminAdministratorDetailOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.auth,
    db: input.db,
    administratorId: input.actorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') return { kind: authorization.kind };

  const database = drizzle(input.db, { schema: identitySchema });
  const rows = await database
    .select({
      id: adminUser.id,
      email: adminUser.email,
      emailVerified: adminUser.emailVerified,
      role: adminUser.role,
      createdAt: adminUser.createdAt,
      updatedAt: adminUser.updatedAt,
      state: administratorAccessState.state,
      revision: administratorAccessState.revision,
    })
    .from(adminUser)
    .leftJoin(administratorAccessState, eq(administratorAccessState.userId, adminUser.id))
    .where(and(eq(adminUser.id, input.administratorId), eq(adminUser.role, 'admin')))
    .limit(1);
  const row = rows[0];
  if (row === undefined) return { kind: 'administrator-not-found' };
  const accounts = await database
    .select({ providerId: adminAccount.providerId, password: adminAccount.password })
    .from(adminAccount)
    .where(eq(adminAccount.userId, row.id));
  const workflowRows = await database
    .select({
      kind: administratorMessageWorkflow.kind,
      state: administratorMessageWorkflow.state,
      cooldownUntil: administratorMessageWorkflow.cooldownUntil,
      lastScheduledAt: administratorMessageWorkflow.lastScheduledAt,
      updatedAt: administratorMessageWorkflow.updatedAt,
    })
    .from(administratorMessageWorkflow)
    .where(eq(administratorMessageWorkflow.userId, row.id));
  const messageWorkflows: AdminAdministratorDetail['messageWorkflows'] = {
    emailVerification: null,
    passwordRecovery: null,
  };
  for (const workflow of workflowRows) {
    if (
      (workflow.kind !== 'email-verification' && workflow.kind !== 'password-recovery') ||
      (workflow.state !== 'pending' &&
        workflow.state !== 'scheduled' &&
        workflow.state !== 'scheduling-failed')
    ) {
      continue;
    }
    const projected = {
      kind: workflow.kind,
      state: workflow.state,
      cooldownUntil: new Date(workflow.cooldownUntil).toISOString(),
      lastScheduledAt:
        workflow.lastScheduledAt === null ? null : new Date(workflow.lastScheduledAt).toISOString(),
      updatedAt: new Date(workflow.updatedAt).toISOString(),
    } satisfies NonNullable<AdminAdministratorDetail['messageWorkflows']['emailVerification']>;
    if (workflow.kind === 'email-verification') {
      messageWorkflows.emailVerification = projected;
    } else {
      messageWorkflows.passwordRecovery = projected;
    }
  }
  const methods: AdminAdministratorDetail['methods'] = [];
  const providers = new Set<string>();
  for (const account of accounts) {
    if (
      account.providerId === 'credential' &&
      account.password !== null &&
      !providers.has('password')
    ) {
      methods.push({ type: 'password' });
      providers.add('password');
    } else if (
      (account.providerId === 'google' ||
        account.providerId === 'facebook' ||
        account.providerId === 'apple') &&
      !providers.has(account.providerId)
    ) {
      methods.push({ type: 'social', provider: account.providerId });
      providers.add(account.providerId);
    }
  }
  return {
    kind: 'success',
    value: {
      id: row.id,
      email: row.email,
      emailVerified: row.emailVerified,
      realm: 'administrator',
      role: row.role ?? 'admin',
      access: { state: row.state === 'disabled' ? 'disabled' : 'active' },
      revision: row.revision ?? 1,
      summary: {
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      },
      methods,
      messageWorkflows,
    },
  };
}

export async function listAdminAdministrators(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly actorId: string;
  readonly headers: Headers;
  readonly query: AdminAdministratorListQuery;
}): Promise<AdminAdministratorListOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.auth,
    db: input.db,
    administratorId: input.actorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') return { kind: authorization.kind };

  const database = drizzle(input.db, { schema: identitySchema });
  const emailMatch =
    input.query.email === undefined
      ? undefined
      : sql`lower(${adminUser.email}) LIKE ${`%${escapeLikeLiteral(input.query.email.toLowerCase())}%`} ESCAPE '\\'`;
  const roleMatch = eq(adminUser.role, 'admin');
  const where = emailMatch === undefined ? roleMatch : and(roleMatch, emailMatch);
  const selection = {
    id: adminUser.id,
    email: adminUser.email,
    emailVerified: adminUser.emailVerified,
    role: adminUser.role,
    state: administratorAccessState.state,
    revision: administratorAccessState.revision,
  };
  const [rows, totals] = await Promise.all([
    database
      .select(selection)
      .from(adminUser)
      .leftJoin(administratorAccessState, eq(administratorAccessState.userId, adminUser.id))
      .where(where)
      .orderBy(asc(adminUser.email))
      .limit(input.query.limit)
      .offset(input.query.offset),
    database.select({ total: count() }).from(adminUser).where(where),
  ]);

  return {
    kind: 'success',
    value: {
      items: rows.map((row) => ({
        id: row.id,
        email: row.email,
        emailVerified: row.emailVerified,
        realm: 'administrator',
        role: row.role ?? 'admin',
        access: { state: row.state === 'disabled' ? 'disabled' : 'active' },
        revision: row.revision ?? 1,
      })),
      total: totals[0]?.total ?? 0,
    },
  };
}
