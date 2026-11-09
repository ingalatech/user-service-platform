import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types';

export type ReaderSessionRevocationGuard =
  | { readonly kind: 'manual-all'; readonly now: number }
  | { readonly kind: 'manual-one'; readonly sessionId: string; readonly now: number }
  | {
      readonly kind: 'access-disable';
      readonly revision: number;
      readonly mutationToken: string;
      readonly now: number;
    }
  | {
      readonly kind: 'deletion-request';
      readonly requestId: string;
      readonly revision: number;
      readonly mutationToken: string;
      readonly now: number;
    }
  | {
      readonly kind: 'social-unlink';
      readonly revision: number;
      readonly mutationToken: string;
      readonly now: number;
    }
  | {
      readonly kind: 'email-change';
      readonly revision: number;
      readonly mutationToken: string;
      readonly newEmail: string;
      readonly now: number;
    };

// Keep every workflow's session invalidation in the Reader session capability;
// the guard preserves the owning command's CAS fence inside its D1 batch.
export function readerSessionTimestamp(nowMilliseconds: number): number {
  return Math.floor(nowMilliseconds / 1_000);
}

export function prepareReaderSessionRevocation(
  db: D1Database,
  readerId: string,
  guard: ReaderSessionRevocationGuard,
): D1PreparedStatement {
  if (guard.kind === 'manual-all') {
    return db
      .prepare('DELETE FROM session WHERE user_id=? AND expires_at>?')
      .bind(readerId, readerSessionTimestamp(guard.now));
  }
  if (guard.kind === 'manual-one') {
    return db
      .prepare('DELETE FROM session WHERE id=? AND user_id=? AND expires_at>?')
      .bind(guard.sessionId, readerId, readerSessionTimestamp(guard.now));
  }
  if (guard.kind === 'access-disable') {
    return db
      .prepare(
        `DELETE FROM session WHERE user_id=? AND expires_at>? AND EXISTS (
           SELECT 1 FROM reader_access_state
           WHERE user_id=? AND state='disabled' AND revision=? AND mutation_token=?
         )`,
      )
      .bind(
        readerId,
        readerSessionTimestamp(guard.now),
        readerId,
        guard.revision,
        guard.mutationToken,
      );
  }
  if (guard.kind === 'deletion-request') {
    return db
      .prepare(
        `DELETE FROM session WHERE user_id=? AND expires_at>? AND EXISTS (
           SELECT 1 FROM reader_deletion_request
           WHERE id=? AND user_id=? AND state='pending_review'
         ) AND EXISTS (
           SELECT 1 FROM reader_access_state
           WHERE user_id=? AND revision=? AND mutation_token=?
         )`,
      )
      .bind(
        readerId,
        readerSessionTimestamp(guard.now),
        guard.requestId,
        readerId,
        readerId,
        guard.revision,
        guard.mutationToken,
      );
  }
  if (guard.kind === 'social-unlink') {
    return db
      .prepare(
        `DELETE FROM session WHERE user_id=? AND expires_at>? AND EXISTS (
           SELECT 1 FROM reader_access_state
           WHERE user_id=? AND revision=? AND mutation_token=?
         )`,
      )
      .bind(
        readerId,
        readerSessionTimestamp(guard.now),
        readerId,
        guard.revision,
        guard.mutationToken,
      );
  }
  return db
    .prepare(
      `DELETE FROM session WHERE user_id=? AND expires_at>? AND EXISTS (
         SELECT 1 FROM reader_access_state
         WHERE user_id=? AND revision=? AND mutation_token=?
       ) AND EXISTS (
         SELECT 1 FROM user WHERE id=? AND email=? AND email_verified=1
       )`,
    )
    .bind(
      readerId,
      readerSessionTimestamp(guard.now),
      readerId,
      guard.revision,
      guard.mutationToken,
      readerId,
      guard.newEmail,
    );
}

export function readerSessionRevocationCount(input: {
  readonly readerId: string;
  readonly guard: Exclude<ReaderSessionRevocationGuard, { kind: 'manual-one' | 'manual-all' }>;
}): { readonly sql: string; readonly bindings: (string | number)[] } {
  const { readerId, guard } = input;
  const base = 'SELECT count(*) FROM session WHERE session.user_id=? AND session.expires_at>?';
  if (guard.kind === 'access-disable') {
    return {
      sql: `(${base} AND EXISTS (SELECT 1 FROM reader_access_state WHERE user_id=? AND state='disabled' AND revision=? AND mutation_token=?))`,
      bindings: [
        readerId,
        readerSessionTimestamp(guard.now),
        readerId,
        guard.revision,
        guard.mutationToken,
      ],
    };
  }
  if (guard.kind === 'deletion-request') {
    return {
      sql: `(${base} AND EXISTS (SELECT 1 FROM reader_deletion_request WHERE id=? AND user_id=? AND state='pending_review') AND EXISTS (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?))`,
      bindings: [
        readerId,
        readerSessionTimestamp(guard.now),
        guard.requestId,
        readerId,
        readerId,
        guard.revision,
        guard.mutationToken,
      ],
    };
  }
  if (guard.kind === 'social-unlink') {
    return {
      sql: `(${base} AND EXISTS (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?))`,
      bindings: [
        readerId,
        readerSessionTimestamp(guard.now),
        readerId,
        guard.revision,
        guard.mutationToken,
      ],
    };
  }
  return {
    sql: `(${base} AND EXISTS (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?) AND EXISTS (SELECT 1 FROM user WHERE id=? AND email=? AND email_verified=1))`,
    bindings: [
      readerId,
      readerSessionTimestamp(guard.now),
      readerId,
      guard.revision,
      guard.mutationToken,
      readerId,
      guard.newEmail,
    ],
  };
}
