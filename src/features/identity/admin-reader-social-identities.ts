import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import type { IdentityRuntime } from './identity-runtime.js';
import type { AdminReaderSocialIdentityUnlink } from './contract.js';
import { AdminReaderSocialIdentityUnlinkSchema } from './contract.js';
import type { ProblemCode } from '../../shared/problem.js';

export const READER_SOCIAL_IDENTITY_UNLINK_PATH =
  '/v1/admin/users/:userId/social-identities/:associationId';
const IDEMPOTENCY_RETENTION_MS = 86_400_000;
const NOTICE_CLAIM_LEASE_MS = 120_000;

export async function claimReaderSocialIdentityNotice(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string;
  readonly idempotencyKey: string;
  readonly now?: number;
}): Promise<boolean> {
  const now = input.now ?? Date.now();
  const result = await input.db
    .prepare(
      `UPDATE admin_idempotency_record SET response_status=102, created_at=?
       WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=?
         AND retry_payload IS NOT NULL
         AND (response_status=200 OR (response_status=102 AND created_at<=?))`,
    )
    .bind(
      now,
      input.administratorId,
      READER_SOCIAL_IDENTITY_UNLINK_PATH,
      input.readerId,
      input.idempotencyKey,
      now - NOTICE_CLAIM_LEASE_MS,
    )
    .run();
  return result.meta.changes === 1;
}

export type SocialIdentityFailureKind =
  | 'forbidden'
  | 'administrator-disabled'
  | 'reader-not-found'
  | 'bad-request'
  | 'precondition-required'
  | 'stale-revision'
  | 'active-deletion-request'
  | 'no-usable-login-method'
  | 'idempotency-key-reused'
  | 'internal-error'
  | 'delivery-scheduling-failed';
export type SocialIdentityUnlinkOutcome =
  | {
      readonly kind: 'success';
      readonly value: AdminReaderSocialIdentityUnlink;
      readonly retryPayload?: string;
    }
  | { readonly kind: SocialIdentityFailureKind };

export async function markReaderSocialIdentityNoticeScheduled(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string;
  readonly idempotencyKey: string;
}): Promise<boolean> {
  try {
    const result = await input.db
      .prepare(
        `UPDATE admin_idempotency_record SET retry_payload = NULL, response_status=200
         WHERE actor_id = ? AND method = 'DELETE' AND normalized_path = ?
           AND target_id = ? AND key = ? AND response_status = 102 AND retry_payload IS NOT NULL`,
      )
      .bind(
        input.administratorId,
        READER_SOCIAL_IDENTITY_UNLINK_PATH,
        input.readerId,
        input.idempotencyKey,
      )
      .run();
    return result.meta.changes === 1;
  } catch {
    return false;
  }
}

export async function releaseReaderSocialIdentityNoticeClaim(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string;
  readonly idempotencyKey: string;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE admin_idempotency_record SET response_status=200
       WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=?
         AND response_status=102 AND retry_payload IS NOT NULL`,
    )
    .bind(
      input.administratorId,
      READER_SOCIAL_IDENTITY_UNLINK_PATH,
      input.readerId,
      input.idempotencyKey,
    )
    .run();
}

export async function markReaderSocialIdentityNoticeDispatched(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string;
  readonly idempotencyKey: string;
}): Promise<void> {
  await input.db
    .prepare(
      `UPDATE admin_idempotency_record SET response_status=103
       WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=?
         AND response_status=102`,
    )
    .bind(
      input.administratorId,
      READER_SOCIAL_IDENTITY_UNLINK_PATH,
      input.readerId,
      input.idempotencyKey,
    )
    .run();
}

interface AccountState {
  readonly revision: number | null;
  readonly email_verified: number;
  readonly access_state: string | null;
  readonly email: string;
}
interface ReplayRow {
  readonly body_hash: string;
  readonly response_body: string;
  readonly response_status: number;
  readonly retry_payload: string | null;
  readonly created_at?: number;
}

function uuid(): string {
  return crypto.randomUUID();
}
function parseRevision(value: string | undefined): number | null {
  if (value === undefined) return null;
  const match = /^"([1-9][0-9]*)"$/.exec(value);
  if (match === null) return -1;
  const revision = Number(match[1]);
  return Number.isSafeInteger(revision) ? revision : -1;
}
async function hash(value: string): Promise<string> {
  const bytes = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
  );
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
async function audit(input: {
  db: D1Database;
  actorId: string;
  readerId: string | null;
  requestId: string;
  type: 'social-unlink-attempt' | 'social-identity-unlinked';
  result: 'success' | 'failure';
  code?: ProblemCode;
  metadata?: Record<string, string | number | boolean>;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO identity_event
    (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
    VALUES (?,1,?,?, 'administrator', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      uuid(),
      input.type,
      Date.now(),
      input.actorId,
      input.readerId === null ? null : 'reader',
      input.readerId,
      input.result,
      input.requestId,
      input.code ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}
async function failure(input: {
  db: D1Database;
  actorId: string;
  readerId: string | null;
  requestId: string;
  kind: SocialIdentityFailureKind;
}): Promise<SocialIdentityUnlinkOutcome> {
  try {
    await audit({ ...input, type: 'social-unlink-attempt', result: 'failure', code: input.kind });
    return { kind: input.kind };
  } catch {
    return { kind: 'internal-error' };
  }
}

export async function unlinkReaderSocialIdentity(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  administratorId: string;
  readerId: string;
  associationId: string;
  headers: Headers;
  ifMatch?: string;
  idempotencyKey?: string;
  requestId: string;
  emailPasswordEnabled: boolean;
  requireEmailVerification: boolean;
}): Promise<SocialIdentityUnlinkOutcome> {
  let authorized;
  try {
    authorized = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorized.kind !== 'allowed')
    return await failure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: authorized.kind,
    });
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return await failure({
      db: input.db,
      actorId: input.administratorId,
      readerId: null,
      requestId: input.requestId,
      kind: 'precondition-required',
    });
  }
  const key = input.idempotencyKey;
  const path = READER_SOCIAL_IDENTITY_UNLINK_PATH;
  const bodyHash = await hash(input.associationId);
  const now = Date.now();
  try {
    const replay = await input.db
      .prepare(
        `SELECT body_hash,response_body,response_status,retry_payload,created_at FROM admin_idempotency_record
      WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=? AND expires_at>?`,
      )
      .bind(input.administratorId, path, input.readerId, key, now)
      .first<ReplayRow>();
    if (replay !== null) {
      if (replay.body_hash !== bodyHash)
        return await failure({
          db: input.db,
          actorId: input.administratorId,
          readerId: null,
          requestId: input.requestId,
          kind: 'idempotency-key-reused',
        });
      const value = AdminReaderSocialIdentityUnlinkSchema.safeParse(
        JSON.parse(replay.response_body),
      );
      if (
        replay.response_status === 102 &&
        (replay.created_at ?? now) > now - NOTICE_CLAIM_LEASE_MS
      ) {
        return { kind: 'delivery-scheduling-failed' };
      }
      return value.success
        ? {
            kind: 'success',
            value: value.data,
            ...(replay.retry_payload === null || replay.response_status === 103
              ? {}
              : { retryPayload: replay.retry_payload }),
          }
        : { kind: 'internal-error' };
    }
    const target = await input.db
      .prepare(
        `SELECT u.id, u.email, u.email_verified, ras.state AS access_state, ras.revision
      FROM user u LEFT JOIN reader_access_state ras ON ras.user_id=u.id
      WHERE u.id=? AND (u.role IS NULL OR u.role <> 'admin') LIMIT 1`,
      )
      .bind(input.readerId)
      .first<AccountState & { id: string }>();
    if (target === null)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: null,
        requestId: input.requestId,
        kind: 'reader-not-found',
      });
    const revision = target.revision ?? 1;
    const precondition = parseRevision(input.ifMatch);
    if (precondition === null)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'precondition-required',
      });
    if (precondition === -1)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'bad-request',
      });
    if (precondition !== revision)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'stale-revision',
      });
    const pending = await input.db
      .prepare(
        `SELECT 1 AS active FROM reader_deletion_request
      WHERE user_id=? AND state IN ('pending_review','approved') LIMIT 1`,
      )
      .bind(target.id)
      .first();
    if (pending !== null)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'active-deletion-request',
      });
    const social = await input.db
      .prepare(
        `SELECT id, provider_id FROM account WHERE user_id=? AND id=?
      AND provider_id IN ('google','facebook') LIMIT 1`,
      )
      .bind(target.id, input.associationId)
      .first<{ id: string; provider_id: string }>();
    const changed = social !== null;
    if (social !== null) {
      const accounts = await input.db
        .prepare(`SELECT id,provider_id,password FROM account WHERE user_id=?`)
        .bind(target.id)
        .all<{ id: string; provider_id: string; password: string | null }>();
      const usable = accounts.results.some(
        (account) =>
          account.provider_id === 'credential' &&
          account.password !== null &&
          input.emailPasswordEnabled &&
          (!input.requireEmailVerification || target.email_verified === 1),
      );
      if (!usable)
        return await failure({
          db: input.db,
          actorId: input.administratorId,
          readerId: target.id,
          requestId: input.requestId,
          kind: 'no-usable-login-method',
        });
    }
    const nextRevision = changed ? revision + 1 : revision;
    const response: AdminReaderSocialIdentityUnlink = {
      associationId: input.associationId,
      changed,
      revision: nextRevision,
    };
    const notice =
      social === null || target.email_verified !== 1
        ? undefined
        : {
            to: target.email,
            providerDisplayName:
              social.provider_id === 'google' ? ('Google' as const) : ('Facebook' as const),
          };
    const retryPayload =
      notice === undefined ? null : await input.runtime.sealSocialIdentityUnlinkNotice(notice);
    if (notice !== undefined && retryPayload === null) return { kind: 'internal-error' };
    const token = uuid();
    await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO reader_access_state(user_id,state,revision,mutation_token,updated_at)
        VALUES(?,'active',1,NULL,?) ON CONFLICT(user_id) DO NOTHING`,
        )
        .bind(target.id, now),
      input.db
        .prepare(
          `UPDATE reader_access_state SET revision=?,mutation_token=?,updated_at=?
         WHERE user_id=? AND revision=? AND state=?
         AND ((?=1 AND EXISTS (SELECT 1 FROM account WHERE id=? AND user_id=? AND provider_id IN ('google','facebook')))
           OR (?=0 AND NOT EXISTS (SELECT 1 FROM account WHERE id=? AND user_id=? AND provider_id IN ('google','facebook'))))
         AND NOT EXISTS (SELECT 1 FROM reader_deletion_request WHERE user_id=? AND state IN ('pending_review','approved'))`,
        )
        .bind(
          nextRevision,
          token,
          now,
          target.id,
          revision,
          target.access_state ?? 'active',
          changed ? 1 : 0,
          input.associationId,
          target.id,
          changed ? 1 : 0,
          input.associationId,
          target.id,
          target.id,
        ),
      input.db
        .prepare(
          `DELETE FROM account WHERE id=? AND user_id=? AND EXISTS
        (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?)`,
        )
        .bind(input.associationId, target.id, target.id, nextRevision, token),
      input.db
        .prepare(
          `DELETE FROM session WHERE user_id=? AND ?=1 AND EXISTS
        (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?)`,
        )
        .bind(target.id, changed ? 1 : 0, target.id, nextRevision, token),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
        (id,actor_id,key,method,normalized_path,target_id,body_hash,response_status,response_body,retry_payload,created_at,expires_at)
         SELECT ?,?,?, 'DELETE',?,?,?,200,?,?,?,? WHERE EXISTS
           (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=? AND state=?)
           AND NOT EXISTS (SELECT 1 FROM reader_deletion_request WHERE user_id=? AND state IN ('pending_review','approved'))
        ON CONFLICT(actor_id,method,normalized_path,target_id,key)
        DO UPDATE SET id=excluded.id,body_hash=excluded.body_hash,response_status=200,response_body=excluded.response_body,
        retry_payload=excluded.retry_payload,
        created_at=excluded.created_at,expires_at=excluded.expires_at
        WHERE admin_idempotency_record.expires_at<=excluded.created_at`,
        )
        .bind(
          uuid(),
          input.administratorId,
          key,
          path,
          target.id,
          bodyHash,
          JSON.stringify(response),
          retryPayload,
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          target.id,
          nextRevision,
          token,
          target.access_state ?? 'active',
          target.id,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
        (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
        SELECT ?,1,'social-identity-unlinked',?,'administrator',?,'reader',?,'success',?,NULL,?
        WHERE ?=1 AND EXISTS(SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=?)`,
        )
        .bind(
          uuid(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify(
            social === null
              ? {}
              : {
                  associationId: input.associationId,
                  provider: social.provider_id,
                  revision: nextRevision,
                },
          ),
          changed ? 1 : 0,
          target.id,
          nextRevision,
          token,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
        (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
         SELECT ?,1,'social-unlink-attempt',?,'administrator',?,'reader',?,'success',?,NULL,?
         WHERE EXISTS (SELECT 1 FROM reader_access_state WHERE user_id=? AND revision=? AND mutation_token=? AND state=?)
           AND NOT EXISTS (SELECT 1 FROM reader_deletion_request WHERE user_id=? AND state IN ('pending_review','approved'))`,
        )
        .bind(
          uuid(),
          now,
          input.administratorId,
          target.id,
          input.requestId,
          JSON.stringify({ changed, revision: nextRevision }),
          target.id,
          nextRevision,
          token,
          target.access_state ?? 'active',
          target.id,
        ),
    ]);
    const stored = await input.db
      .prepare(
        `SELECT body_hash,response_body,retry_payload FROM admin_idempotency_record
      WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=? AND expires_at>?`,
      )
      .bind(input.administratorId, path, target.id, key, now)
      .first<Pick<ReplayRow, 'body_hash' | 'response_body' | 'retry_payload'>>();
    if (stored === null) {
      const current = await input.db
        .prepare(
          `SELECT ras.revision,
                  EXISTS (SELECT 1 FROM reader_deletion_request AS deletion
                          WHERE deletion.user_id=ras.user_id
                            AND deletion.state IN ('pending_review','approved')) AS active_deletion
           FROM reader_access_state AS ras WHERE ras.user_id = ?`,
        )
        .bind(target.id)
        .first<{ revision: number; active_deletion: number }>();
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind:
          current?.active_deletion === 1
            ? 'active-deletion-request'
            : current !== null && current.revision !== revision
              ? 'stale-revision'
              : 'internal-error',
      });
    }
    if (stored.body_hash !== bodyHash)
      return await failure({
        db: input.db,
        actorId: input.administratorId,
        readerId: target.id,
        requestId: input.requestId,
        kind: 'idempotency-key-reused',
      });
    const result = AdminReaderSocialIdentityUnlinkSchema.safeParse(
      JSON.parse(stored.response_body),
    );
    return result.success
      ? {
          kind: 'success',
          value: result.data,
          ...(stored.retry_payload === null ? {} : { retryPayload: stored.retry_payload }),
        }
      : { kind: 'internal-error' };
  } catch {
    return { kind: 'internal-error' };
  }
}
