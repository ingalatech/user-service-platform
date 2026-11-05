import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import type { IdentityRuntime } from './identity-runtime.js';
import type { AdminReaderAccessRequest, AdminReaderAccessResult } from './contract.js';
import type { ProblemCode } from '../../shared/problem.js';

export const READER_ACCESS_PATH = '/v1/admin/users/:userId/access';

type FailureKind =
  | 'forbidden'
  | 'administrator-disabled'
  | 'reader-not-found'
  | 'active-deletion-request'
  | 'bad-request'
  | 'precondition-required'
  | 'stale-revision'
  | 'internal-error';

interface ReaderAccessRow {
  readonly id: string;
  readonly state: string | null;
  readonly revision: number | null;
}

export type SetReaderAccessOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderAccessResult }
  | { readonly kind: FailureKind };

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

function currentRevision(target: ReaderAccessRow): number {
  return target.revision ?? 1;
}

async function readTarget(db: D1Database, readerId: string): Promise<ReaderAccessRow | null> {
  return db
    .prepare(
      `SELECT u.id, reader_access_state.state, reader_access_state.revision
       FROM user AS u LEFT JOIN reader_access_state ON reader_access_state.user_id = u.id
       WHERE u.id = ? AND (u.role IS NULL OR u.role <> 'admin') LIMIT 1`,
    )
    .bind(readerId)
    .first<ReaderAccessRow>();
}

async function hasActiveDeletionRequest(db: D1Database, readerId: string): Promise<boolean> {
  const active = await db
    .prepare(
      `SELECT 1 AS active FROM reader_deletion_request
       WHERE user_id = ? AND state IN ('pending_review', 'approved') LIMIT 1`,
    )
    .bind(readerId)
    .first<{ active: number }>();
  return active !== null;
}

async function auditedFailure(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string | null;
  readonly requestId: string;
  readonly kind: Exclude<FailureKind, 'internal-error'>;
}): Promise<{ readonly kind: FailureKind }> {
  try {
    await input.db
      .prepare(
        `INSERT INTO identity_event
         (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
          result, request_id, problem_code, metadata)
         VALUES (?, 1, 'access-attempt', ?, 'administrator', ?, ?, ?, 'failure', ?, ?, NULL)`,
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.administratorId,
        input.readerId === null ? null : 'reader',
        input.readerId,
        input.requestId,
        input.kind satisfies ProblemCode,
      )
      .run();
    return { kind: input.kind };
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
}): Promise<{ readonly kind: FailureKind } | null> {
  try {
    const result = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
    return result.kind === 'allowed'
      ? null
      : await auditedFailure({
          db: input.db,
          administratorId: input.administratorId,
          readerId: null,
          requestId: input.requestId,
          kind: result.kind,
        });
  } catch {
    return { kind: 'internal-error' };
  }
}

export async function setReaderAccess(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly administratorId: string;
  readonly readerId: string;
  readonly headers: Headers;
  readonly ifMatch?: string;
  readonly body: AdminReaderAccessRequest;
  readonly requestId: string;
}): Promise<SetReaderAccessOutcome> {
  const authorizationFailure = await authorize(input);
  if (authorizationFailure !== null) return authorizationFailure;
  let target: ReaderAccessRow | null;
  try {
    target = await readTarget(input.db, input.readerId);
  } catch {
    return { kind: 'internal-error' };
  }
  if (target === null) {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'reader-not-found',
    });
  }
  const precondition = parseIfMatch(input.ifMatch);
  if (precondition.kind === 'missing') {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }
  if (precondition.kind === 'malformed') {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'bad-request',
    });
  }
  const revision = currentRevision(target);
  if (precondition.revision !== revision) {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'stale-revision',
    });
  }
  if (await hasActiveDeletionRequest(input.db, target.id)) {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'active-deletion-request',
    });
  }
  const previousState = target.state ?? 'active';
  if (previousState !== 'active' && previousState !== 'disabled') {
    return await auditedFailure({
      db: input.db,
      administratorId: input.administratorId,
      readerId: target.id,
      requestId: input.requestId,
      kind: 'bad-request',
    });
  }
  const changed = previousState !== input.body.state;
  const nextRevision = changed ? revision + 1 : revision;
  if (!changed) {
    try {
      await input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           VALUES (?, 1, 'access-attempt', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          Date.now(),
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed: false }),
        )
        .run();
    } catch {
      return { kind: 'internal-error' };
    }
    return {
      kind: 'success',
      value: { state: input.body.state, changed: false, revision },
    };
  }

  const mutationToken = crypto.randomUUID();
  const now = Date.now();
  const lifecycleType =
    input.body.state === 'disabled' ? 'access-disabled' : 'access-rehabilitated';
  try {
    const results = await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO reader_access_state (user_id, state, revision, updated_at)
           VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(target.id, previousState, revision, now),
      input.db
        .prepare(
          `UPDATE reader_access_state
           SET state = ?, revision = ?, mutation_token = ?, updated_at = ?
           WHERE user_id = ? AND state = ? AND revision = ?
             AND NOT EXISTS (
               SELECT 1 FROM reader_deletion_request
               WHERE user_id = ? AND state IN ('pending_review', 'approved')
             )`,
        )
        .bind(
          input.body.state,
          nextRevision,
          mutationToken,
          now,
          target.id,
          previousState,
          revision,
          target.id,
        ),
      ...(input.body.state === 'disabled'
        ? [
            input.db
              .prepare(
                `DELETE FROM session WHERE user_id = ? AND EXISTS (
                   SELECT 1 FROM reader_access_state
                   WHERE user_id = ? AND state = 'disabled' AND revision = ? AND mutation_token = ?
                 )`,
              )
              .bind(target.id, target.id, nextRevision, mutationToken),
          ]
        : []),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, ?, ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND state = ? AND revision = ? AND mutation_token = ?
           )`,
        )
        .bind(
          crypto.randomUUID(),
          lifecycleType,
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ revision: nextRevision }),
          target.id,
          input.body.state,
          nextRevision,
          mutationToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, 'access-attempt', ?, 'administrator', ?, 'reader', ?, 'success', ?, NULL, ?
           WHERE EXISTS (
             SELECT 1 FROM reader_access_state
             WHERE user_id = ? AND state = ? AND revision = ? AND mutation_token = ?
           )`,
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed: true, revision: nextRevision }),
          target.id,
          input.body.state,
          nextRevision,
          mutationToken,
        ),
    ]);
    const updateIndex = 1;
    if (results[updateIndex]?.meta.changes !== 1) {
      if (await hasActiveDeletionRequest(input.db, target.id)) {
        return await auditedFailure({
          db: input.db,
          administratorId: input.administratorId,
          readerId: target.id,
          requestId: input.requestId,
          kind: 'active-deletion-request',
        });
      }
      return await auditedFailure({
        db: input.db,
        administratorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'stale-revision',
      });
    }
  } catch {
    return { kind: 'internal-error' };
  }
  return {
    kind: 'success',
    value: { state: input.body.state, changed: true, revision: nextRevision },
  };
}
