import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import {
  prepareReaderSessionRevocation,
  readerSessionRevocationCount,
} from './reader-session-store.js';
import type { IdentityRuntime } from './identity-runtime.js';
import type {
  AdminReaderDeletionRequest,
  AdminReaderDeletionRequestCreate,
  AdminReaderDeletionRequestStatus,
  AdminReaderDeletionRequestTransition,
} from './contract.js';
import {
  AdminReaderDeletionRequestSchema,
  AdminReaderDeletionRequestTransitionSchema,
} from './contract.js';
import type { ProblemCode } from '../../shared/problem.js';

const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export const READER_DELETION_REQUESTS_PATH = '/v1/admin/users/:userId/deletion-requests';
export const READER_DELETION_REQUEST_STATUS_PATH =
  '/v1/admin/users/:userId/deletion-requests/:requestId/status';

type DeletionState = 'pending_review' | 'approved' | 'rejected' | 'cancelled';
type AccessState = 'active' | 'disabled';

type FailureKind =
  | 'forbidden'
  | 'administrator-disabled'
  | 'reader-not-found'
  | 'deletion-request-not-found'
  | 'bad-request'
  | 'precondition-required'
  | 'stale-revision'
  | 'active-deletion-request'
  | 'invalid-transition'
  | 'idempotency-key-reused'
  | 'internal-error';

interface ReaderAccessRow {
  readonly id: string;
  readonly access_state: string | null;
  readonly revision: number | null;
}

interface DeletionRequestRow {
  readonly id: string;
  readonly user_id: string;
  readonly state: string;
  readonly revision: number;
  readonly previous_access_state: AccessState;
  readonly request_note: string | null;
  readonly decision_note: string | null;
  readonly cancellation_note: string | null;
  readonly created_by: string;
  readonly updated_by: string;
  readonly created_at: number;
  readonly updated_at: number;
}

interface IdempotencyRow {
  readonly body_hash: string;
  readonly response_status: number;
  readonly response_body: string;
  readonly expires_at: number;
}

interface Failure {
  readonly kind: FailureKind;
}
export type ReaderDeletionRequestFailure = Failure;

export type CreateReaderDeletionRequestOutcome =
  { readonly kind: 'success'; readonly value: AdminReaderDeletionRequest } | Failure;

export type TransitionReaderDeletionRequestOutcome =
  { readonly kind: 'success'; readonly value: AdminReaderDeletionRequestTransition } | Failure;

function opaqueId(): string {
  return crypto.randomUUID();
}

function currentRevision(row: ReaderAccessRow): number {
  return row.revision ?? 1;
}

function parseIfMatch(
  value: string | undefined,
):
  | { readonly kind: 'missing' }
  | { readonly kind: 'malformed' }
  | { readonly kind: 'revision'; readonly revision: number } {
  if (value === undefined) return { kind: 'missing' };
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return { kind: 'malformed' };
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? { kind: 'revision', revision } : { kind: 'malformed' };
}

async function digestBody(body: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readReader(db: D1Database, readerId: string): Promise<ReaderAccessRow | null> {
  return db
    .prepare(
      `SELECT u.id, ras.state AS access_state, ras.revision
       FROM user AS u
       LEFT JOIN reader_access_state AS ras ON ras.user_id = u.id
       WHERE u.id = ? AND (u.role IS NULL OR u.role <> 'admin') LIMIT 1`,
    )
    .bind(readerId)
    .first<ReaderAccessRow>();
}

async function readActiveDeletionRequest(
  db: D1Database,
  readerId: string,
): Promise<DeletionRequestRow | null> {
  return db
    .prepare(
      `SELECT id, user_id, state, revision, previous_access_state, request_note,
              decision_note, cancellation_note, created_by, updated_by, created_at, updated_at
       FROM reader_deletion_request
       WHERE user_id = ? AND state IN ('pending_review', 'approved')
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    .bind(readerId)
    .first<DeletionRequestRow>();
}

async function readDeletionRequest(input: {
  readonly db: D1Database;
  readonly readerId: string;
  readonly requestId: string;
}): Promise<DeletionRequestRow | null> {
  return input.db
    .prepare(
      `SELECT id, user_id, state, revision, previous_access_state, request_note,
              decision_note, cancellation_note, created_by, updated_by, created_at, updated_at
       FROM reader_deletion_request WHERE user_id = ? AND id = ? LIMIT 1`,
    )
    .bind(input.readerId, input.requestId)
    .first<DeletionRequestRow>();
}

async function readIdempotency(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly method: 'POST' | 'PUT';
  readonly path: string;
  readonly targetId: string;
  readonly key: string;
  readonly now: number;
}): Promise<IdempotencyRow | null> {
  return input.db
    .prepare(
      `SELECT body_hash, response_status, response_body, expires_at
       FROM admin_idempotency_record
       WHERE actor_id = ? AND method = ? AND normalized_path = ? AND target_id = ?
         AND key = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(input.actorId, input.method, input.path, input.targetId, input.key, input.now)
    .first<IdempotencyRow>();
}

async function appendEvent(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly readerId: string | null;
  readonly requestId: string;
  readonly type: string;
  readonly result: 'success' | 'failure';
  readonly problemCode?: ProblemCode;
  readonly metadata?: Record<string, boolean | number | string>;
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
      input.readerId === null ? null : 'reader',
      input.readerId,
      input.result,
      input.requestId,
      input.problemCode ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}

async function auditedFailure<T extends Failure>(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly readerId: string | null;
  readonly requestId: string;
  readonly kind: T['kind'];
}): Promise<T | { readonly kind: 'internal-error' }> {
  try {
    await appendEvent({
      db: input.db,
      actorId: input.actorId,
      readerId: input.readerId,
      requestId: input.requestId,
      type: 'deletion-request-attempt',
      result: 'failure',
      problemCode: input.kind,
    });
    return { kind: input.kind } as T;
  } catch {
    return { kind: 'internal-error' };
  }
}

async function authorize(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly requestId: string;
}): Promise<Failure | null> {
  try {
    const authorization = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
    return authorization.kind === 'allowed'
      ? null
      : await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          readerId: null,
          requestId: input.requestId,
          kind: authorization.kind,
        });
  } catch {
    return { kind: 'internal-error' };
  }
}

export async function authorizeReaderDeletionRequestActor(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly requestId: string;
}): Promise<ReaderDeletionRequestFailure | null> {
  return authorize(input);
}

export async function rejectInvalidReaderDeletionNote(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly requestId: string;
}): Promise<ReaderDeletionRequestFailure> {
  const authorizationFailure = await authorize(input);
  if (authorizationFailure !== null) return authorizationFailure;
  return await auditedFailure({
    db: input.db,
    actorId: input.administratorId,
    readerId: null,
    requestId: input.requestId,
    kind: 'bad-request',
  });
}

function parseCreateReplay(body: string): AdminReaderDeletionRequest | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = AdminReaderDeletionRequestSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function parseTransitionReplay(body: string): AdminReaderDeletionRequestTransition | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = AdminReaderDeletionRequestTransitionSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function createValue(input: {
  readonly requestId: string;
  readonly previousAccessState: AccessState;
  readonly revision: number;
  readonly accountRevision: number;
  readonly now: number;
}): AdminReaderDeletionRequest {
  const value: AdminReaderDeletionRequest = {
    requestId: input.requestId,
    state: 'pending_review',
    previousAccessState: input.previousAccessState,
    changed: true,
    revision: input.revision,
    accountRevision: input.accountRevision,
    createdAt: new Date(input.now).toISOString(),
    updatedAt: new Date(input.now).toISOString(),
  };
  return value;
}

function transitionValue(input: {
  readonly request: DeletionRequestRow;
  readonly state: DeletionState;
  readonly changed: boolean;
  readonly revision: number;
  readonly accountRevision: number;
  readonly updatedAt: number;
}): AdminReaderDeletionRequestTransition {
  return {
    requestId: input.request.id,
    state: input.state,
    previousAccessState: input.request.previous_access_state,
    changed: input.changed,
    revision: input.revision,
    accountRevision: input.accountRevision,
    updatedAt: new Date(input.updatedAt).toISOString(),
  };
}

export async function createReaderDeletionRequest(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
  readonly body: AdminReaderDeletionRequestCreate;
  readonly requestId: string;
}): Promise<CreateReaderDeletionRequestOutcome> {
  const authorizationFailure = await authorize(input);
  if (authorizationFailure !== null) return authorizationFailure;
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }

  const key = input.idempotencyKey;
  const now = Date.now();
  const bodyHash = await digestBody(input.body);
  const readCommand = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'POST',
      path: READER_DELETION_REQUESTS_PATH,
      targetId: input.readerId,
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
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'idempotency-key-reused',
    });
  }
  if (existing?.response_status === 201) {
    const value = parseCreateReplay(existing.response_body);
    return value === null ? { kind: 'internal-error' } : { kind: 'success', value };
  }

  let target: ReaderAccessRow | null;
  try {
    target = await readReader(input.db, input.readerId);
  } catch {
    return { kind: 'internal-error' };
  }
  if (target === null) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'reader-not-found',
    });
  }
  const previousAccessState: AccessState =
    target.access_state === 'disabled' ? 'disabled' : 'active';
  if (
    target.access_state !== null &&
    target.access_state !== 'active' &&
    target.access_state !== 'disabled'
  ) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'invalid-transition',
    });
  }
  const accountRevision = currentRevision(target);
  const precondition = parseIfMatch(input.ifMatch);
  if (precondition.kind === 'missing') {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }
  if (precondition.kind === 'malformed') {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'bad-request',
    });
  }
  if (precondition.revision !== accountRevision) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'stale-revision',
    });
  }
  if (await readActiveDeletionRequest(input.db, target.id)) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'active-deletion-request',
    });
  }

  const requestId = opaqueId();
  const mutationToken = opaqueId();
  const nextAccountRevision = accountRevision + 1;
  const response = createValue({
    requestId,
    previousAccessState,
    revision: 1,
    accountRevision: nextAccountRevision,
    now,
  });
  const deletionSessionGuard = {
    kind: 'deletion-request' as const,
    requestId,
    revision: nextAccountRevision,
    mutationToken,
    now,
  };
  const deletionSessionCount = readerSessionRevocationCount({
    readerId: target.id,
    guard: deletionSessionGuard,
  });
  try {
    const results = await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO reader_access_state (user_id, state, revision, mutation_token, updated_at)
           VALUES (?, ?, ?, NULL, ?)
           ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(target.id, previousAccessState, accountRevision, now),
      input.db
        .prepare(
          `UPDATE reader_access_state
           SET revision = ?, mutation_token = ?, updated_at = ?
           WHERE user_id = ? AND revision = ? AND state = ?
             AND NOT EXISTS (
               SELECT 1 FROM reader_deletion_request
               WHERE user_id = ? AND state IN ('pending_review', 'approved')
             )`,
        )
        .bind(
          nextAccountRevision,
          mutationToken,
          now,
          target.id,
          accountRevision,
          previousAccessState,
          target.id,
        ),
      input.db
        .prepare(
          `INSERT INTO reader_deletion_request
           (id, user_id, state, revision, previous_access_state, request_note, decision_note,
            cancellation_note, created_by, updated_by, created_at, updated_at)
           SELECT ?, ?, 'pending_review', 1, ?, ?, NULL, NULL, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND revision = ? AND mutation_token = ?
           ) AND NOT EXISTS (
             SELECT 1 FROM reader_deletion_request
             WHERE user_id = ? AND state IN ('pending_review', 'approved')
           )
           ON CONFLICT DO NOTHING`,
        )
        .bind(
          requestId,
          target.id,
          previousAccessState,
          input.body.note ?? null,
          input.administratorId,
          input.administratorId,
          now,
          now,
          target.id,
          nextAccountRevision,
          mutationToken,
          target.id,
        ),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, created_at, expires_at)
           SELECT ?, ?, ?, 'POST', ?, ?, ?, 201, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_deletion_request
             WHERE id = ? AND user_id = ? AND state = 'pending_review'
           ) AND EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND revision = ? AND mutation_token = ?
           )
           ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
             id = excluded.id, body_hash = excluded.body_hash, response_status = excluded.response_status,
             response_body = excluded.response_body, created_at = excluded.created_at,
             expires_at = excluded.expires_at
           WHERE admin_idempotency_record.expires_at <= excluded.created_at`,
        )
        .bind(
          opaqueId(),
          input.administratorId,
          key,
          READER_DELETION_REQUESTS_PATH,
          target.id,
          bodyHash,
          JSON.stringify(response),
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          requestId,
          target.id,
          target.id,
          nextAccountRevision,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'deletion-requested', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL,
             json_set(?, '$.revokedSessionCount', ${deletionSessionCount.sql})
           WHERE EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 201
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ workflowId: requestId, previousAccessState, revision: 1 }),
          ...deletionSessionCount.bindings,
          input.administratorId,
          READER_DELETION_REQUESTS_PATH,
          target.id,
          key,
          bodyHash,
        ),
      prepareReaderSessionRevocation(input.db, target.id, {
        ...deletionSessionGuard,
      }),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'deletion-request-attempt', ?, 'administrator', ?, 'reader', ?,
                  'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 201
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed: true, state: 'pending_review', revision: 1 }),
          input.administratorId,
          READER_DELETION_REQUESTS_PATH,
          target.id,
          key,
          bodyHash,
        ),
    ]);
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
      const replay = await readCommand();
      if (replay !== null) {
        if (replay.body_hash !== bodyHash) {
          return await auditedFailure({
            db: input.db,
            actorId: input.administratorId,
            readerId: target.id,
            requestId: input.requestId,
            kind: 'idempotency-key-reused',
          });
        }
        const value = parseCreateReplay(replay.response_body);
        return value === null ? { kind: 'internal-error' } : { kind: 'success', value };
      }
      const current = await readReader(input.db, target.id);
      if (current !== null && currentRevision(current) !== accountRevision) {
        return await auditedFailure({
          db: input.db,
          actorId: input.administratorId,
          readerId: target.id,
          requestId: input.requestId,
          kind: 'stale-revision',
        });
      }
      return await auditedFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'active-deletion-request',
      });
    }
    if (results[4]?.meta.changes !== 1) return { kind: 'internal-error' };
  } catch {
    return { kind: 'internal-error' };
  }
  return { kind: 'success', value: response };
}

function isDeletionState(state: string): state is DeletionState {
  return (
    state === 'pending_review' ||
    state === 'approved' ||
    state === 'rejected' ||
    state === 'cancelled'
  );
}

function isSameTransitionAllowed(state: DeletionState, next: DeletionState): boolean {
  if (state === next) return true;
  if (state === 'pending_review') {
    return next === 'approved' || next === 'rejected' || next === 'cancelled';
  }
  // No material deletion operation exists in this service slice; until one is
  // introduced, an approved request remains cancellable.
  return state === 'approved' && next === 'cancelled';
}

export async function transitionReaderDeletionRequest(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly requestId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly idempotencyKey?: string;
  readonly body: AdminReaderDeletionRequestStatus;
  readonly requestIdForAudit: string;
}): Promise<TransitionReaderDeletionRequestOutcome> {
  const authorizationFailure = await authorize({
    db: input.db,
    runtime: input.runtime,
    administratorId: input.administratorId,
    headers: input.headers,
    requestId: input.requestIdForAudit,
  });
  if (authorizationFailure !== null) return authorizationFailure;
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestIdForAudit,
      kind: 'precondition-required',
    });
  }
  const key = input.idempotencyKey;
  const now = Date.now();
  const bodyHash = await digestBody(input.body);
  const readCommand = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.administratorId,
      method: 'PUT',
      path: READER_DELETION_REQUEST_STATUS_PATH,
      targetId: input.requestId,
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
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestIdForAudit,
      kind: 'idempotency-key-reused',
    });
  }
  if (existing?.response_status === 200) {
    const value = parseTransitionReplay(existing.response_body);
    return value === null ? { kind: 'internal-error' } : { kind: 'success', value };
  }

  const target = await readReader(input.db, input.readerId);
  if (target === null) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestIdForAudit,
      kind: 'reader-not-found',
    });
  }
  const deletionRequest = await readDeletionRequest({
    db: input.db,
    readerId: target.id,
    requestId: input.requestId,
  });
  if (deletionRequest === null) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestIdForAudit,
      kind: 'deletion-request-not-found',
    });
  }
  if (!isDeletionState(deletionRequest.state)) return { kind: 'internal-error' };
  const expected = parseIfMatch(input.ifMatch);
  if (expected.kind === 'missing') {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestIdForAudit,
      kind: 'precondition-required',
    });
  }
  if (expected.kind === 'malformed') {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestIdForAudit,
      kind: 'bad-request',
    });
  }
  if (expected.revision !== deletionRequest.revision) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestIdForAudit,
      kind: 'stale-revision',
    });
  }
  const nextState = input.body.state;
  if (!isSameTransitionAllowed(deletionRequest.state, nextState)) {
    return await auditedFailure({
      db: input.db,
      actorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestIdForAudit,
      kind: 'invalid-transition',
    });
  }

  const accountRevision = currentRevision(target);
  const changed = deletionRequest.state !== nextState;
  const nextRevision = changed ? deletionRequest.revision + 1 : deletionRequest.revision;
  const nextAccountRevision = changed ? accountRevision + 1 : accountRevision;
  const response = transitionValue({
    request: deletionRequest,
    state: nextState,
    changed,
    revision: nextRevision,
    accountRevision: nextAccountRevision,
    updatedAt: changed ? now : deletionRequest.updated_at,
  });

  if (!changed) {
    try {
      const results = await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO admin_idempotency_record
             (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
              response_body, created_at, expires_at)
             SELECT ?, ?, ?, 'PUT', ?, ?, ?, 200, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM reader_deletion_request
               WHERE id = ? AND user_id = ? AND state = ? AND revision = ?
             )
             ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
               id = excluded.id, body_hash = excluded.body_hash, response_status = 200,
               response_body = excluded.response_body, created_at = excluded.created_at,
               expires_at = excluded.expires_at
             WHERE admin_idempotency_record.expires_at <= excluded.created_at`,
          )
          .bind(
            opaqueId(),
            input.administratorId,
            key,
            READER_DELETION_REQUEST_STATUS_PATH,
            input.requestId,
            bodyHash,
            JSON.stringify(response),
            now,
            now + IDEMPOTENCY_RETENTION_MS,
            deletionRequest.id,
            target.id,
            deletionRequest.state,
            deletionRequest.revision,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'deletion-request-attempt', ?, 'administrator', ?, 'reader', ?,
                    'success', ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'PUT' AND normalized_path = ?
                 AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 200
             )`,
          )
          .bind(
            opaqueId(),
            now,
            input.administratorId,
            target.id,
            input.requestIdForAudit,
            JSON.stringify({ changed: false, state: nextState, revision: nextRevision }),
            input.administratorId,
            READER_DELETION_REQUEST_STATUS_PATH,
            input.requestId,
            key,
            bodyHash,
          ),
      ]);
      if (results[0]?.meta.changes !== 1) return { kind: 'internal-error' };
    } catch {
      return { kind: 'internal-error' };
    }
    return { kind: 'success', value: response };
  }

  const mutationToken = opaqueId();
  const lifecycleType =
    nextState === 'approved'
      ? 'deletion-approved'
      : nextState === 'rejected'
        ? 'deletion-rejected'
        : 'deletion-cancelled';
  const decisionNote =
    nextState === 'approved' || nextState === 'rejected' ? input.body.note : null;
  const cancellationNote = nextState === 'cancelled' ? (input.body.note ?? null) : null;
  try {
    const results = await input.db.batch([
      input.db
        .prepare(
          `UPDATE reader_access_state
           SET state = CASE WHEN ? IN ('rejected', 'cancelled')
                            THEN (SELECT previous_access_state FROM reader_deletion_request
                                  WHERE id = ? AND state = ? AND revision = ?)
                            ELSE state END,
               revision = ?, mutation_token = ?, updated_at = ?
           WHERE user_id = ? AND revision = ?
             AND EXISTS (
               SELECT 1 FROM reader_deletion_request
               WHERE id = ? AND user_id = ? AND state = ? AND revision = ?
             )`,
        )
        .bind(
          nextState,
          deletionRequest.id,
          deletionRequest.state,
          deletionRequest.revision,
          nextAccountRevision,
          mutationToken,
          now,
          target.id,
          accountRevision,
          deletionRequest.id,
          target.id,
          deletionRequest.state,
          deletionRequest.revision,
        ),
      input.db
        .prepare(
          `UPDATE reader_deletion_request
           SET state = ?, revision = ?, decision_note = COALESCE(?, decision_note),
               cancellation_note = COALESCE(?, cancellation_note), updated_by = ?, updated_at = ?
           WHERE id = ? AND user_id = ? AND state = ? AND revision = ?
             AND EXISTS (
               SELECT 1 FROM reader_access_state
               WHERE user_id = ? AND revision = ? AND mutation_token = ?
             )`,
        )
        .bind(
          nextState,
          nextRevision,
          decisionNote,
          cancellationNote,
          input.administratorId,
          now,
          deletionRequest.id,
          target.id,
          deletionRequest.state,
          deletionRequest.revision,
          target.id,
          nextAccountRevision,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, created_at, expires_at)
           SELECT ?, ?, ?, 'PUT', ?, ?, ?, 200, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_deletion_request
             WHERE id = ? AND user_id = ? AND state = ? AND revision = ?
           ) AND EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND revision = ? AND mutation_token = ?
           )
           ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
             id = excluded.id, body_hash = excluded.body_hash, response_status = 200,
             response_body = excluded.response_body, created_at = excluded.created_at,
             expires_at = excluded.expires_at
           WHERE admin_idempotency_record.expires_at <= excluded.created_at`,
        )
        .bind(
          opaqueId(),
          input.administratorId,
          key,
          READER_DELETION_REQUEST_STATUS_PATH,
          deletionRequest.id,
          bodyHash,
          JSON.stringify(response),
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          deletionRequest.id,
          target.id,
          nextState,
          nextRevision,
          target.id,
          nextAccountRevision,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'PUT' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 200
           ) AND EXISTS (
             SELECT 1 FROM reader_deletion_request
             WHERE id = ? AND state = ? AND revision = ?
           )`,
        )
        .bind(
          opaqueId(),
          lifecycleType,
          now,
          input.administratorId,
          target.id,
          input.requestIdForAudit,
          JSON.stringify({
            workflowId: deletionRequest.id,
            state: nextState,
            revision: nextRevision,
          }),
          input.administratorId,
          READER_DELETION_REQUEST_STATUS_PATH,
          deletionRequest.id,
          key,
          bodyHash,
          deletionRequest.id,
          nextState,
          nextRevision,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'deletion-request-attempt', ?, 'administrator', ?, 'reader', ?,
                  'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'PUT' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 200
           ) AND EXISTS (
             SELECT 1 FROM reader_deletion_request
             WHERE id = ? AND state = ? AND revision = ?
           )`,
        )
        .bind(
          opaqueId(),
          now,
          input.administratorId,
          target.id,
          input.requestIdForAudit,
          JSON.stringify({ changed: true, state: nextState, revision: nextRevision }),
          input.administratorId,
          READER_DELETION_REQUEST_STATUS_PATH,
          deletionRequest.id,
          key,
          bodyHash,
          deletionRequest.id,
          nextState,
          nextRevision,
        ),
    ]);
    if (results[0]?.meta.changes !== 1 || results[1]?.meta.changes !== 1) {
      const replay = await readCommand();
      if (replay !== null && replay.body_hash === bodyHash && replay.response_status === 200) {
        const value = parseTransitionReplay(replay.response_body);
        return value === null ? { kind: 'internal-error' } : { kind: 'success', value };
      }
      const current = await readDeletionRequest({
        db: input.db,
        readerId: target.id,
        requestId: deletionRequest.id,
      });
      return await auditedFailure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestIdForAudit,
        kind:
          current?.revision !== deletionRequest.revision ? 'stale-revision' : 'invalid-transition',
      });
    }
    if (results[2]?.meta.changes !== 1) return { kind: 'internal-error' };
  } catch {
    return { kind: 'internal-error' };
  }
  return { kind: 'success', value: response };
}
