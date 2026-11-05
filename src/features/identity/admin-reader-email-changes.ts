import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import { digestVerificationToken, normalizeVerificationTarget } from './verification-token.js';
import {
  READER_EMAIL_VERIFICATION_MESSAGE_PATH,
  READER_PASSWORD_RECOVERY_MESSAGE_PATH,
} from './admin-reader-email.js';
import {
  AdminReaderEmailChangeCancelSchema,
  AdminReaderEmailChangeMessageSchema,
  AdminReaderEmailChangeSchema,
  type AdminReaderEmailChange,
  type AdminReaderEmailChangeCancel,
  type AdminReaderEmailChangeCommand,
  type AdminReaderEmailChangeMessage,
  type AdminReaderEmailChangeRequest,
} from './contract.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { createProblem, type ProblemCode } from '../../shared/problem.js';

const COOLDOWN_MS = 60_000;
const CLAIM_LEASE_MS = 30_000;
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export const READER_EMAIL_CHANGES_PATH = '/v1/admin/users/:userId/email-changes';
export const READER_EMAIL_CHANGE_MESSAGES_PATH =
  '/v1/admin/users/:userId/email-changes/:emailChangeId/messages';
export const READER_EMAIL_CHANGE_CANCEL_PATH =
  '/v1/admin/users/:userId/email-changes/:emailChangeId';

type FailureKind =
  | 'forbidden'
  | 'administrator-disabled'
  | 'reader-not-found'
  | 'active-deletion-request'
  | 'email-change-not-found'
  | 'bad-request'
  | 'precondition-required'
  | 'stale-revision'
  | 'same-email'
  | 'email-conflict'
  | 'invalid-transition'
  | 'idempotency-key-reused'
  | 'cooldown-active'
  | 'delivery-scheduling-failed'
  | 'verification-invalid'
  | 'internal-error';

interface ReaderTarget {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly access_state: string | null;
  readonly deletion_state: string | null;
  readonly revision: number | null;
}

interface EmailChangeWorkflowRow {
  readonly id: string;
  readonly user_id: string;
  readonly old_email: string;
  readonly new_email: string;
  readonly normalized_new_email: string;
  readonly state: string;
  readonly revision: number;
  readonly supersedes_id: string | null;
  readonly creator_id: string;
  readonly creation_key: string;
  readonly expires_at: number;
  readonly cooldown_until: number;
  readonly created_at: number;
  readonly updated_at: number;
  readonly last_scheduled_at: number | null;
  readonly claim_token: string | null;
  readonly claimed_at: number | null;
}

const EMAIL_CHANGE_WORKFLOW_COLUMNS =
  'id, user_id, old_email, new_email, normalized_new_email, state, revision, ' +
  'supersedes_id, creator_id, creation_key, expires_at, cooldown_until, created_at, ' +
  'updated_at, last_scheduled_at, claim_token, claimed_at';

interface IdempotencyRow {
  readonly body_hash: string;
  readonly response_status: number;
  readonly response_body: string;
  readonly retry_payload: string | null;
  readonly expires_at: number;
}

type IfMatchResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'revision'; readonly revision: number };

export type StartReaderEmailChangeOutcome =
  | { readonly kind: 'success'; readonly status: 200 | 201; readonly value: AdminReaderEmailChange }
  | ReaderEmailChangeFailure;

export type CancelReaderEmailChangeOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderEmailChangeCancel }
  | ReaderEmailChangeFailure;

export type ResendReaderEmailChangeOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderEmailChangeMessage }
  | ReaderEmailChangeFailure;

export type ReaderEmailChangeFailure =
  | {
      [Kind in Exclude<FailureKind, 'cooldown-active' | 'verification-invalid'>]: {
        readonly kind: Kind;
      };
    }[Exclude<FailureKind, 'cooldown-active' | 'verification-invalid'>]
  | { readonly kind: 'cooldown-active'; readonly retryAfterSeconds: number };

export type CompleteReaderEmailChangeOutcome =
  | { readonly kind: 'not-email-change' }
  | { readonly kind: 'completed' }
  | { readonly kind: 'active-deletion-request' }
  | { readonly kind: 'verification-invalid' }
  | { readonly kind: 'internal-error' };

function opaqueId(): string {
  return crypto.randomUUID();
}

function parseIfMatch(value: string | undefined): IfMatchResult {
  if (value === undefined) return { kind: 'missing' };
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return { kind: 'malformed' };
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? { kind: 'revision', revision } : { kind: 'malformed' };
}

function currentRevision(target: ReaderTarget): number {
  return target.revision ?? 1;
}

async function digestBody(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readTarget(db: D1Database, userId: string): Promise<ReaderTarget | null> {
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.email_verified, ras.state AS access_state, ras.revision,
              deletion.state AS deletion_state
       FROM user AS u
       LEFT JOIN reader_access_state AS ras ON ras.user_id = u.id
       LEFT JOIN reader_deletion_request AS deletion
         ON deletion.user_id = u.id AND deletion.state IN ('pending_review', 'approved')
       WHERE u.id = ? AND (u.role IS NULL OR u.role <> 'admin') LIMIT 1`,
    )
    .bind(userId)
    .first<ReaderTarget>();
  return row ?? null;
}

async function readPendingWorkflow(
  db: D1Database,
  userId: string,
): Promise<EmailChangeWorkflowRow | null> {
  const row = await db
    .prepare(
      `SELECT ${EMAIL_CHANGE_WORKFLOW_COLUMNS}
       FROM reader_email_change_workflow
       WHERE user_id = ? AND state = 'pending'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(userId)
    .first<EmailChangeWorkflowRow>();
  return row ?? null;
}

async function readWorkflowByCreatorKey(input: {
  readonly db: D1Database;
  readonly userId: string;
  readonly creatorId: string;
  readonly key: string;
}): Promise<EmailChangeWorkflowRow | null> {
  const row = await input.db
    .prepare(
      `SELECT ${EMAIL_CHANGE_WORKFLOW_COLUMNS}
       FROM reader_email_change_workflow
       WHERE user_id = ? AND creator_id = ? AND creation_key = ?
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(input.userId, input.creatorId, input.key)
    .first<EmailChangeWorkflowRow>();
  return row ?? null;
}

async function readWorkflow(input: {
  readonly db: D1Database;
  readonly userId: string;
  readonly workflowId: string;
}): Promise<EmailChangeWorkflowRow | null> {
  const row = await input.db
    .prepare(
      `SELECT ${EMAIL_CHANGE_WORKFLOW_COLUMNS}
       FROM reader_email_change_workflow WHERE user_id = ? AND id = ? LIMIT 1`,
    )
    .bind(input.userId, input.workflowId)
    .first<EmailChangeWorkflowRow>();
  return row ?? null;
}

async function readWorkflowById(
  db: D1Database,
  workflowId: string,
): Promise<EmailChangeWorkflowRow | null> {
  const row = await db
    .prepare(
      `SELECT ${EMAIL_CHANGE_WORKFLOW_COLUMNS}
       FROM reader_email_change_workflow WHERE id = ? LIMIT 1`,
    )
    .bind(workflowId)
    .first<EmailChangeWorkflowRow>();
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
      `SELECT body_hash, response_status, response_body, retry_payload, expires_at
       FROM admin_idempotency_record
       WHERE actor_id = ? AND method = ? AND normalized_path = ? AND target_id = ?
         AND key = ? AND expires_at > ? LIMIT 1`,
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

async function auditedFailure<T extends { readonly kind: string }>(input: {
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

function emailChangeValue(input: {
  readonly workflowId: string;
  readonly email: string;
  readonly revision: number;
  readonly accountRevision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly cooldownUntil: number;
  readonly changed: boolean;
}): AdminReaderEmailChange {
  return {
    workflowId: input.workflowId,
    email: input.email,
    state: 'pending',
    changed: input.changed,
    revision: input.revision,
    accountRevision: input.accountRevision,
    createdAt: new Date(input.createdAt).toISOString(),
    expiresAt: new Date(input.expiresAt).toISOString(),
    cooldownUntil: new Date(input.cooldownUntil).toISOString(),
  };
}

function parseCreateReplay(responseBody: string): AdminReaderEmailChange | null {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    const result = AdminReaderEmailChangeSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseCancelReplay(responseBody: string): AdminReaderEmailChangeCancel | null {
  try {
    const parsed: unknown = JSON.parse(responseBody);
    const result = AdminReaderEmailChangeCancelSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function auditedEmailChangeCooldown(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly readerId: string;
  readonly requestId: string;
  readonly type: string;
  readonly retryAfterSeconds: number;
}): Promise<
  | { readonly kind: 'cooldown-active'; readonly retryAfterSeconds: number }
  | { readonly kind: 'internal-error' }
> {
  try {
    await audit({
      db: input.db,
      actorId: input.actorId,
      subjectId: input.readerId,
      requestId: input.requestId,
      type: input.type,
      result: 'failure',
      problemCode: 'cooldown-active',
      metadata: { retryAfterSeconds: input.retryAfterSeconds },
    });
    return { kind: 'cooldown-active', retryAfterSeconds: input.retryAfterSeconds };
  } catch {
    return { kind: 'internal-error' };
  }
}

async function hasCanonicalEmailConflict(input: {
  readonly db: D1Database;
  readonly readerId: string;
  readonly normalizedEmail: string;
}): Promise<boolean> {
  const canonical = await input.db
    .prepare(
      `SELECT 1 AS present FROM user
       WHERE id <> ? AND lower(trim(email)) = ? AND (role IS NULL OR role <> 'admin')
       LIMIT 1`,
    )
    .bind(input.readerId, input.normalizedEmail)
    .first<{ readonly present: number }>();
  if (canonical !== null) return true;
  const administratorCanonical = await input.db
    .prepare('SELECT 1 AS present FROM admin_user WHERE lower(trim(email)) = ? LIMIT 1')
    .bind(input.normalizedEmail)
    .first<{ readonly present: number }>();
  if (administratorCanonical !== null) return true;
  const reservation = await input.db
    .prepare(
      `SELECT 1 AS present FROM identity_reservation
       WHERE kind = 'email' AND normalized_value = ? AND expires_at > ?
         AND NOT (realm = 'reader' AND subject_id = ?) LIMIT 1`,
    )
    .bind(input.normalizedEmail, Date.now(), input.readerId)
    .first<{ readonly present: number }>();
  return reservation !== null;
}

function emailChangeFailure(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly readerId: string | null;
  readonly requestId: string;
  readonly kind: Exclude<FailureKind, 'cooldown-active' | 'verification-invalid'>;
}): Promise<StartReaderEmailChangeOutcome> {
  return auditedFailure<StartReaderEmailChangeOutcome>({
    db: input.db,
    actorId: input.actorId,
    subjectId: input.readerId,
    requestId: input.requestId,
    type: 'email-change-attempt',
    kind: input.kind,
    code: input.kind,
  });
}

function schedulingFailureBody(path: string): string {
  return JSON.stringify(
    createProblem({
      status: 503,
      code: 'delivery-scheduling-failed',
      title: 'Delivery scheduling failed',
      detail:
        'The email-change workflow is committed and can be retried with the same idempotency key.',
      instance: path,
    }),
  );
}

async function finishCreateScheduling(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly readerId: string;
  readonly key: string;
  readonly path: string;
  readonly bodyHash: string;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly responseStatus: 200 | 201;
  readonly response: AdminReaderEmailChange;
  readonly retryPayload: string;
  readonly requestId: string;
  readonly scheduled: boolean;
}): Promise<boolean> {
  const now = Date.now();
  const statements = [
    input.db
      .prepare(
        `UPDATE reader_email_change_workflow
         SET updated_at = ?,
             last_scheduled_at = CASE WHEN ? = 1 THEN ? ELSE last_scheduled_at END,
             claimed_at = CASE WHEN ? = 1 THEN NULL ELSE ? END
         WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?`,
      )
      .bind(
        now,
        input.scheduled ? 1 : 0,
        now,
        input.scheduled ? 1 : 0,
        now,
        input.workflowId,
        input.readerId,
        input.claimToken,
      ),
    input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET response_status = ?, response_body = ?, retry_payload = ?
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
           AND key = ? AND body_hash = ?
           AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
           )`,
      )
      .bind(
        input.scheduled ? input.responseStatus : 503,
        input.scheduled ? JSON.stringify(input.response) : schedulingFailureBody(input.path),
        input.scheduled ? null : input.retryPayload,
        input.actorId,
        input.path,
        input.readerId,
        input.key,
        input.bodyHash,
        input.workflowId,
        input.readerId,
        input.claimToken,
      ),
  ];
  if (!input.scheduled) {
    statements.push(
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-change-attempt', ?, 'administrator', ?, 'reader', ?,
             'failure', ?, 'delivery-scheduling-failed', ?
           WHERE EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.actorId,
          input.readerId,
          input.requestId,
          JSON.stringify({ workflowId: input.workflowId, state: 'scheduling-failed' }),
          input.workflowId,
          input.readerId,
          input.claimToken,
        ),
    );
  }
  const results = await input.db.batch(statements);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

export async function startReaderEmailChange(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
  readonly body: AdminReaderEmailChangeRequest;
  readonly normalizedPath: string;
  readonly instancePath: string;
  readonly requestId: string;
}): Promise<StartReaderEmailChangeOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: authorization.kind,
    });
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }

  const key = input.idempotencyKey;
  const normalizedNewEmail = normalizeVerificationTarget(input.body.email);
  const bodyHash = await digestBody({ email: normalizedNewEmail });
  const now = Date.now();
  const readCommand = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'POST',
      path: input.normalizedPath,
      targetId: input.readerId,
      key,
      now,
    });
  let existingIdempotency: IdempotencyRow | null;
  try {
    existingIdempotency = await readCommand();
  } catch {
    return { kind: 'internal-error' };
  }
  if (existingIdempotency !== null && existingIdempotency.body_hash !== bodyHash) {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: input.readerId,
      requestId: input.requestId,
      kind: 'idempotency-key-reused',
    });
  }
  if (
    existingIdempotency?.response_status === 200 ||
    existingIdempotency?.response_status === 201
  ) {
    const value = parseCreateReplay(existingIdempotency.response_body);
    return value === null
      ? { kind: 'internal-error' }
      : { kind: 'success', status: existingIdempotency.response_status, value };
  }

  const retrying =
    existingIdempotency?.response_status === 102 || existingIdempotency?.response_status === 503;
  let target: ReaderTarget | null;
  try {
    target = await readTarget(input.db, input.readerId);
  } catch {
    return { kind: 'internal-error' };
  }
  if (target === null) {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'reader-not-found',
    });
  }
  if (
    (target.access_state !== null && target.access_state !== 'active') ||
    target.deletion_state !== null
  ) {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: target.deletion_state !== null ? 'active-deletion-request' : 'invalid-transition',
    });
  }

  const revision = currentRevision(target);
  if (!retrying) {
    const precondition = parseIfMatch(input.ifMatch);
    if (precondition.kind === 'missing') {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'precondition-required',
      });
    }
    if (precondition.kind === 'malformed') {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'bad-request',
      });
    }
    if (precondition.revision !== revision) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'stale-revision',
      });
    }
    if (normalizedNewEmail === normalizeVerificationTarget(target.email)) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'same-email',
      });
    }
    if (
      await hasCanonicalEmailConflict({
        db: input.db,
        readerId: target.id,
        normalizedEmail: normalizedNewEmail,
      })
    ) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'email-conflict',
      });
    }
  }

  let workflow: EmailChangeWorkflowRow | null;
  try {
    workflow = retrying
      ? await readWorkflowByCreatorKey({
          db: input.db,
          userId: target.id,
          creatorId: input.administratorId,
          key,
        })
      : await readPendingWorkflow(input.db, target.id);
  } catch {
    return { kind: 'internal-error' };
  }
  if (retrying && workflow?.state !== 'pending') {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'invalid-transition',
    });
  }
  if (retrying && workflow !== null && workflow.expires_at <= now) {
    return emailChangeFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'invalid-transition',
    });
  }
  if (
    retrying &&
    existingIdempotency?.response_status === 102 &&
    workflow?.claim_token !== undefined &&
    workflow.claim_token !== null &&
    workflow.claimed_at !== null &&
    workflow.claimed_at > now - CLAIM_LEASE_MS
  ) {
    return { kind: 'delivery-scheduling-failed' };
  }

  const activePending = workflow !== null && workflow.expires_at > now ? workflow : null;
  const workflowId = retrying ? (workflow?.id ?? '') : opaqueId();
  const responseStatus: 200 | 201 = retrying
    ? workflow?.supersedes_id === null
      ? 201
      : 200
    : activePending === null
      ? 201
      : 200;
  const claimToken = opaqueId();
  const mutationToken = opaqueId();
  const cooldownUntil = retrying
    ? (workflow?.cooldown_until ?? now + COOLDOWN_MS)
    : now + COOLDOWN_MS;
  const prepared = retrying
    ? null
    : await input.runtime.prepareReaderEmailChangeMessages({
        currentEmail: target.email,
        newEmail: normalizedNewEmail,
        workflowId,
      });
  if (!retrying && prepared === null) return { kind: 'internal-error' };
  if (retrying && (existingIdempotency?.retry_payload === null || existingIdempotency === null)) {
    return { kind: 'internal-error' };
  }
  const retryPayload = retrying
    ? (existingIdempotency?.retry_payload ?? '')
    : (prepared?.retryPayload ?? '');
  if (retryPayload.length === 0) return { kind: 'internal-error' };
  const workflowExpiresAt = retrying ? (workflow?.expires_at ?? now) : (prepared?.expiresAt ?? now);
  const nextAccountRevision = retrying ? revision : revision + 1;
  const createdAt = retrying ? (workflow?.created_at ?? now) : now;
  const workflowRevision = retrying ? (workflow?.revision ?? 1) : 1;
  const newEmail = retrying ? (workflow?.new_email ?? normalizedNewEmail) : normalizedNewEmail;
  const initialResponse = emailChangeValue({
    workflowId,
    email: newEmail,
    revision: workflowRevision,
    accountRevision: nextAccountRevision,
    createdAt,
    expiresAt: workflowExpiresAt,
    cooldownUntil,
    changed: true,
  });
  const successBody = JSON.stringify(initialResponse);
  const tokenDigest = prepared?.tokenDigest ?? '';

  try {
    if (retrying && workflow !== null) {
      await input.db.batch([
        input.db
          .prepare(
            `UPDATE reader_email_change_workflow
             SET claim_token = ?, claimed_at = ?, updated_at = ?
             WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token IS ?
               AND (claimed_at IS NULL OR claimed_at <= ? OR ? = 1)`,
          )
          .bind(
            claimToken,
            now,
            now,
            workflow.id,
            target.id,
            workflow.claim_token,
            now - CLAIM_LEASE_MS,
            existingIdempotency?.response_status === 503 ? 1 : 0,
          ),
        input.db
          .prepare(
            `UPDATE admin_idempotency_record
             SET response_status = 102, response_body = ?
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
               AND key = ? AND body_hash = ? AND response_status IN (102, 503)
               AND EXISTS (
                 SELECT 1 FROM reader_email_change_workflow
                 WHERE id = ? AND user_id = ? AND claim_token = ? AND state = 'pending'
               )`,
          )
          .bind(
            successBody,
            input.administratorId,
            input.normalizedPath,
            target.id,
            key,
            bodyHash,
            workflow.id,
            target.id,
            claimToken,
          ),
      ]);
    } else {
      const oldWorkflowId = workflow?.id ?? '';
      const oldNormalized = workflow?.normalized_new_email ?? '';
      await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO reader_access_state (user_id, state, revision, mutation_token, updated_at)
             SELECT ?, 'active', ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM user WHERE id = ? AND email = ?
                 AND (role IS NULL OR role <> 'admin')
             )
             ON CONFLICT(user_id) DO NOTHING`,
          )
          .bind(target.id, revision, mutationToken, now, target.id, target.email),
        input.db
          .prepare(
            `UPDATE reader_access_state
             SET revision = ?, mutation_token = ?, updated_at = ?
             WHERE user_id = ? AND revision = ? AND state = 'active'
                AND EXISTS (
                  SELECT 1 FROM user AS current_user
                  WHERE current_user.id = ? AND current_user.email = ?
                    AND (current_user.role IS NULL OR current_user.role <> 'admin')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM reader_deletion_request AS deletion
                  WHERE deletion.user_id = ? AND deletion.state IN ('pending_review', 'approved')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM user AS other
                  WHERE other.id <> ? AND lower(trim(other.email)) = ?
                    AND (other.role IS NULL OR other.role <> 'admin')
                )
                AND NOT EXISTS (
                  SELECT 1 FROM admin_user AS other_admin
                  WHERE lower(trim(other_admin.email)) = ?
                )
                AND NOT EXISTS (
                  SELECT 1 FROM identity_reservation AS reservation
                  WHERE reservation.kind = 'email'
                    AND reservation.normalized_value = ?
                    AND NOT (reservation.realm = 'reader' AND reservation.subject_id = ?)
                    AND reservation.expires_at > ?
               )`,
          )
          .bind(
            nextAccountRevision,
            mutationToken,
            now,
            target.id,
            revision,
            target.id,
            target.email,
            target.id,
            target.id,
            normalizedNewEmail,
            normalizedNewEmail,
            normalizedNewEmail,
            target.id,
            now,
          ),
        input.db
          .prepare(
            `UPDATE reader_email_change_workflow
             SET state = CASE WHEN expires_at <= ? THEN 'expired' ELSE 'superseded' END,
                 revision = revision + 1, updated_at = ?
             WHERE id = ? AND user_id = ? AND state = 'pending'
               AND EXISTS (
                 SELECT 1 FROM reader_access_state
                 WHERE user_id = ? AND revision = ? AND mutation_token = ?
               )`,
          )
          .bind(now, now, oldWorkflowId, target.id, target.id, nextAccountRevision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM email_verification_token
             WHERE target_email = ? AND EXISTS (
               SELECT 1 FROM identity_reservation
               WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
             )`,
          )
          .bind(oldNormalized, target.id, oldWorkflowId),
        input.db
          .prepare(
            `DELETE FROM verification WHERE identifier = ? AND EXISTS (
               SELECT 1 FROM identity_reservation
               WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
             )`,
          )
          .bind(oldNormalized, target.id, oldWorkflowId),
        input.db
          .prepare(
            `DELETE FROM identity_reservation
             WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
               AND EXISTS (
                 SELECT 1 FROM reader_access_state
                 WHERE user_id = ? AND revision = ? AND mutation_token = ?
               )`,
          )
          .bind(target.id, oldWorkflowId, target.id, nextAccountRevision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM identity_reservation
             WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND expires_at <= ?`,
          )
          .bind(target.id, now),
        input.db
          .prepare(
            `INSERT INTO reader_email_change_workflow
             (id, user_id, old_email, new_email, normalized_new_email, state, revision,
              supersedes_id, creator_id, creation_key, expires_at, cooldown_until, created_at,
              updated_at, last_scheduled_at, claim_token, claimed_at)
             SELECT ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM reader_access_state
                WHERE user_id = ? AND revision = ? AND mutation_token = ? AND state = 'active'
              ) AND NOT EXISTS (
                SELECT 1 FROM reader_deletion_request AS deletion
                WHERE deletion.user_id = ? AND deletion.state IN ('pending_review', 'approved')
              ) AND NOT EXISTS (
                SELECT 1 FROM user AS other
                WHERE other.id <> ? AND lower(trim(other.email)) = ?
                  AND (other.role IS NULL OR other.role <> 'admin')
              ) AND NOT EXISTS (
                SELECT 1 FROM admin_user AS other_admin
                WHERE lower(trim(other_admin.email)) = ?
              ) AND NOT EXISTS (
                SELECT 1 FROM identity_reservation AS reservation
                WHERE reservation.kind = 'email'
                  AND reservation.normalized_value = ?
                  AND NOT (reservation.realm = 'reader' AND reservation.subject_id = ?)
                  AND reservation.expires_at > ?
             )`,
          )
          .bind(
            workflowId,
            target.id,
            target.email,
            normalizedNewEmail,
            normalizedNewEmail,
            activePending?.id ?? null,
            input.administratorId,
            key,
            workflowExpiresAt,
            cooldownUntil,
            now,
            now,
            claimToken,
            now,
            target.id,
            nextAccountRevision,
            mutationToken,
            target.id,
            target.id,
            normalizedNewEmail,
            normalizedNewEmail,
            normalizedNewEmail,
            target.id,
            now,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_reservation
             (id, kind, realm, normalized_value, subject_id, workflow_id, created_at, expires_at)
             SELECT ?, 'email', 'reader', ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
              ) ON CONFLICT(kind, normalized_value) DO UPDATE SET
               id = excluded.id, subject_id = excluded.subject_id,
               workflow_id = excluded.workflow_id, created_at = excluded.created_at,
               expires_at = excluded.expires_at
             WHERE identity_reservation.expires_at <= excluded.created_at
                 OR (identity_reservation.realm = 'reader'
                     AND identity_reservation.subject_id = excluded.subject_id)`,
          )
          .bind(
            opaqueId(),
            normalizedNewEmail,
            target.id,
            workflowId,
            now,
            workflowExpiresAt,
            workflowId,
            target.id,
            claimToken,
          ),
        input.db
          .prepare(
            `INSERT INTO email_verification_token
             (target_email, token_digest, expires_at, issued_at, consumed_at)
             SELECT ?, ?, ?, ?, NULL
             WHERE EXISTS (
               SELECT 1 FROM identity_reservation
               WHERE kind = 'email' AND realm = 'reader' AND normalized_value = ?
                 AND subject_id = ? AND workflow_id = ?
             )
             ON CONFLICT(target_email) DO UPDATE SET
               token_digest = excluded.token_digest, expires_at = excluded.expires_at,
               issued_at = excluded.issued_at, consumed_at = NULL`,
          )
          .bind(
            normalizedNewEmail,
            tokenDigest,
            workflowExpiresAt,
            now,
            normalizedNewEmail,
            target.id,
            workflowId,
          ),
        input.db
          .prepare(
            `INSERT INTO admin_idempotency_record
             (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
              response_body, retry_payload, created_at, expires_at)
             SELECT ?, ?, ?, 'POST', ?, ?, ?, 102, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
             ) AND EXISTS (
               SELECT 1 FROM identity_reservation
               WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
             )
             ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
               id = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
                 THEN excluded.id ELSE admin_idempotency_record.id END,
               body_hash = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
                 THEN excluded.body_hash ELSE admin_idempotency_record.body_hash END,
               created_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
                 THEN excluded.created_at ELSE admin_idempotency_record.created_at END,
               expires_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
                 THEN excluded.expires_at ELSE admin_idempotency_record.expires_at END,
               response_status = 102, response_body = excluded.response_body,
               retry_payload = excluded.retry_payload
             WHERE admin_idempotency_record.expires_at <= excluded.created_at
                OR (admin_idempotency_record.body_hash = excluded.body_hash
                    AND admin_idempotency_record.response_status IN (102, 503)
                    AND admin_idempotency_record.expires_at > excluded.created_at)`,
          )
          .bind(
            opaqueId(),
            input.administratorId,
            key,
            input.normalizedPath,
            target.id,
            bodyHash,
            successBody,
            retryPayload,
            now,
            now + IDEMPOTENCY_RETENTION_MS,
            workflowId,
            target.id,
            claimToken,
            target.id,
            workflowId,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-change-requested', ?, 'administrator', ?, 'reader', ?,
               'success', ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
             ) AND EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
                 AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 102
             ) AND ? = 0`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({
              workflowId,
              ...(activePending === null ? {} : { supersedesId: activePending.id }),
            }),
            workflowId,
            target.id,
            claimToken,
            input.administratorId,
            input.normalizedPath,
            target.id,
            key,
            bodyHash,
            0,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-change-attempt', ?, 'administrator', ?, 'reader', ?,
               'success', ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
             ) AND EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
                 AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 102
             ) AND ? = 0`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ changed: true, workflowId }),
            workflowId,
            target.id,
            claimToken,
            input.administratorId,
            input.normalizedPath,
            target.id,
            key,
            bodyHash,
            0,
          ),
      ]);
    }
  } catch {
    return { kind: 'internal-error' };
  }

  const claimed = await readWorkflow({ db: input.db, userId: target.id, workflowId });
  const idempotency = await readCommand();
  if (claimed?.claim_token !== claimToken || idempotency?.response_status !== 102) {
    if (idempotency !== null && idempotency.body_hash !== bodyHash) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'idempotency-key-reused',
      });
    }
    if (idempotency?.response_status === 201 || idempotency?.response_status === 200) {
      const value = parseCreateReplay(idempotency.response_body);
      return value === null
        ? { kind: 'internal-error' }
        : { kind: 'success', status: idempotency.response_status, value };
    }
    if (idempotency?.response_status === 102 || idempotency?.response_status === 503) {
      return { kind: 'delivery-scheduling-failed' };
    }
    const latestTarget = await readTarget(input.db, target.id);
    if (latestTarget !== null && latestTarget.deletion_state !== null) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'active-deletion-request',
      });
    }
    if (latestTarget !== null && currentRevision(latestTarget) !== revision) {
      return emailChangeFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'stale-revision',
      });
    }
    return { kind: 'email-conflict' };
  }

  const response = emailChangeValue({
    workflowId: claimed.id,
    email: claimed.new_email,
    revision: claimed.revision,
    accountRevision: nextAccountRevision,
    createdAt: claimed.created_at,
    expiresAt: claimed.expires_at,
    cooldownUntil: claimed.cooldown_until,
    changed: true,
  });
  if (!retrying) {
    const event = await input.db
      .prepare(
        `SELECT 1 AS present FROM identity_event
         WHERE request_id = ? AND type = 'email-change-requested' AND subject_id = ?
         LIMIT 1`,
      )
      .bind(input.requestId, target.id)
      .first<{ readonly present: number }>();
    if (event === null) return { kind: 'internal-error' };
  }
  const scheduled = await input.runtime.retryReaderEmailChangeScheduling(retryPayload);
  let finalized: boolean;
  try {
    finalized = await finishCreateScheduling({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      key,
      path: input.normalizedPath,
      bodyHash,
      workflowId,
      claimToken,
      responseStatus,
      response,
      retryPayload,
      requestId: input.requestId,
      scheduled: scheduled === 'accepted',
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (!finalized) return { kind: 'delivery-scheduling-failed' };
  return scheduled === 'accepted'
    ? { kind: 'success', status: responseStatus, value: response }
    : { kind: 'delivery-scheduling-failed' };
}

export async function resendReaderEmailChangeMessage(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly emailChangeId: string;
  readonly headers: Headers;
  readonly idempotencyKey?: string;
  readonly body: AdminReaderEmailChangeCommand;
  readonly normalizedPath: string;
  readonly instancePath: string;
  readonly requestId: string;
}): Promise<ResendReaderEmailChangeOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: authorization.kind,
      code: authorization.kind,
    });
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: 'precondition-required',
      code: 'precondition-required',
    });
  }
  const key = input.idempotencyKey;
  const bodyHash = await digestBody(input.body);
  const now = Date.now();
  const readCommand = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'POST',
      path: input.normalizedPath,
      targetId: input.emailChangeId,
      key,
      now,
    });
  let existing: IdempotencyRow | null;
  try {
    existing = await readCommand();
  } catch {
    return { kind: 'internal-error' };
  }
  if (existing !== null && existing.body_hash !== bodyHash) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: 'idempotency-key-reused',
      code: 'idempotency-key-reused',
    });
  }
  if (existing?.response_status === 202) {
    const parsed = AdminReaderEmailChangeMessageSchema.safeParse(
      JSON.parse(existing.response_body),
    );
    return parsed.success ? { kind: 'success', value: parsed.data } : { kind: 'internal-error' };
  }
  const target = await readTarget(input.db, input.readerId);
  if (target === null) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: 'reader-not-found',
      code: 'reader-not-found',
    });
  }
  if (
    (target.access_state !== null && target.access_state !== 'active') ||
    target.deletion_state !== null
  ) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: target.deletion_state !== null ? 'active-deletion-request' : 'invalid-transition',
      code: target.deletion_state !== null ? 'active-deletion-request' : 'invalid-transition',
    });
  }
  const retrying = existing?.response_status === 102 || existing?.response_status === 503;
  const workflow = await readWorkflow({
    db: input.db,
    userId: target.id,
    workflowId: input.emailChangeId,
  });
  if (workflow === null) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: 'email-change-not-found',
      code: 'email-change-not-found',
    });
  }
  if (workflow.state !== 'pending' || workflow.expires_at <= now) {
    return auditedFailure<ResendReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      kind: 'invalid-transition',
      code: 'invalid-transition',
    });
  }
  if (
    retrying &&
    existing?.response_status === 102 &&
    workflow.claim_token !== null &&
    workflow.claimed_at !== null &&
    workflow.claimed_at > now - CLAIM_LEASE_MS
  ) {
    return { kind: 'delivery-scheduling-failed' };
  }
  if (!retrying && workflow.cooldown_until > now) {
    return auditedEmailChangeCooldown({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      type: 'email-change-message-attempt',
      retryAfterSeconds: Math.max(1, Math.ceil((workflow.cooldown_until - now) / 1000)),
    });
  }

  let retryPayload: string;
  let tokenDigest = '';
  let expiresAt = workflow.expires_at;
  let cooldownUntil = workflow.cooldown_until;
  const nextRevision = retrying ? workflow.revision : workflow.revision + 1;
  if (retrying) {
    if (existing?.retry_payload === null || existing === null) return { kind: 'internal-error' };
    retryPayload = existing.retry_payload;
  } else {
    const prepared = await input.runtime.prepareReaderEmailChangeMessages({
      currentEmail: workflow.old_email,
      newEmail: workflow.new_email,
      workflowId: workflow.id,
    });
    if (prepared === null) return { kind: 'internal-error' };
    retryPayload = prepared.retryPayload;
    tokenDigest = prepared.tokenDigest;
    expiresAt = prepared.expiresAt;
    cooldownUntil = now + COOLDOWN_MS;
  }
  const claimToken = opaqueId();
  const response: AdminReaderEmailChangeMessage = {
    workflowId: workflow.id,
    state: 'pending',
    cooldownUntil: new Date(cooldownUntil).toISOString(),
    expiresAt: new Date(expiresAt).toISOString(),
    revision: nextRevision,
  };

  try {
    await input.db.batch([
      input.db
        .prepare(
          `UPDATE reader_email_change_workflow
           SET revision = ?, cooldown_until = ?, expires_at = ?, updated_at = ?,
               claim_token = ?, claimed_at = ?
           WHERE id = ? AND user_id = ? AND state = 'pending' AND revision = ?
             AND claim_token IS ? AND (
               (? = 1) OR (cooldown_until <= ? AND (claimed_at IS NULL OR claimed_at <= ?))
              ) AND EXISTS (
                SELECT 1 FROM reader_access_state
                WHERE user_id = ? AND state = 'active'
              ) AND NOT EXISTS (
                SELECT 1 FROM reader_deletion_request AS deletion
                WHERE deletion.user_id = ? AND deletion.state IN ('pending_review', 'approved')
              )`,
        )
        .bind(
          nextRevision,
          cooldownUntil,
          expiresAt,
          now,
          claimToken,
          now,
          workflow.id,
          target.id,
          workflow.revision,
          workflow.claim_token,
          retrying ? 1 : 0,
          now,
          now - CLAIM_LEASE_MS,
          target.id,
          target.id,
        ),
      input.db
        .prepare(
          `UPDATE identity_reservation SET expires_at = ?
           WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
             AND EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND claim_token = ? AND state = 'pending'
             ) AND ? = 0`,
        )
        .bind(expiresAt, target.id, workflow.id, workflow.id, claimToken, retrying ? 1 : 0),
      input.db
        .prepare(
          `INSERT INTO email_verification_token
           (target_email, token_digest, expires_at, issued_at, consumed_at)
           SELECT ?, ?, ?, ?, NULL WHERE ? = 0 AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND claim_token = ? AND state = 'pending'
           )
           ON CONFLICT(target_email) DO UPDATE SET token_digest = excluded.token_digest,
             expires_at = excluded.expires_at, issued_at = excluded.issued_at, consumed_at = NULL`,
        )
        .bind(
          workflow.normalized_new_email,
          tokenDigest,
          expiresAt,
          now,
          retrying ? 1 : 0,
          workflow.id,
          claimToken,
        ),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, retry_payload, created_at, expires_at)
           SELECT ?, ?, ?, 'POST', ?, ?, ?, 102, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND claim_token = ? AND state = 'pending'
           )
           ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
             id = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.id ELSE admin_idempotency_record.id END,
             body_hash = excluded.body_hash, response_status = 102,
             response_body = excluded.response_body, retry_payload = excluded.retry_payload,
             created_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.created_at ELSE admin_idempotency_record.created_at END,
             expires_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.expires_at ELSE admin_idempotency_record.expires_at END
           WHERE admin_idempotency_record.expires_at <= excluded.created_at
             OR (admin_idempotency_record.body_hash = excluded.body_hash
                 AND admin_idempotency_record.response_status IN (102, 503)
                 AND admin_idempotency_record.expires_at > excluded.created_at)`,
        )
        .bind(
          opaqueId(),
          input.administratorId,
          key,
          input.normalizedPath,
          workflow.id,
          bodyHash,
          JSON.stringify(response),
          retryPayload,
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          workflow.id,
          claimToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-change-message-requested', ?, 'administrator', ?, 'reader', ?,
             'success', ?, NULL, ?
           WHERE ? = 0 AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND claim_token = ? AND state = 'pending'
           ) AND EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 102
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ workflowId: workflow.id }),
          retrying ? 1 : 0,
          workflow.id,
          claimToken,
          input.administratorId,
          input.normalizedPath,
          workflow.id,
          key,
          bodyHash,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-change-message-attempt', ?, 'administrator', ?, 'reader', ?,
             'success', ?, NULL, ?
           WHERE ? = 0 AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND claim_token = ? AND state = 'pending'
           ) AND EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 102
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed: true, workflowId: workflow.id }),
          retrying ? 1 : 0,
          workflow.id,
          claimToken,
          input.administratorId,
          input.normalizedPath,
          workflow.id,
          key,
          bodyHash,
        ),
    ]);
  } catch {
    return { kind: 'internal-error' };
  }
  const currentWorkflow = await readWorkflow({
    db: input.db,
    userId: target.id,
    workflowId: workflow.id,
  });
  const currentCommand = await readCommand();
  if (currentWorkflow?.claim_token !== claimToken || currentCommand?.response_status !== 102) {
    if (currentCommand?.response_status === 202) {
      const parsed = AdminReaderEmailChangeMessageSchema.safeParse(
        JSON.parse(currentCommand.response_body),
      );
      return parsed.success ? { kind: 'success', value: parsed.data } : { kind: 'internal-error' };
    }
    if (currentCommand?.response_status === 102 || currentCommand?.response_status === 503) {
      return { kind: 'delivery-scheduling-failed' };
    }
    const latestTarget = await readTarget(input.db, target.id);
    if (latestTarget !== null && latestTarget.deletion_state !== null) {
      return await auditedFailure<ResendReaderEmailChangeOutcome>({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: 'email-change-message-attempt',
        kind: 'active-deletion-request',
        code: 'active-deletion-request',
      });
    }
    const latest = await readWorkflow({ db: input.db, userId: target.id, workflowId: workflow.id });
    if (latest !== null && latest.cooldown_until > now) {
      return auditedEmailChangeCooldown({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        type: 'email-change-message-attempt',
        retryAfterSeconds: Math.max(1, Math.ceil((latest.cooldown_until - now) / 1_000)),
      });
    }
    return { kind: 'internal-error' };
  }
  const scheduled = await input.runtime.retryReaderEmailChangeScheduling(retryPayload);
  const completedAt = Date.now();
  const finalizedStatus = scheduled === 'accepted' ? 202 : 503;
  const failureResponse = schedulingFailureBody(input.instancePath);
  try {
    const finish = [
      input.db
        .prepare(
          `UPDATE reader_email_change_workflow
           SET last_scheduled_at = CASE WHEN ? = 1 THEN ? ELSE last_scheduled_at END,
               claimed_at = CASE WHEN ? = 1 THEN NULL ELSE ? END,
               updated_at = ?
           WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?`,
        )
        .bind(
          scheduled === 'accepted' ? 1 : 0,
          completedAt,
          scheduled === 'accepted' ? 1 : 0,
          completedAt,
          completedAt,
          workflow.id,
          target.id,
          claimToken,
        ),
      input.db
        .prepare(
          `UPDATE admin_idempotency_record
           SET response_status = ?, response_body = ?, retry_payload = ?
           WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
             AND key = ? AND body_hash = ?
             AND EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
             )`,
        )
        .bind(
          finalizedStatus,
          scheduled === 'accepted' ? JSON.stringify(response) : failureResponse,
          scheduled === 'accepted' ? null : retryPayload,
          input.administratorId,
          input.normalizedPath,
          workflow.id,
          key,
          bodyHash,
          workflow.id,
          target.id,
          claimToken,
        ),
    ];
    if (scheduled !== 'accepted') {
      finish.push(
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-change-message-attempt', ?, 'administrator', ?, 'reader', ?,
               'failure', ?, 'delivery-scheduling-failed', ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND user_id = ? AND state = 'pending' AND claim_token = ?
             )`,
          )
          .bind(
            opaqueId(),
            completedAt,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ workflowId: workflow.id, state: 'scheduling-failed' }),
            workflow.id,
            target.id,
            claimToken,
          ),
      );
    }
    await input.db.batch(finish);
  } catch {
    return { kind: 'internal-error' };
  }
  return scheduled === 'accepted'
    ? { kind: 'success', value: response }
    : { kind: 'delivery-scheduling-failed' };
}

export async function cancelReaderEmailChange(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly emailChangeId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
  readonly normalizedPath: string;
  readonly requestId: string;
}): Promise<CancelReaderEmailChangeOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: authorization.kind,
      code: authorization.kind,
    });
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'precondition-required',
      code: 'precondition-required',
    });
  }
  const key = input.idempotencyKey;
  const bodyHash = await digestBody({});
  const now = Date.now();
  const readCommand = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'DELETE',
      path: input.normalizedPath,
      targetId: input.emailChangeId,
      key,
      now,
    });
  let existing: IdempotencyRow | null;
  try {
    existing = await readCommand();
  } catch {
    return { kind: 'internal-error' };
  }
  if (existing !== null && existing.body_hash !== bodyHash) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'idempotency-key-reused',
      code: 'idempotency-key-reused',
    });
  }
  if (existing?.response_status === 200) {
    const replay = parseCancelReplay(existing.response_body);
    return replay === null ? { kind: 'internal-error' } : { kind: 'success', value: replay };
  }
  const target = await readTarget(input.db, input.readerId);
  if (target === null) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'reader-not-found',
      code: 'reader-not-found',
    });
  }
  if (target.deletion_state !== null) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'active-deletion-request',
      code: 'active-deletion-request',
    });
  }
  const workflow = await readWorkflow({
    db: input.db,
    userId: target.id,
    workflowId: input.emailChangeId,
  });
  if (workflow === null) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'email-change-not-found',
      code: 'email-change-not-found',
    });
  }
  const precondition = parseIfMatch(input.ifMatch);
  if (precondition.kind === 'missing') {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'precondition-required',
      code: 'precondition-required',
    });
  }
  if (precondition.kind === 'malformed') {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'bad-request',
      code: 'bad-request',
    });
  }
  if (precondition.revision !== workflow.revision) {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'stale-revision',
      code: 'stale-revision',
    });
  }

  const changed = workflow.state === 'pending';
  if (!changed && workflow.state !== 'cancelled') {
    return auditedFailure<CancelReaderEmailChangeOutcome>({
      db: input.db,
      actorId: input.administratorId,
      subjectId: target.id,
      requestId: input.requestId,
      type: 'email-change-attempt',
      kind: 'invalid-transition',
      code: 'invalid-transition',
    });
  }
  const revision = changed ? workflow.revision + 1 : workflow.revision;
  const mutationToken = opaqueId();
  const result: AdminReaderEmailChangeCancel = {
    workflowId: workflow.id,
    state: 'cancelled',
    changed,
    revision,
  };

  try {
    const statements = [];
    if (changed) {
      statements.push(
        input.db
          .prepare(
            `UPDATE reader_email_change_workflow
             SET state = 'cancelled', revision = ?, claim_token = ?, claimed_at = NULL, updated_at = ?
             WHERE id = ? AND user_id = ? AND state = 'pending' AND revision = ?
               AND NOT EXISTS (
                 SELECT 1 FROM reader_deletion_request AS deletion
                 WHERE deletion.user_id = ? AND deletion.state IN ('pending_review', 'approved')
               )`,
          )
          .bind(revision, mutationToken, now, workflow.id, target.id, workflow.revision, target.id),
        input.db
          .prepare(
            `DELETE FROM email_verification_token
             WHERE target_email = ? AND EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND state = 'cancelled' AND revision = ? AND claim_token = ?
             )`,
          )
          .bind(workflow.normalized_new_email, workflow.id, revision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM verification WHERE identifier = ? AND EXISTS (
              SELECT 1 FROM reader_email_change_workflow
              WHERE id = ? AND state = 'cancelled' AND revision = ? AND claim_token = ?
            )`,
          )
          .bind(workflow.normalized_new_email, workflow.id, revision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM identity_reservation
             WHERE kind = 'email' AND realm = 'reader' AND subject_id = ? AND workflow_id = ?
               AND EXISTS (
                 SELECT 1 FROM reader_email_change_workflow
                 WHERE id = ? AND state = 'cancelled' AND revision = ? AND claim_token = ?
               )`,
          )
          .bind(target.id, workflow.id, workflow.id, revision, mutationToken),
      );
    }
    statements.push(
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
            (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
             response_body, created_at, expires_at)
            SELECT ?, ?, ?, 'DELETE', ?, ?, ?, 200, ?, ?, ?
            WHERE ? = 0 OR EXISTS (
              SELECT 1 FROM reader_email_change_workflow
              WHERE id = ? AND user_id = ? AND state = 'cancelled' AND revision = ?
                AND claim_token = ?
            )
            ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
             id = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.id ELSE admin_idempotency_record.id END,
             body_hash = excluded.body_hash, response_status = 200,
             response_body = excluded.response_body,
             created_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.created_at ELSE admin_idempotency_record.created_at END,
             expires_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.expires_at ELSE admin_idempotency_record.expires_at END
           WHERE admin_idempotency_record.expires_at <= excluded.created_at
             OR (admin_idempotency_record.body_hash = excluded.body_hash
                 AND admin_idempotency_record.response_status = 200
                 AND admin_idempotency_record.expires_at > excluded.created_at)`,
        )
        .bind(
          opaqueId(),
          input.administratorId,
          key,
          input.normalizedPath,
          workflow.id,
          bodyHash,
          JSON.stringify(result),
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          changed ? 1 : 0,
          workflow.id,
          target.id,
          revision,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-change-attempt', ?, 'administrator', ?, 'reader', ?,
             'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'DELETE' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 200
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed, workflowId: workflow.id }),
          input.administratorId,
          input.normalizedPath,
          workflow.id,
          key,
          bodyHash,
        ),
    );
    if (changed) {
      statements.push(
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-change-cancelled', ?, 'administrator', ?, 'reader', ?,
               'success', ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_email_change_workflow
               WHERE id = ? AND state = 'cancelled' AND revision = ? AND claim_token = ?
             ) AND EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'DELETE' AND normalized_path = ?
                 AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 200
             )`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ workflowId: workflow.id, revision }),
            workflow.id,
            revision,
            mutationToken,
            input.administratorId,
            input.normalizedPath,
            workflow.id,
            key,
            bodyHash,
          ),
      );
    }
    const results = await input.db.batch(statements);
    if (changed && results[0]?.meta.changes !== 1) {
      const latestTarget = await readTarget(input.db, target.id);
      if (latestTarget !== null && latestTarget.deletion_state !== null) {
        return await auditedFailure<CancelReaderEmailChangeOutcome>({
          db: input.db,
          actorId: input.administratorId,
          subjectId: target.id,
          requestId: input.requestId,
          type: 'email-change-attempt',
          kind: 'active-deletion-request',
          code: 'active-deletion-request',
        });
      }
      return await auditedFailure<CancelReaderEmailChangeOutcome>({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: 'email-change-attempt',
        kind: 'stale-revision',
        code: 'stale-revision',
      });
    }
  } catch {
    return { kind: 'internal-error' };
  }
  return { kind: 'success', value: result };
}

export async function completeReaderEmailChange(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly token: string;
  readonly requestId: string;
}): Promise<CompleteReaderEmailChangeOutcome> {
  const claims = await input.runtime.readReaderEmailChangeToken(input.token);
  if (claims === null) return { kind: 'not-email-change' };
  const tokenDigest = await digestVerificationToken(input.token);
  const workflow = await readWorkflowById(input.db, claims.workflowId);
  if (workflow?.state !== 'pending') {
    return { kind: 'verification-invalid' };
  }
  const now = Date.now();
  const oldEmail = normalizeVerificationTarget(claims.currentEmail);
  const newEmail = normalizeVerificationTarget(claims.newEmail);
  if (
    workflow.expires_at <= now ||
    claims.expiresAt <= now ||
    normalizeVerificationTarget(workflow.old_email) !== oldEmail ||
    workflow.normalized_new_email !== newEmail
  ) {
    return { kind: 'verification-invalid' };
  }
  const target = await readTarget(input.db, workflow.user_id);
  if (
    target === null ||
    (target.access_state !== null && target.access_state !== 'active') ||
    normalizeVerificationTarget(target.email) !== oldEmail
  ) {
    return { kind: 'verification-invalid' };
  }
  const activeDeletionFailure = async (
    deletionState: string,
  ): Promise<CompleteReaderEmailChangeOutcome> => {
    try {
      await audit({
        db: input.db,
        actorId: workflow.creator_id,
        subjectId: target.id,
        requestId: input.requestId,
        type: 'email-change-attempt',
        result: 'failure',
        problemCode: 'active-deletion-request',
        metadata: { workflowId: workflow.id, state: deletionState },
      });
      return { kind: 'active-deletion-request' };
    } catch {
      return { kind: 'internal-error' };
    }
  };
  if (target.deletion_state !== null) {
    return activeDeletionFailure(target.deletion_state);
  }
  if (
    await hasCanonicalEmailConflict({
      db: input.db,
      readerId: target.id,
      normalizedEmail: newEmail,
    })
  ) {
    return { kind: 'verification-invalid' };
  }
  const currentToken = await input.db
    .prepare(
      `SELECT token_digest, expires_at, consumed_at FROM email_verification_token
       WHERE target_email = ? LIMIT 1`,
    )
    .bind(newEmail)
    .first<{ token_digest: string; expires_at: number; consumed_at: number | null }>();
  if (
    currentToken?.token_digest !== tokenDigest ||
    currentToken.consumed_at !== null ||
    currentToken.expires_at <= now
  ) {
    return { kind: 'verification-invalid' };
  }
  const reservation = await input.db
    .prepare(
      `SELECT 1 AS present FROM identity_reservation
       WHERE kind = 'email' AND realm = 'reader' AND normalized_value = ?
         AND subject_id = ? AND workflow_id = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(newEmail, target.id, workflow.id, now)
    .first<{ present: number }>();
  if (reservation === null) return { kind: 'verification-invalid' };

  const mutationToken = opaqueId();
  const revision = currentRevision(target);
  const nextRevision = revision + 1;
  const nowSeconds = Math.floor(now / 1_000);
  try {
    await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO reader_access_state
           (user_id, state, revision, mutation_token, updated_at)
           VALUES (?, 'active', ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(target.id, revision, mutationToken, now),
      input.db
        .prepare(
          `UPDATE reader_access_state
           SET revision = ?, mutation_token = ?, updated_at = ?
           WHERE user_id = ? AND revision = ? AND state = 'active'
             AND EXISTS (
               SELECT 1 FROM user AS current_user
              WHERE current_user.id = ? AND lower(trim(current_user.email)) = ?
                  AND (current_user.role IS NULL OR current_user.role <> 'admin')
              ) AND NOT EXISTS (
                SELECT 1 FROM reader_deletion_request AS deletion
                WHERE deletion.user_id = ? AND deletion.state IN ('pending_review', 'approved')
              ) AND EXISTS (
               SELECT 1 FROM reader_email_change_workflow AS workflow
               WHERE workflow.id = ? AND workflow.user_id = ? AND workflow.state = 'pending'
                 AND workflow.revision = ? AND workflow.expires_at > ?
                 AND workflow.normalized_new_email = ?
             ) AND EXISTS (
               SELECT 1 FROM email_verification_token AS email_token
               WHERE email_token.target_email = ? AND email_token.token_digest = ?
                 AND email_token.consumed_at IS NULL AND email_token.expires_at > ?
             ) AND EXISTS (
               SELECT 1 FROM identity_reservation AS reservation
                WHERE reservation.kind = 'email'
                 AND reservation.normalized_value = ? AND reservation.subject_id = ?
                 AND reservation.workflow_id = ? AND reservation.expires_at > ?
              ) AND NOT EXISTS (
                SELECT 1 FROM user AS other
                WHERE other.id <> ? AND lower(trim(other.email)) = ?
                  AND (other.role IS NULL OR other.role <> 'admin')
              ) AND NOT EXISTS (
                SELECT 1 FROM admin_user AS other_admin
                WHERE lower(trim(other_admin.email)) = ?
              )`,
        )
        .bind(
          nextRevision,
          mutationToken,
          now,
          target.id,
          revision,
          target.id,
          oldEmail,
          target.id,
          workflow.id,
          target.id,
          workflow.revision,
          now,
          newEmail,
          newEmail,
          tokenDigest,
          now,
          newEmail,
          target.id,
          workflow.id,
          now,
          target.id,
          newEmail,
          newEmail,
        ),
      input.db
        .prepare(
          `UPDATE user SET email = ?, email_verified = 1, updated_at = ?
           WHERE id = ? AND lower(trim(email)) = ?
             AND EXISTS (
               SELECT 1 FROM reader_access_state
               WHERE user_id = ? AND revision = ? AND mutation_token = ?
             )`,
        )
        .bind(newEmail, nowSeconds, target.id, oldEmail, target.id, nextRevision, mutationToken),
      input.db
        .prepare(
          `DELETE FROM session WHERE user_id = ?
           AND EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND revision = ? AND mutation_token = ?
           ) AND EXISTS (
             SELECT 1 FROM user WHERE id = ? AND email = ? AND email_verified = 1
           )`,
        )
        .bind(target.id, target.id, nextRevision, mutationToken, target.id, newEmail),
      input.db
        .prepare(
          `UPDATE reader_email_change_workflow
           SET state = 'completed', revision = revision + 1, claim_token = ?,
               claimed_at = NULL, updated_at = ?
           WHERE id = ? AND user_id = ? AND state = 'pending' AND revision = ?
             AND EXISTS (
               SELECT 1 FROM reader_access_state
               WHERE user_id = ? AND revision = ? AND mutation_token = ?
             ) AND EXISTS (
               SELECT 1 FROM user WHERE id = ? AND email = ? AND email_verified = 1
             )`,
        )
        .bind(
          mutationToken,
          now,
          workflow.id,
          target.id,
          workflow.revision,
          target.id,
          nextRevision,
          mutationToken,
          target.id,
          newEmail,
        ),
      input.db
        .prepare(
          `DELETE FROM email_verification_token
           WHERE target_email IN (?, ?) AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(oldEmail, newEmail, workflow.id, mutationToken),
      input.db
        .prepare(
          `DELETE FROM verification WHERE identifier IN (?, ?) AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(workflow.old_email, workflow.new_email, workflow.id, mutationToken),
      input.db
        .prepare(
          `DELETE FROM reader_message_workflow WHERE user_id = ? AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(target.id, workflow.id, mutationToken),
      input.db
        .prepare(
          `UPDATE admin_idempotency_record SET expires_at = ?, retry_payload = NULL
           WHERE response_status IN (102, 503) AND (
             (target_id = ? AND normalized_path IN (?, ?, ?))
             OR (normalized_path = ? AND target_id IN (
               SELECT id FROM reader_email_change_workflow WHERE user_id = ?
             ))
           ) AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(
          now,
          target.id,
          READER_EMAIL_VERIFICATION_MESSAGE_PATH,
          READER_PASSWORD_RECOVERY_MESSAGE_PATH,
          READER_EMAIL_CHANGES_PATH,
          READER_EMAIL_CHANGE_MESSAGES_PATH,
          target.id,
          workflow.id,
          mutationToken,
        ),
      input.db
        .prepare(
          `DELETE FROM identity_reservation WHERE kind = 'email' AND realm = 'reader'
           AND subject_id = ? AND workflow_id = ? AND EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(target.id, workflow.id, workflow.id, mutationToken),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-changed', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          now,
          workflow.creator_id,
          target.id,
          input.requestId,
          JSON.stringify({ workflowId: workflow.id, revision: nextRevision }),
          workflow.id,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'email-change-attempt', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_email_change_workflow
             WHERE id = ? AND state = 'completed' AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          now,
          workflow.creator_id,
          target.id,
          input.requestId,
          JSON.stringify({ changed: true, workflowId: workflow.id }),
          workflow.id,
          mutationToken,
        ),
    ]);
  } catch {
    return { kind: 'internal-error' };
  }

  const completed = await input.db
    .prepare(
      `SELECT 1 AS completed FROM reader_email_change_workflow
       WHERE id = ? AND state = 'completed' AND claim_token = ?`,
    )
    .bind(workflow.id, mutationToken)
    .first<{ completed: number }>();
  const promotedUser = await input.db
    .prepare(`SELECT 1 AS promoted FROM user WHERE id = ? AND email = ? AND email_verified = 1`)
    .bind(target.id, newEmail)
    .first<{ promoted: number }>();
  if (completed === null || promotedUser === null) {
    const activeDeletion = await input.db
      .prepare(
        `SELECT state FROM reader_deletion_request
         WHERE user_id = ? AND state IN ('pending_review', 'approved') LIMIT 1`,
      )
      .bind(target.id)
      .first<{ state: string }>();
    if (activeDeletion !== null) return activeDeletionFailure(activeDeletion.state);
  }
  return completed !== null && promotedUser !== null
    ? { kind: 'completed' }
    : { kind: 'verification-invalid' };
}
