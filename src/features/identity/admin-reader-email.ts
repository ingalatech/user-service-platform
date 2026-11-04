import type { D1Database } from '@cloudflare/workers-types';
import { normalizeVerificationTarget } from './verification-token.js';
import { authorizeAdministrator } from './admin-authorization.js';
import {
  AdminReaderMessageSchema,
  type AdminReaderEmailVerification,
  type AdminReaderMessage,
  type AdminReaderMessageRequest,
} from './contract.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { createProblem, type ProblemCode } from '../../shared/problem.js';

const COOLDOWN_MS = 60_000;
const CLAIM_LEASE_MS = 30_000;
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

// Stable route templates are the idempotency fingerprint's path component.
// The selected target is stored separately, so the fingerprint never depends
// on a raw, percent-encoded request pathname.
export const READER_EMAIL_VERIFICATION_MESSAGE_PATH =
  '/v1/admin/users/:userId/email-verification/messages';
export const READER_PASSWORD_RECOVERY_MESSAGE_PATH =
  '/v1/admin/users/:userId/password-recovery/messages';

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
  readonly claim_token: string | null;
  readonly claimed_at: number | null;
  readonly updated_at: number;
}

interface IdempotencyRow {
  readonly body_hash: string;
  readonly response_status: number;
  readonly response_body: string;
  readonly retry_payload: string | null;
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

function parseCommittedResponse(body: string): AdminReaderMessage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = AdminReaderMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
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
      `SELECT id, state, cooldown_until, claim_token, claimed_at, updated_at
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
      `SELECT body_hash, response_status, response_body, retry_payload
       FROM admin_idempotency_record
       WHERE actor_id = ? AND method = ? AND normalized_path = ? AND target_id = ? AND key = ?
         AND expires_at > ?
       LIMIT 1`,
    )
    .bind(input.actorId, input.method, input.path, input.targetId, input.key, input.now)
    .first<IdempotencyRow>();
  return row ?? null;
}

async function readActiveMessageAttempt(input: {
  readonly db: D1Database;
  readonly path: string;
  readonly targetId: string;
  readonly now: number;
}): Promise<{ readonly expires_at: number } | null> {
  const row = await input.db
    .prepare(
      `SELECT expires_at
       FROM admin_idempotency_record
       WHERE method = 'POST' AND normalized_path = ? AND target_id = ?
         AND response_status IN (102, 503) AND expires_at > ?
       ORDER BY expires_at DESC
       LIMIT 1`,
    )
    .bind(input.path, input.targetId, input.now)
    .first<{ expires_at: number }>();
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

async function prepareMessage(input: {
  readonly runtime: IdentityRuntime;
  readonly kind: MessageKind;
  readonly email: string;
  readonly retryPayload: string | null;
}): Promise<
  { readonly kind: 'prepared'; readonly retryPayload: string } | { readonly kind: 'internal-error' }
> {
  if (input.retryPayload !== null) {
    return { kind: 'prepared', retryPayload: input.retryPayload };
  }
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
    if (!(response instanceof Response) || !response.ok) return { kind: 'internal-error' };
    const retryPayload = await input.runtime.sealPreparedReaderMessage();
    return retryPayload === null ? { kind: 'internal-error' } : { kind: 'prepared', retryPayload };
  } catch {
    return { kind: 'internal-error' };
  }
}

async function finishScheduling(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: MessageKind;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly idempotencyKey: string;
  readonly bodyHash: string;
  readonly normalizedPath: string;
  readonly instancePath: string;
  readonly requestId: string;
  readonly response: AdminReaderMessage;
  readonly scheduled: boolean;
  readonly retryPayload: string | null;
  readonly now: number;
}): Promise<boolean> {
  const status = input.scheduled ? 202 : 503;
  const responseBody = input.scheduled
    ? JSON.stringify(input.response)
    : problemBody({ status: 503, code: 'delivery-scheduling-failed', path: input.instancePath });
  const statements = [
    input.db
      .prepare(
        `UPDATE reader_message_workflow
         SET state = ?, updated_at = ?,
           last_scheduled_at = CASE WHEN ? = 1 THEN ? ELSE last_scheduled_at END
         WHERE id = ? AND claim_token = ?`,
      )
      .bind(
        input.scheduled ? 'scheduled' : 'scheduling-failed',
        input.now,
        input.scheduled ? 1 : 0,
        input.now,
        input.workflowId,
        input.claimToken,
      ),
    input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET response_status = ?, response_body = ?, retry_payload = ?
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ? AND key = ?
           AND body_hash = ?
           AND EXISTS (
             SELECT 1 FROM reader_message_workflow WHERE id = ? AND claim_token = ?
           )`,
      )
      .bind(
        status,
        responseBody,
        input.scheduled ? null : input.retryPayload,
        input.actorId,
        input.normalizedPath,
        input.targetId,
        input.idempotencyKey,
        input.bodyHash,
        input.workflowId,
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
           SELECT ?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'failure', ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_message_workflow WHERE id = ? AND claim_token = ?
           )`,
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
          input.workflowId,
          input.claimToken,
        ),
    );
  }
  const results = await input.db.batch(statements);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

async function persistPreparedMessage(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly normalizedPath: string;
  readonly idempotencyKey: string;
  readonly bodyHash: string;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly retryPayload: string;
}): Promise<boolean> {
  const result = await input.db
    .prepare(
      `UPDATE admin_idempotency_record
       SET retry_payload = ?
       WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ? AND key = ?
         AND body_hash = ? AND response_status = 102
         AND EXISTS (
           SELECT 1 FROM reader_message_workflow WHERE id = ? AND claim_token = ?
         )`,
    )
    .bind(
      input.retryPayload,
      input.actorId,
      input.normalizedPath,
      input.targetId,
      input.idempotencyKey,
      input.bodyHash,
      input.workflowId,
      input.claimToken,
    )
    .run();
  return result.meta.changes === 1;
}

async function invalidatePreparedMessage(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly normalizedPath: string;
  readonly idempotencyKey: string;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly now: number;
}): Promise<void> {
  await input.db.batch([
    input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET expires_at = ?, retry_payload = NULL
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ? AND key = ?`,
      )
      .bind(input.now, input.actorId, input.normalizedPath, input.targetId, input.idempotencyKey),
    input.db
      .prepare(
        `UPDATE reader_message_workflow
         SET state = 'scheduling-failed', cooldown_until = ?, updated_at = ?
         WHERE id = ? AND claim_token = ?`,
      )
      .bind(input.now, input.now, input.workflowId, input.claimToken),
  ]);
}

async function waitForTerminalIdempotency(
  readCommitted: () => Promise<IdempotencyRow | null>,
): Promise<IdempotencyRow | null> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const committed = await readCommitted();
    if (committed?.response_status !== 102) return committed;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return readCommitted();
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
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: 'email-verification-attempt',
      kind: authorization.kind,
      code: authorization.kind,
    });
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
  if (changed) {
    const now = Date.now();
    const userUpdatedAt = Math.floor(now / 1_000);
    const mutationToken = opaqueId();
    const fenced = (): string =>
      `EXISTS (
         SELECT 1 FROM reader_access_state
         WHERE user_id = ? AND revision = ? AND mutation_token = ?
       )`;
    try {
      const results = await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO reader_access_state (user_id, state, revision, mutation_token, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO NOTHING`,
          )
          .bind(target.id, target.access_state ?? 'active', revision, mutationToken, now),
        input.db
          .prepare(
            `UPDATE reader_access_state
             SET revision = ?, mutation_token = ?, updated_at = ?
             WHERE user_id = ? AND revision = ?
               AND NOT EXISTS (
                 SELECT 1 FROM reader_message_workflow
                 WHERE user_id = ? AND kind = 'email-verification' AND state = 'pending'
                   AND COALESCE(claimed_at, updated_at) > ?
               )`,
          )
          .bind(
            nextRevision,
            mutationToken,
            now,
            target.id,
            revision,
            target.id,
            now - CLAIM_LEASE_MS,
          ),
        input.db
          .prepare(
            `UPDATE user SET email_verified = 1, updated_at = ?
             WHERE id = ? AND ${fenced()}`,
          )
          .bind(userUpdatedAt, target.id, target.id, nextRevision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM email_verification_token
             WHERE target_email = ? AND ${fenced()}`,
          )
          .bind(normalizeVerificationTarget(target.email), target.id, nextRevision, mutationToken),
        input.db
          .prepare(
            `DELETE FROM verification
             WHERE identifier = ? AND ${fenced()}`,
          )
          .bind(target.email, target.id, nextRevision, mutationToken),
        input.db
          .prepare(
            `UPDATE admin_idempotency_record
             SET expires_at = ?, retry_payload = NULL
             WHERE target_id = ? AND normalized_path = ? AND response_status IN (102, 503)
               AND ${fenced()}`,
          )
          .bind(
            now,
            target.id,
            READER_EMAIL_VERIFICATION_MESSAGE_PATH,
            target.id,
            nextRevision,
            mutationToken,
          ),
        input.db
          .prepare(
            `DELETE FROM reader_message_workflow
             WHERE user_id = ? AND kind = 'email-verification' AND ${fenced()}`,
          )
          .bind(target.id, target.id, nextRevision, mutationToken),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-verified', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
             WHERE ${fenced()} AND NOT EXISTS (
               SELECT 1 FROM identity_event
               WHERE subject_id = ? AND type = 'email-verified'
                 AND json_extract(metadata, '$.revision') = ?
             )`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ operation: 'force-email-verification', revision: nextRevision }),
            target.id,
            nextRevision,
            mutationToken,
            target.id,
            nextRevision,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-verification-attempt', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
             WHERE ${fenced()}`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestId,
            JSON.stringify({ changed: true }),
            target.id,
            nextRevision,
            mutationToken,
          ),
      ]);
      if (results[1]?.meta.changes !== 1) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: target.id,
          requestId: input.requestId,
          type: 'email-verification-attempt',
          kind: 'stale-revision',
          code: 'stale-revision',
        });
      }
    } catch {
      return { kind: 'internal-error' };
    }
  } else {
    try {
      await audit({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: 'email-verification-attempt',
        result: 'success',
        metadata: { changed: false },
      });
    } catch {
      return { kind: 'internal-error' };
    }
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
  readonly normalizedPath: string;
  readonly instancePath: string;
  readonly requestId: string;
}): Promise<RequestReaderMessageOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.runtime.administration(),
    db: input.db,
    administratorId: input.administratorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') {
    return auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      subjectId: null,
      requestId: input.requestId,
      type: `${input.kind}-attempt`,
      kind: authorization.kind,
      code: authorization.kind,
    });
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
  const idempotencyKey = input.idempotencyKey;
  const now = Date.now();
  const bodyHash = await digestBody(input.body);
  const readCommitted = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'POST',
      path: input.normalizedPath,
      targetId: input.readerId,
      key: idempotencyKey,
      now,
    });
  const existingIdempotency = await readCommitted();
  if (existingIdempotency !== null && existingIdempotency.body_hash !== bodyHash) {
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
  if (existingIdempotency?.response_status === 202) {
    const value = parseCommittedResponse(existingIdempotency.response_body);
    if (value === null) return { kind: 'internal-error' };
    return {
      kind: 'accepted',
      value,
    };
  }
  const target = await readTarget(input.db, input.readerId);
  if (target === null) {
    if (existingIdempotency?.response_status === 503) {
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

  const retrying =
    existingIdempotency?.response_status === 503 || existingIdempotency?.response_status === 102;
  const workflow = await readWorkflow(input.db, target.id, input.kind);
  if (!retrying) {
    if (existingIdempotency === null) {
      const raced = await readCommitted();
      if (raced !== null && raced.body_hash !== bodyHash) {
        return auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: target.id,
          requestId: input.requestId,
          type: `${input.kind}-attempt`,
          kind: 'idempotency-key-reused',
          code: 'idempotency-key-reused',
        });
      }
      if (raced?.response_status === 202) {
        const value = parseCommittedResponse(raced.response_body);
        return value === null ? { kind: 'internal-error' } : { kind: 'accepted', value };
      }
      if (raced?.response_status === 503) return { kind: 'delivery-scheduling-failed' };
      if (raced?.response_status === 102) {
        const terminal = await waitForTerminalIdempotency(readCommitted);
        if (terminal?.response_status === 202) {
          const value = parseCommittedResponse(terminal.response_body);
          return value === null ? { kind: 'internal-error' } : { kind: 'accepted', value };
        }
        if (terminal?.response_status === 503) return { kind: 'delivery-scheduling-failed' };
        return { kind: 'internal-error' };
      }
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
    const activeAttempt = await readActiveMessageAttempt({
      db: input.db,
      path: input.normalizedPath,
      targetId: target.id,
      now,
    });
    if (activeAttempt !== null) {
      const retryAfterSeconds = Math.max(1, Math.ceil((activeAttempt.expires_at - now) / 1000));
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
  } else if (workflow === null) {
    return { kind: 'internal-error' };
  }

  const workflowId = workflow?.id ?? opaqueId();
  const cooldownUntil =
    retrying && workflow !== null && workflow.cooldown_until > now
      ? workflow.cooldown_until
      : now + COOLDOWN_MS;
  const response = responseValue({
    workflowId,
    kind: input.kind,
    cooldownUntil,
    revision: currentRevision(target),
  });
  const failureBody = problemBody({
    status: 503,
    code: 'delivery-scheduling-failed',
    path: input.instancePath,
  });
  const claimToken = opaqueId();
  const attemptType = `${input.kind}-attempt`;
  const requestedType =
    input.kind === 'email-verification'
      ? 'email-verification-requested'
      : 'password-recovery-requested';
  const claimStatements = [
    input.db
      .prepare(
        `INSERT INTO reader_message_workflow
          (id, user_id, kind, state, cooldown_until, created_at, updated_at, last_scheduled_at,
            claim_token, claimed_at)
          SELECT ?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?
          WHERE EXISTS (
            SELECT 1
            FROM user AS u
            LEFT JOIN reader_access_state AS ras ON ras.user_id = u.id
            WHERE u.id = ? AND u.email = ? AND COALESCE(ras.revision, 1) = ?
              AND (u.role IS NULL OR u.role <> 'admin')
              AND (? = 'password-recovery' OR u.email_verified = 0)
              AND (
                ? = 'email-verification'
                OR EXISTS (
                  SELECT 1 FROM account
                  WHERE user_id = ? AND provider_id = 'credential' AND password IS NOT NULL
                )
              )
          )
          ON CONFLICT(user_id, kind) DO UPDATE SET
            state = 'pending',
            cooldown_until = excluded.cooldown_until,
            updated_at = excluded.updated_at,
            claim_token = excluded.claim_token,
            claimed_at = excluded.claimed_at
         WHERE reader_message_workflow.cooldown_until <= excluded.created_at
           OR reader_message_workflow.state = 'scheduling-failed'
           OR (
             reader_message_workflow.state = 'pending'
             AND COALESCE(reader_message_workflow.claimed_at, reader_message_workflow.updated_at) <= ?
           )`,
      )
      .bind(
        workflowId,
        target.id,
        input.kind,
        cooldownUntil,
        now,
        now,
        claimToken,
        now,
        target.id,
        target.email,
        currentRevision(target),
        input.kind,
        input.kind,
        target.id,
        now - CLAIM_LEASE_MS,
      ),
  ];
  if (!retrying) {
    claimStatements.push(
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_message_workflow WHERE user_id = ? AND kind = ? AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          requestedType,
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ workflowId }),
          target.id,
          input.kind,
          claimToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_message_workflow WHERE user_id = ? AND kind = ? AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          attemptType,
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ state: 'committed' }),
          target.id,
          input.kind,
          claimToken,
        ),
    );
  }
  claimStatements.push(
    input.db
      .prepare(
        `INSERT INTO admin_idempotency_record
          (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
           response_body, retry_payload, created_at, expires_at)
          SELECT ?, ?, ?, 'POST', ?, ?, ?, 102, ?, NULL, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM reader_message_workflow WHERE user_id = ? AND kind = ? AND claim_token = ?
         )
          ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
            id = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
              THEN excluded.id ELSE admin_idempotency_record.id END,
            body_hash = excluded.body_hash,
            response_status = excluded.response_status,
            response_body = excluded.response_body,
            retry_payload = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
              THEN NULL ELSE admin_idempotency_record.retry_payload END,
            created_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
              THEN excluded.created_at ELSE admin_idempotency_record.created_at END,
            expires_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
              THEN excluded.expires_at ELSE admin_idempotency_record.expires_at END
          WHERE admin_idempotency_record.expires_at <= excluded.created_at
            OR (
              admin_idempotency_record.body_hash = excluded.body_hash
              AND admin_idempotency_record.response_status IN (102, 503)
            )`,
      )
      .bind(
        opaqueId(),
        input.administratorId,
        idempotencyKey,
        input.normalizedPath,
        target.id,
        bodyHash,
        failureBody,
        now,
        now + IDEMPOTENCY_RETENTION_MS,
        target.id,
        input.kind,
        claimToken,
      ),
  );

  try {
    const claimResults = await input.db.batch(claimStatements);
    if (claimResults[0]?.meta.changes !== 1) {
      const committed = await readCommitted();
      if (committed !== null && committed.body_hash !== bodyHash) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: target.id,
          requestId: input.requestId,
          type: attemptType,
          kind: 'idempotency-key-reused',
          code: 'idempotency-key-reused',
        });
      }
      if (committed?.response_status === 202) {
        const value = parseCommittedResponse(committed.response_body);
        if (value === null) return { kind: 'internal-error' };
        return {
          kind: 'accepted',
          value,
        };
      }
      if (committed?.response_status === 503) {
        return { kind: 'delivery-scheduling-failed' };
      }
      if (committed?.response_status === 102) {
        const terminal = await waitForTerminalIdempotency(readCommitted);
        if (terminal?.response_status === 202) {
          const value = parseCommittedResponse(terminal.response_body);
          return value === null ? { kind: 'internal-error' } : { kind: 'accepted', value };
        }
        if (terminal?.response_status === 503) return { kind: 'delivery-scheduling-failed' };
        return { kind: 'internal-error' };
      }
      const latestTarget = await readTarget(input.db, target.id);
      if (latestTarget === null) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: null,
          requestId: input.requestId,
          type: attemptType,
          kind: 'reader-not-found',
          code: 'reader-not-found',
        });
      }
      if (input.kind === 'email-verification' && latestTarget.email_verified === 1) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: latestTarget.id,
          requestId: input.requestId,
          type: attemptType,
          kind: 'invalid-transition',
          code: 'invalid-transition',
        });
      }
      if (
        input.kind === 'password-recovery' &&
        !(await hasUsableCredential(input.db, latestTarget.id))
      ) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          subjectId: latestTarget.id,
          requestId: input.requestId,
          type: attemptType,
          kind: 'no-usable-login-method',
          code: 'no-usable-login-method',
        });
      }
      const current = await readWorkflow(input.db, target.id, input.kind);
      if (current === null) return { kind: 'internal-error' };
      if (current.cooldown_until > now) {
        const retryAfterSeconds = Math.max(1, Math.ceil((current.cooldown_until - now) / 1000));
        try {
          await audit({
            db: input.db,
            actorId: input.administratorId,
            subjectId: target.id,
            requestId: input.requestId,
            type: attemptType,
            result: 'failure',
            problemCode: 'cooldown-active',
          });
          return { kind: 'cooldown-active', retryAfterSeconds };
        } catch {
          return { kind: 'internal-error' };
        }
      }
      return { kind: 'internal-error' };
    }
  } catch {
    return { kind: 'internal-error' };
  }

  const preparation = await prepareMessage({
    runtime: input.runtime,
    kind: input.kind,
    email: target.email,
    retryPayload: retrying ? existingIdempotency.retry_payload : null,
  });
  if (preparation.kind === 'internal-error') return { kind: 'internal-error' };
  let prepared: boolean;
  try {
    prepared = await persistPreparedMessage({
      db: input.db,
      actorId: input.administratorId,
      targetId: target.id,
      normalizedPath: input.normalizedPath,
      idempotencyKey,
      bodyHash,
      workflowId,
      claimToken,
      retryPayload: preparation.retryPayload,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (!prepared) return { kind: 'internal-error' };
  const scheduling = await input.runtime.retryReaderMessageScheduling(preparation.retryPayload);
  if (scheduling === 'invalid-envelope') {
    try {
      await invalidatePreparedMessage({
        db: input.db,
        actorId: input.administratorId,
        targetId: target.id,
        normalizedPath: input.normalizedPath,
        idempotencyKey,
        workflowId,
        claimToken,
        now: Date.now(),
      });
    } catch {
      return { kind: 'internal-error' };
    }
    return { kind: 'internal-error' };
  }
  const scheduled = scheduling === 'accepted';
  let applied: boolean;
  try {
    applied = await finishScheduling({
      db: input.db,
      actorId: input.administratorId,
      targetId: target.id,
      kind: input.kind,
      workflowId,
      claimToken,
      idempotencyKey: idempotencyKey,
      bodyHash,
      normalizedPath: input.normalizedPath,
      instancePath: input.instancePath,
      requestId: input.requestId,
      response,
      scheduled,
      retryPayload: preparation.retryPayload,
      now: Date.now(),
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (!applied) {
    const committed = await readCommitted();
    if (committed !== null && committed.body_hash !== bodyHash) {
      return auditedFailure({
        db: input.db,
        actorId: input.administratorId,
        subjectId: target.id,
        requestId: input.requestId,
        type: attemptType,
        kind: 'idempotency-key-reused',
        code: 'idempotency-key-reused',
      });
    }
    if (committed?.response_status === 202) {
      const value = parseCommittedResponse(committed.response_body);
      if (value === null) return { kind: 'internal-error' };
      return {
        kind: 'accepted',
        value,
      };
    }
    return { kind: 'delivery-scheduling-failed' };
  }
  return scheduled ? { kind: 'accepted', value: response } : { kind: 'delivery-scheduling-failed' };
}
