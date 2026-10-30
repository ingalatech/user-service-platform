import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import type {
  AdminReaderEmailVerification,
  AdminReaderMessage,
  AdminReaderMessageRequest,
} from './contract.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { createProblem, type ProblemCode } from '../../shared/problem.js';

const COOLDOWN_MS = 60_000;

type MessageKind = 'email-verification' | 'password-recovery';

interface ReaderTarget {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly revision: number | null;
  readonly access_state: string | null;
}

interface MessageWorkflow {
  readonly id: string;
  readonly state: string;
  readonly cooldown_until: number;
}

interface IdempotencyRow {
  readonly body_hash: string;
  readonly response_status: number;
  readonly response_body: string;
}

type CommonFailure =
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'reader-not-found' }
  | { readonly kind: 'internal-error' };

export type ForceReaderEmailVerificationOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderEmailVerification }
  | CommonFailure
  | { readonly kind: 'precondition-required' }
  | { readonly kind: 'stale-revision' };

export type RequestReaderMessageOutcome =
  | { readonly kind: 'accepted'; readonly value: AdminReaderMessage }
  | CommonFailure
  | { readonly kind: 'precondition-required' }
  | { readonly kind: 'invalid-transition' }
  | { readonly kind: 'no-usable-login-method' }
  | { readonly kind: 'idempotency-key-reused' }
  | { readonly kind: 'cooldown-active'; readonly retryAfterSeconds: number }
  | { readonly kind: 'delivery-scheduling-failed' };

function opaqueId(): string {
  return crypto.randomUUID();
}

async function digestBody(body: AdminReaderMessageRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function currentRevision(target: ReaderTarget): number {
  return target.revision ?? 1;
}

function parseIfMatch(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return null;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : null;
}

function responseValue(input: {
  readonly workflowId: string;
  readonly kind: MessageKind;
  readonly cooldownUntil: number;
  readonly revision: number;
}): AdminReaderMessage {
  return {
    workflowId: input.workflowId,
    kind: input.kind,
    state: 'scheduled',
    cooldownUntil: new Date(input.cooldownUntil).toISOString(),
    revision: input.revision,
  };
}

function problemBody(input: {
  readonly status: 503;
  readonly code: 'delivery-scheduling-failed';
  readonly path: string;
}): string {
  return JSON.stringify(
    createProblem({
      status: input.status,
      code: input.code,
      title: 'Delivery scheduling failed',
      detail: 'The message was committed and can be retried with the same idempotency key.',
      instance: input.path,
    }),
  );
}

async function readTarget(db: D1Database, userId: string): Promise<ReaderTarget | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.email_verified, ras.revision, ras.state AS access_state
       FROM user AS u
       LEFT JOIN reader_access_state AS ras ON ras.user_id = u.id
       WHERE u.id = ? AND (u.role IS NULL OR u.role <> 'admin')
       LIMIT 1`,
    )
    .bind(userId)
    .first<ReaderTarget>();
  return row ?? null;
}

async function hasUsableCredential(db: D1Database, userId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS usable
       FROM account
       WHERE user_id = ? AND provider_id = 'credential' AND password IS NOT NULL
       LIMIT 1`,
    )
    .bind(userId)
    .first<{ usable: number }>();
  return row !== null;
}

async function readWorkflow(
  db: D1Database,
  userId: string,
  kind: MessageKind,
): Promise<MessageWorkflow | null> {
  const row = await db
    .prepare(
      `SELECT id, state, cooldown_until
       FROM reader_message_workflow
       WHERE user_id = ? AND kind = ?
       LIMIT 1`,
    )
    .bind(userId, kind)
    .first<MessageWorkflow>();
  return row ?? null;
}

async function readIdempotency(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly method: string;
  readonly path: string;
  readonly targetId: string;
  readonly key: string;
  readonly now: number;
}): Promise<IdempotencyRow | null> {
  const row = await input.db
    .prepare(
      `SELECT body_hash, response_status, response_body
       FROM admin_idempotency_record
       WHERE actor_id = ? AND method = ? AND normalized_path = ? AND target_id = ? AND key = ?
         AND expires_at > ?
       LIMIT 1`,
    )
    .bind(input.actorId, input.method, input.path, input.targetId, input.key, input.now)
    .first<IdempotencyRow>();
  return row ?? null;
}

async function audit(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string | null;
  readonly requestId: string;
  readonly type: string;
  readonly result: 'success' | 'failure';
  readonly problemCode?: ProblemCode;
  readonly metadata?: Record<string, boolean | string | number>;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO identity_event
        (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
         result, request_id, problem_code, metadata)
        VALUES (?, 1, ?, ?, 'administrator', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      opaqueId(),
      input.type,
      Date.now(),
      input.actorId,
      input.subjectId === null ? null : 'reader',
      input.subjectId,
      input.result,
      input.requestId,
      input.problemCode ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}

async function auditedFailure<T extends CommonFailure | { readonly kind: string }>(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string | null;
  readonly requestId: string;
  readonly type: string;
  readonly kind: T['kind'];
  readonly code: ProblemCode;
}): Promise<T | { readonly kind: 'internal-error' }> {
  try {
    await audit({
      db: input.db,
      actorId: input.actorId,
      subjectId: input.subjectId,
      requestId: input.requestId,
      type: input.type,
      result: 'failure',
      problemCode: input.code,
    });
    return { kind: input.kind } as T;
  } catch {
    return { kind: 'internal-error' };
  }
}

async function scheduleMessage(input: {
  readonly runtime: IdentityRuntime;
  readonly kind: MessageKind;
  readonly email: string;
}): Promise<boolean> {
  try {
    const auth = input.runtime.readerMessaging();
    const response =
      input.kind === 'email-verification'
        ? await auth.api.sendVerificationEmail({
            body: { email: input.email },
            headers: new Headers(),
            asResponse: true,
          })
        : await auth.api.requestPasswordReset({
            body: { email: input.email },
            headers: new Headers(),
            asResponse: true,
          });
    return response instanceof Response && response.ok;
  } catch {
    return false;
  }
}

async function finishScheduling(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: MessageKind;
  readonly workflowId: string;
  readonly idempotencyKey: string;
  readonly path: string;
  readonly requestId: string;
  readonly response: AdminReaderMessage;
  readonly scheduled: boolean;
  readonly now: number;
}): Promise<void> {
  const status = input.scheduled ? 202 : 503;
  const responseBody = input.scheduled
    ? JSON.stringify(input.response)
    : problemBody({ status: 503, code: 'delivery-scheduling-failed', path: input.path });
  const statements = [
    input.db
      .prepare(
        `UPDATE reader_message_workflow
         SET state = ?, updated_at = ?, last_scheduled_at = CASE WHEN ? = 1 THEN ? ELSE last_scheduled_at END
         WHERE id = ?`,
      )
      .bind(
        input.scheduled ? 'scheduled' : 'scheduling-failed',
        input.now,
        input.scheduled ? 1 : 0,
        input.now,
        input.workflowId,
      ),
    input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET response_status = ?, response_body = ?
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ? AND key = ?`,
      )
      .bind(status, responseBody, input.actorId, input.path, input.targetId, input.idempotencyKey),
  ];
  if (!input.scheduled) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           VALUES (?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'failure', ?, ?, ?)`,
        )
        .bind(
          opaqueId(),
          `${input.kind}-attempt`,
          input.now,
          input.actorId,
          input.targetId,
          input.requestId,
          'delivery-scheduling-failed',
          JSON.stringify({ state: 'scheduling-failed' }),
        ),
    );
  }
  await input.db.batch(statements);
}

export async function forceReaderEmailVerification(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly requestId: string;
}): Promise<ForceReaderEmailVerificationOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.runtime.administration(),
    db: input.db,
    administratorId: input.administratorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') {
    return authorization.kind === 'administrator-disabled'
      ? await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: null,
          requestId: input.requestId,
          type: 'email-verification-attempt',
          kind: 'administrator-disabled',
          code: 'administrator-disabled',
        })
      : { kind: authorization.kind };
  }
  const target = await readTarget(input.db, input.readerId);
  if (target === null) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-verification-attempt',
      kind: 'reader-not-found',
      code: 'reader-not-found',
    });
  }
  const expected = parseIfMatch(input.ifMatch);
  if (expected === null) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-verification-attempt',
      kind: 'precondition-required',
      code: 'precondition-required',
    });
  }
  const revision = currentRevision(target);
  if (expected !== revision) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-verification-attempt',
      kind: 'stale-revision',
      code: 'stale-revision',
    });
  }
  const changed = target.email_verified !== 1;
  const nextRevision = changed ? revision + 1 : revision;
  try {
    if (changed) {
      const now = Date.now();
      await input.db.batch([
        input.db
          .prepare('UPDATE user SET email_verified = 1, updated_at = ? WHERE id = ?')
          .bind(now, target.id),
        input.db
          .prepare(
            `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
             VALUES (?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
          )
          .bind(target.id, target.access_state ?? 'active', nextRevision, now),
        input.db
          .prepare('DELETE FROM email_verification_token WHERE target_email = ?')
          .bind(target.email),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             VALUES (?, 1, 'email-verified', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?)`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ operation: 'force-email-verification' }),
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             VALUES (?, 1, 'email-verification-attempt', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?)`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ changed: true }),
          ),
      ]);
    } else {
      await audit({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: 'email-verification-attempt',
        result: 'success',
        metadata: { changed: false },
      });
    }
  } catch {
    return { kind: 'internal-error' };
  }
  return {
    kind: 'success',
    value: { email: target.email, emailVerified: true, changed, revision: nextRevision },
  };
}

export async function requestReaderMessage(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly kind: MessageKind;
  readonly headers: Headers;
  readonly idempotencyKey?: string;
  readonly body: AdminReaderMessageRequest;
  readonly path: string;
  readonly requestId: string;
}): Promise<RequestReaderMessageOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.runtime.administration(),
    db: input.db,
    administratorId: input.administratorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') {
    return authorization.kind === 'administrator-disabled'
      ? await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: null,
          requestId: input.requestId,
          type: `${input.kind}-attempt`,
          kind: 'administrator-disabled',
          code: 'administrator-disabled',
        })
      : { kind: authorization.kind };
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: `${input.kind}-attempt`,
      kind: 'precondition-required',
      code: 'precondition-required',
    });
  }
  const now = Date.now();
  const bodyHash = await digestBody(input.body);
  const existingIdempotency = await readIdempotency({
    db: input.db,
    actorId: input.administratorId,
    method: 'POST',
    path: input.path,
    targetId: input.readerId,
    key: input.idempotencyKey,
    now,
  });
  if (existingIdempotency !== null) {
    if (existingIdempotency.body_hash !== bodyHash) {
      return auditedFailure({
        db: input.db,
        actorId: input.administratorId,
        subjectId: null,
        requestId: input.requestId,
        type: `${input.kind}-attempt`,
        kind: 'idempotency-key-reused',
        code: 'idempotency-key-reused',
      });
    }
    if (existingIdempotency.response_status === 202) {
      return {
        kind: 'accepted',
        value: JSON.parse(existingIdempotency.response_body) as AdminReaderMessage,
      };
    }
  }
  const target = await readTarget(input.db, input.readerId);
  if (target === null) {
    if (existingIdempotency !== null && existingIdempotency.response_status === 503) {
      return auditedFailure({
        db: input.db,
        actorId: input.administratorId,
        subjectId: null,
        requestId: input.requestId,
        type: `${input.kind}-attempt`,
        kind: 'delivery-scheduling-failed',
        code: 'delivery-scheduling-failed',
      });
    }
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: `${input.kind}-attempt`,
      kind: 'reader-not-found',
      code: 'reader-not-found',
    });
  }
  if (input.kind === 'email-verification' && target.email_verified === 1) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: `${input.kind}-attempt`,
      kind: 'invalid-transition',
      code: 'invalid-transition',
    });
  }
  if (input.kind === 'password-recovery' && !(await hasUsableCredential(input.db, target.id))) {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: `${input.kind}-attempt`,
      kind: 'no-usable-login-method',
      code: 'no-usable-login-method',
    });
  }

  if (existingIdempotency !== null) {
    const workflow = await readWorkflow(input.db, target.id, input.kind);
    if (workflow === null) return { kind: 'internal-error' };
    const scheduled = await scheduleMessage({
      runtime: input.runtime,
      kind: input.kind,
      email: target.email,
    });
    const response = responseValue({
      workflowId: workflow.id,
      kind: input.kind,
      cooldownUntil: workflow.cooldown_until,
      revision: currentRevision(target),
    });
    try {
      await finishScheduling({
        db: input.db,
        actorId: input.administratorId,
        targetId: target.id,
        kind: input.kind,
        workflowId: workflow.id,
        idempotencyKey: input.idempotencyKey,
        path: input.path,
        requestId: input.requestId,
        response,
        scheduled,
        now,
      });
    } catch {
      return { kind: 'internal-error' };
    }
    return scheduled
      ? { kind: 'accepted', value: response }
      : { kind: 'delivery-scheduling-failed' };
  }

  const workflow = await readWorkflow(input.db, target.id, input.kind);
  if (workflow !== null && workflow.cooldown_until > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((workflow.cooldown_until - now) / 1000));
    try {
      await audit({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: `${input.kind}-attempt`,
        result: 'failure',
        problemCode: 'cooldown-active',
      });
      return { kind: 'cooldown-active', retryAfterSeconds };
    } catch {
      return { kind: 'internal-error' };
    }
  }

  const workflowId = workflow?.id ?? opaqueId();
  const cooldownUntil = now + COOLDOWN_MS;
  const response = responseValue({
    workflowId,
    kind: input.kind,
    cooldownUntil,
    revision: currentRevision(target),
  });
  const failureBody = problemBody({
    status: 503,
    code: 'delivery-scheduling-failed',
    path: input.path,
  });
  try {
    await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO reader_message_workflow
           (id, user_id, kind, state, cooldown_until, created_at, updated_at, last_scheduled_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL)
           ON CONFLICT(user_id, kind) DO UPDATE SET state = 'pending', cooldown_until = excluded.cooldown_until, updated_at = excluded.updated_at`,
        )
        .bind(workflowId, target.id, input.kind, cooldownUntil, now, now),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           VALUES (?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?)`,
        )
        .bind(
          opaqueId(),
          input.kind === 'email-verification'
            ? 'email-verification-requested'
            : 'password-recovery-requested',
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ workflowId }),
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           VALUES (?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?)`,
        )
        .bind(
          opaqueId(),
          `${input.kind}-attempt`,
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ state: 'committed' }),
        ),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, created_at, expires_at)
           VALUES (?, ?, ?, 'POST', ?, ?, ?, 503, ?, ?, ?)
           ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO NOTHING`,
        )
        .bind(
          opaqueId(),
          input.administratorId,
          input.idempotencyKey,
          input.path,
          target.id,
          bodyHash,
          failureBody,
          now,
          now + 86_400_000,
        ),
    ]);
  } catch {
    return { kind: 'internal-error' };
  }

  const scheduled = await scheduleMessage({
    runtime: input.runtime,
    kind: input.kind,
    email: target.email,
  });
  try {
    await finishScheduling({
      db: input.db,
      actorId: input.administratorId,
      targetId: target.id,
      kind: input.kind,
      workflowId,
      idempotencyKey: input.idempotencyKey,
      path: input.path,
      requestId: input.requestId,
      response,
      scheduled,
      now: Date.now(),
    });
  } catch {
    return { kind: 'internal-error' };
  }
  return scheduled ? { kind: 'accepted', value: response } : { kind: 'delivery-scheduling-failed' };
}
