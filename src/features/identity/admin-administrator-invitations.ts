import type { D1Database } from '@cloudflare/workers-types';
import { hashPassword } from 'better-auth/crypto';
import { authorizeAdministrator } from './admin-authorization.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { digestVerificationToken } from './verification-token.js';
import { evaluatePasswordPolicy } from './password-policy.js';
import { PublicAdministratorInvitationInspectSchema } from './contract.js';
import type {
  AdminAdministratorInvitation,
  AdminAdministratorInvitationCreate,
  AdminAdministratorInvitationList,
  AdminAdministratorInvitationListQuery,
  PublicAdministratorInvitationAcceptRequest,
  PublicAdministratorInvitationInspect,
} from './contract.js';

const COOLDOWN_MS = 60_000;
const DISPATCH_LEASE_MS = 30_000;

export function maskInvitationEmail(email: string): string {
  const [localPart, domainPart] = email.normalize('NFC').split('@');
  const local = localPart ?? '';
  const domain = domainPart ?? '';
  const suffix = domain.split('.').at(-1) ?? '';
  return `${local.length <= 2 ? '*' : `${local.charAt(0)}***`}@${domain.length <= 4 ? '****' : `${domain.charAt(0)}***.${suffix}`}`;
}

interface InvitationRow {
  id: string;
  email: string;
  normalized_email: string;
  token_digest: string;
  state: AdminAdministratorInvitation['state'];
  revision: number;
  expires_at: number;
  cooldown_until: number;
  sealed_payload: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  accepted_at: number | null;
}
const toInvitation = (row: InvitationRow): AdminAdministratorInvitation => ({
  id: row.id,
  email: row.email,
  state: row.state,
  expiresAt: new Date(row.expires_at).toISOString(),
  revision: row.revision,
  createdAt: new Date(row.created_at).toISOString(),
});
async function bodyHash(body: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('');
}
async function dispatchMarker(actorId: string, idempotencyKey: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${actorId}\u0000${idempotencyKey}`),
  );
  return `dispatched:${Array.from(new Uint8Array(digest), (part) => part.toString(16).padStart(2, '0')).join('')}`;
}
const claimMarker = () => `dispatching:${crypto.randomUUID()}`;
const retryableMarker = (claim: string) => `retryable:${claim.slice('dispatching:'.length)}`;
async function readReplay<T>(input: {
  db: D1Database;
  actorId: string;
  key: string | undefined;
  method: string;
  path: string;
  target: string;
  hash: string;
}): Promise<InvitationOutcome<T> | null> {
  if (!input.key) return { kind: 'precondition-required' };
  if (input.key.length > 128) return { kind: 'precondition-required' };
  const row = await input.db
    .prepare(
      'SELECT body_hash,response_status,response_body FROM admin_idempotency_record WHERE actor_id=? AND method=? AND normalized_path=? AND target_id=? AND key=? AND expires_at>?',
    )
    .bind(input.actorId, input.method, input.path, input.target, input.key, Date.now())
    .first<{ body_hash: string; response_status: number; response_body: string }>();
  if (row === null) return null;
  if (row.body_hash !== input.hash) return { kind: 'idempotency-key-reused' };
  try {
    const value = JSON.parse(row.response_body) as T;
    return { kind: 'success', status: row.response_status, value };
  } catch {
    return { kind: 'internal-error' };
  }
}
const token = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
};
async function findById(db: D1Database, id: string): Promise<InvitationRow | null> {
  return db
    .prepare('SELECT * FROM administrator_invitation WHERE id=?')
    .bind(id)
    .first<InvitationRow>();
}
async function materializeExpiry(
  db: D1Database,
  row: InvitationRow,
  now: number,
): Promise<InvitationRow> {
  if (row.state !== 'pending' || row.expires_at > now) return row;
  const transition = `expired:${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        "UPDATE administrator_invitation SET state='expired', revision=revision+1, updated_at=?, sealed_payload=NULL, claim_token=?,claim_expires_at=NULL WHERE id=? AND state='pending' AND expires_at<=?",
      )
      .bind(now, transition, row.id, now),
    db
      .prepare(
        "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) SELECT ?,1,'administrator-invitation-expired',?,'administrator',?,'administrator',?,'success',?,NULL,'{}' WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='expired' AND claim_token=?)",
      )
      .bind(
        crypto.randomUUID(),
        now,
        row.created_by,
        row.id,
        crypto.randomUUID(),
        row.id,
        transition,
      ),
  ]);
  return (await findById(db, row.id)) ?? row;
}
async function materializeElapsedInvitations(db: D1Database, now: number): Promise<void> {
  const expired = await db
    .prepare(
      "SELECT * FROM administrator_invitation WHERE state='pending' AND expires_at<=? ORDER BY id",
    )
    .bind(now)
    .all<InvitationRow>();
  for (const row of expired.results) await materializeExpiry(db, row, now);
}
async function authorized(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  actorId: string;
  headers: Headers;
}) {
  return authorizeAdministrator({
    auth: input.runtime.administration(),
    db: input.db,
    administratorId: input.actorId,
    headers: input.headers,
  });
}

async function recordPublicInvitationAttempt(input: {
  db: D1Database;
  requestId: string;
  problemCode: 'verification-invalid' | 'email-conflict';
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO identity_event
       (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
       VALUES (?,1,'administrator-invitation-attempt',?,'anonymous','anonymous',NULL,NULL,'failure',?,?,NULL)`,
    )
    .bind(crypto.randomUUID(), Date.now(), input.requestId, input.problemCode)
    .run();
}

type InvitationCommand = 'create' | 'resend' | 'cancel';
type InvitationFailureCode =
  | 'email-conflict'
  | 'precondition-required'
  | 'idempotency-key-reused'
  | 'invitation-not-found'
  | 'invalid-transition'
  | 'cooldown-active'
  | 'stale-revision'
  | 'delivery-scheduling-failed';

async function recordInvitationCommandFailure(input: {
  db: D1Database;
  actorId: string;
  requestId?: string;
  operation: InvitationCommand;
  problemCode: InvitationFailureCode;
  retryAfterSeconds?: number;
  revision?: number;
}): Promise<boolean> {
  try {
    const metadata: {
      operation: InvitationCommand;
      retryAfterSeconds?: number;
      revision?: number;
    } = {
      operation: input.operation,
      ...(input.retryAfterSeconds === undefined
        ? {}
        : { retryAfterSeconds: input.retryAfterSeconds }),
      ...(input.revision === undefined ? {} : { revision: input.revision }),
    };
    await input.db
      .prepare(
        "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) VALUES (?,1,'administrator-invitation-command-attempt',?,'administrator',?,NULL,NULL,'failure',?,?,?)",
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.actorId,
        input.requestId ?? crypto.randomUUID(),
        input.problemCode,
        JSON.stringify(metadata),
      )
      .run();
    return true;
  } catch {
    return false;
  }
}
export type InvitationOutcome<T> =
  | { kind: 'success'; value: T; status?: number; etag?: string }
  | {
      kind:
        | 'forbidden'
        | 'administrator-disabled'
        | 'administrator-not-found'
        | 'conflict'
        | 'not-found'
        | 'precondition-required'
        | 'stale-revision'
        | 'cooldown-active'
        | 'delivery-scheduling-failed'
        | 'invalid-invitation'
        | 'password-policy-violation'
        | 'password-confirmation-mismatch'
        | 'email-password-disabled'
        | 'email-conflict'
        | 'idempotency-key-reused'
        | 'internal-error';
      retryAfter?: number;
    };

export async function listAdministratorInvitations(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  actorId: string;
  headers: Headers;
  query: AdminAdministratorInvitationListQuery;
}): Promise<InvitationOutcome<AdminAdministratorInvitationList>> {
  try {
    const auth = await authorized(input);
    if (auth.kind !== 'allowed') return auth;
    const now = Date.now();
    await materializeElapsedInvitations(input.db, now);
    const where = input.query.state === undefined ? '' : 'WHERE state=?';
    const rows = await input.db
      .prepare(
        `SELECT * FROM administrator_invitation ${where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`,
      )
      .bind(
        ...(input.query.state === undefined
          ? [input.query.limit, input.query.offset]
          : [input.query.state, input.query.limit, input.query.offset]),
      )
      .all<InvitationRow>();
    const count = await input.db
      .prepare(`SELECT count(*) AS total FROM administrator_invitation ${where}`)
      .bind(...(input.query.state === undefined ? [] : [input.query.state]))
      .first<{ total: number }>();
    return {
      kind: 'success',
      value: { items: rows.results.map(toInvitation), total: count?.total ?? 0 },
    };
  } catch {
    return { kind: 'internal-error' };
  }
}

export async function createAdministratorInvitation(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  actorId: string;
  headers: Headers;
  body: AdminAdministratorInvitationCreate;
  idempotencyKey?: string;
  requestId?: string;
  schedule?: (payload: string) => Promise<'accepted' | 'rejected' | 'invalid-envelope'>;
}): Promise<InvitationOutcome<AdminAdministratorInvitation>> {
  try {
    const auth = await authorized(input);
    if (auth.kind !== 'allowed') return auth;
    if (!input.idempotencyKey) {
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'create',
        problemCode: 'precondition-required',
      }))
        ? { kind: 'precondition-required' }
        : { kind: 'internal-error' };
    }
    const hash = await bodyHash(input.body);
    const key = input.idempotencyKey;
    const path = '/v1/admin/administrator-invitations';
    const prior = await input.db
      .prepare(
        'SELECT body_hash,response_status,response_body,retry_payload FROM admin_idempotency_record WHERE actor_id=? AND method=? AND normalized_path=? AND target_id=? AND key=? AND expires_at>?',
      )
      .bind(input.actorId, 'POST', path, 'collection', key, Date.now())
      .first<{
        body_hash: string;
        response_status: number;
        response_body: string;
        retry_payload: string | null;
      }>();
    if (prior !== null) {
      if (prior.body_hash !== hash) {
        return (await recordInvitationCommandFailure({
          db: input.db,
          actorId: input.actorId,
          requestId: input.requestId,
          operation: 'create',
          problemCode: 'idempotency-key-reused',
        }))
          ? { kind: 'idempotency-key-reused' }
          : { kind: 'internal-error' };
      }
      if (prior.response_status === 201) {
        return {
          kind: 'success',
          status: 201,
          value: JSON.parse(prior.response_body) as AdminAdministratorInvitation,
        };
      }
      const value = JSON.parse(prior.response_body) as AdminAdministratorInvitation;
      if (prior.retry_payload === null) return { kind: 'delivery-scheduling-failed' };
      const claim = claimMarker();
      const now = Date.now();
      const claimed = await input.db.batch([
        input.db
          .prepare(
            "UPDATE administrator_invitation SET claim_token=?,claim_expires_at=? WHERE id=? AND state='pending' AND sealed_payload IS NOT NULL AND ((claim_token LIKE 'retryable:%') OR (claim_token LIKE 'dispatching:%' AND claim_expires_at<=?))",
          )
          .bind(claim, now + DISPATCH_LEASE_MS, value.id, now),
        input.db
          .prepare(
            "UPDATE admin_idempotency_record SET response_status=102 WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id='collection' AND key=? AND body_hash=? AND response_status IN (102,503) AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NOT NULL)",
          )
          .bind(input.actorId, path, key, hash, value.id, claim),
      ]);
      if (claimed[0]?.meta.changes !== 1 || claimed[1]?.meta.changes !== 1)
        return { kind: 'delivery-scheduling-failed' };
      return await finishCreateDispatch(input, {
        key,
        hash,
        path,
        claim,
        payload: prior.retry_payload,
        value,
      });
    }
    const now = Date.now(),
      normalized = input.body.email.trim().toLowerCase(),
      email = normalized;
    const ttl = input.runtime.administratorInvitationTtlSeconds;
    await materializeElapsedInvitations(input.db, now);
    const conflict = await input.db
      .prepare(
        "SELECT id FROM administrator_invitation WHERE normalized_email=? AND state='pending' AND expires_at>? UNION ALL SELECT id FROM admin_user WHERE lower(email)=? LIMIT 1",
      )
      .bind(normalized, now, normalized)
      .first();
    if (conflict !== null) {
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'create',
        problemCode: 'email-conflict',
      }))
        ? { kind: 'conflict' }
        : { kind: 'internal-error' };
    }
    const id = crypto.randomUUID(),
      inviteToken = token(),
      digest = await digestVerificationToken(inviteToken),
      claim = claimMarker();
    const expiry = now + ttl * 1000;
    const payload = await input.runtime.sealAdministratorInvitationMessage({
      to: email,
      token: inviteToken,
    });
    if (payload === null) return { kind: 'internal-error' };
    const value = {
      id,
      email,
      state: 'pending' as const,
      expiresAt: new Date(expiry).toISOString(),
      revision: 1,
      createdAt: new Date(now).toISOString(),
    };
    await input.db
      .prepare(
        "DELETE FROM admin_idempotency_record WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id='collection' AND key=? AND expires_at<=?",
      )
      .bind(input.actorId, path, key, now)
      .run();
    await input.db.batch([
      input.db
        .prepare(
          "INSERT INTO administrator_invitation (id,email,normalized_email,token_digest,state,revision,expires_at,cooldown_until,sealed_payload,claim_token,claim_expires_at,created_by,created_at,updated_at) VALUES (?,?,?,?,'pending',1,?,?,?,?,?,?,?,?)",
        )
        .bind(
          id,
          email,
          normalized,
          digest,
          expiry,
          now,
          payload,
          claim,
          now + DISPATCH_LEASE_MS,
          input.actorId,
          now,
          now,
        ),
      input.db
        .prepare(
          "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) VALUES (?,1,'administrator-invitation-created',?,'administrator',?,'administrator',?,'success',?,NULL,'{}')",
        )
        .bind(crypto.randomUUID(), now, input.actorId, id, input.requestId ?? crypto.randomUUID()),
      input.db
        .prepare(
          "INSERT INTO admin_idempotency_record (id,actor_id,key,method,normalized_path,target_id,body_hash,response_status,response_body,retry_payload,created_at,expires_at) VALUES (?,?,?,'POST',?,'collection',?,102,?,?,?,?)",
        )
        .bind(
          crypto.randomUUID(),
          input.actorId,
          key,
          path,
          hash,
          JSON.stringify(value),
          payload,
          now,
          now + 86_400_000,
        ),
    ]);
    return await finishCreateDispatch(input, { key, hash, path, claim, payload, value });
  } catch {
    try {
      if (input.idempotencyKey !== undefined) {
        const key = input.idempotencyKey;
        const path = '/v1/admin/administrator-invitations';
        const prior = await input.db
          .prepare(
            "SELECT body_hash,response_status,response_body FROM admin_idempotency_record WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id='collection' AND key=? AND expires_at>?",
          )
          .bind(input.actorId, path, key, Date.now())
          .first<{ body_hash: string; response_status: number; response_body: string }>();
        if (prior !== null) {
          const hash = await bodyHash(input.body);
          if (prior.body_hash !== hash) return { kind: 'idempotency-key-reused' };
          if (prior.response_status === 201)
            return {
              kind: 'success',
              status: 201,
              value: JSON.parse(prior.response_body) as AdminAdministratorInvitation,
            };
          return { kind: 'delivery-scheduling-failed' };
        }
      }
      const normalized = input.body.email.trim().toLowerCase();
      const existing = await input.db
        .prepare(
          "SELECT id FROM administrator_invitation WHERE normalized_email=? AND state='pending' UNION ALL SELECT id FROM admin_user WHERE lower(email)=? LIMIT 1",
        )
        .bind(normalized, normalized)
        .first();
      if (existing !== null) {
        return (await recordInvitationCommandFailure({
          db: input.db,
          actorId: input.actorId,
          requestId: input.requestId,
          operation: 'create',
          problemCode: 'email-conflict',
        }))
          ? { kind: 'conflict' }
          : { kind: 'internal-error' };
      }
    } catch {
      // Keep database errors redacted; only a verified reservation is a conflict.
    }
    return { kind: 'internal-error' };
  }
}

async function finishCreateDispatch(
  input: Parameters<typeof createAdministratorInvitation>[0],
  dispatch: {
    key: string;
    hash: string;
    path: string;
    claim: string;
    payload: string;
    value: AdminAdministratorInvitation;
  },
): Promise<InvitationOutcome<AdminAdministratorInvitation>> {
  let scheduled: 'accepted' | 'rejected' | 'invalid-envelope';
  try {
    scheduled = await (input.schedule === undefined
      ? input.runtime.retryAdministratorMessageScheduling(dispatch.payload)
      : input.schedule(dispatch.payload));
  } catch {
    scheduled = 'rejected';
  }
  if (scheduled !== 'accepted') {
    try {
      const rejected = await input.db.batch([
        input.db
          .prepare(
            'UPDATE administrator_invitation SET claim_token=?,claim_expires_at=NULL WHERE id=? AND claim_token=?',
          )
          .bind(retryableMarker(dispatch.claim), dispatch.value.id, dispatch.claim),
        input.db
          .prepare(
            "UPDATE admin_idempotency_record SET response_status=503,retry_payload=? WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id='collection' AND key=? AND body_hash=? AND response_status=102 AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NOT NULL)",
          )
          .bind(
            dispatch.payload,
            input.actorId,
            dispatch.path,
            dispatch.key,
            dispatch.hash,
            dispatch.value.id,
            retryableMarker(dispatch.claim),
          ),
      ]);
      if (rejected[0]?.meta.changes !== 1 || rejected[1]?.meta.changes !== 1)
        return { kind: 'internal-error' };
    } catch {
      return { kind: 'internal-error' };
    }
    if (
      !(await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'create',
        problemCode: 'delivery-scheduling-failed',
      }))
    )
      return { kind: 'internal-error' };
    return { kind: 'delivery-scheduling-failed' };
  }
  const accepted = await dispatchMarker(input.actorId, dispatch.key);
  try {
    const result = await input.db.batch([
      input.db
        .prepare(
          'UPDATE administrator_invitation SET sealed_payload=NULL,claim_token=?,claim_expires_at=NULL WHERE id=? AND claim_token=?',
        )
        .bind(accepted, dispatch.value.id, dispatch.claim),
      input.db
        .prepare(
          "UPDATE admin_idempotency_record SET response_status=201,response_body=?,retry_payload=NULL WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id='collection' AND key=? AND body_hash=? AND response_status=102 AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NULL)",
        )
        .bind(
          JSON.stringify(dispatch.value),
          input.actorId,
          dispatch.path,
          dispatch.key,
          dispatch.hash,
          dispatch.value.id,
          accepted,
        ),
    ]);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'create',
        problemCode: 'delivery-scheduling-failed',
      }))
        ? { kind: 'delivery-scheduling-failed' }
        : { kind: 'internal-error' };
  } catch {
    // Scheduler acceptance is not durable until the no-redispatch marker commits.
    return (await recordInvitationCommandFailure({
      db: input.db,
      actorId: input.actorId,
      requestId: input.requestId,
      operation: 'create',
      problemCode: 'delivery-scheduling-failed',
    }))
      ? { kind: 'delivery-scheduling-failed' }
      : { kind: 'internal-error' };
  }
  return { kind: 'success', status: 201, value: dispatch.value };
}

export async function resendAdministratorInvitation(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  actorId: string;
  headers: Headers;
  id: string;
  idempotencyKey?: string;
  requestId?: string;
  schedule?: (payload: string) => Promise<'accepted' | 'rejected' | 'invalid-envelope'>;
}): Promise<InvitationOutcome<{ id: string; state: 'scheduled'; cooldownUntil: string }>> {
  try {
    const auth = await authorized(input);
    if (auth.kind !== 'allowed') return auth;
    if (!input.idempotencyKey) {
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'precondition-required',
      }))
        ? { kind: 'precondition-required' }
        : { kind: 'internal-error' };
    }
    const hash = await bodyHash({});
    const key = input.idempotencyKey;
    const path = '/v1/admin/administrator-invitations/{invitationId}/messages';
    const replay = await input.db
      .prepare(
        'SELECT body_hash,response_status,response_body,retry_payload FROM admin_idempotency_record WHERE actor_id=? AND method=? AND normalized_path=? AND target_id=? AND key=? AND expires_at>?',
      )
      .bind(
        input.actorId,
        'POST',
        '/v1/admin/administrator-invitations/{invitationId}/messages',
        input.id,
        input.idempotencyKey,
        Date.now(),
      )
      .first<{
        body_hash: string;
        response_status: number;
        response_body: string;
        retry_payload: string | null;
      }>();
    if (replay !== null) {
      if (replay.body_hash !== hash) {
        return (await recordInvitationCommandFailure({
          db: input.db,
          actorId: input.actorId,
          requestId: input.requestId,
          operation: 'resend',
          problemCode: 'idempotency-key-reused',
        }))
          ? { kind: 'idempotency-key-reused' }
          : { kind: 'internal-error' };
      }
      if (replay.response_status === 202)
        return {
          kind: 'success',
          status: 202,
          value: JSON.parse(replay.response_body) as {
            id: string;
            state: 'scheduled';
            cooldownUntil: string;
          },
        };
      if (
        (replay.response_status === 503 || replay.response_status === 102) &&
        replay.retry_payload !== null
      ) {
        const retained = await input.db
          .prepare(
            'SELECT sealed_payload,claim_token,claim_expires_at,cooldown_until FROM administrator_invitation WHERE id=?',
          )
          .bind(input.id)
          .first<{
            sealed_payload: string | null;
            claim_token: string | null;
            claim_expires_at: number | null;
            cooldown_until: number;
          }>();
        if (retained?.sealed_payload === null || retained?.sealed_payload === undefined)
          return { kind: 'internal-error' };
        const now = Date.now();
        if (
          retained.claim_token?.startsWith('dispatching:') &&
          (retained.claim_expires_at ?? Infinity) > now
        ) {
          return (await recordInvitationCommandFailure({
            db: input.db,
            actorId: input.actorId,
            requestId: input.requestId,
            operation: 'resend',
            problemCode: 'delivery-scheduling-failed',
          }))
            ? { kind: 'delivery-scheduling-failed' }
            : { kind: 'internal-error' };
        }
        const claim = claimMarker();
        const claimed = await input.db.batch([
          input.db
            .prepare(
              "UPDATE administrator_invitation SET claim_token=?,claim_expires_at=? WHERE id=? AND state='pending' AND sealed_payload IS NOT NULL AND claim_token=? AND (claim_expires_at IS NULL OR claim_expires_at<=?)",
            )
            .bind(claim, now + DISPATCH_LEASE_MS, input.id, retained.claim_token, now),
          input.db
            .prepare(
              "UPDATE admin_idempotency_record SET response_status=102 WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id=? AND key=? AND body_hash=? AND response_status IN (102,503) AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NOT NULL)",
            )
            .bind(input.actorId, path, input.id, key, hash, input.id, claim),
        ]);
        if (claimed[0]?.meta.changes !== 1 || claimed[1]?.meta.changes !== 1) {
          return (await recordInvitationCommandFailure({
            db: input.db,
            actorId: input.actorId,
            requestId: input.requestId,
            operation: 'resend',
            problemCode: 'delivery-scheduling-failed',
          }))
            ? { kind: 'delivery-scheduling-failed' }
            : { kind: 'internal-error' };
        }
        const value = JSON.parse(replay.response_body) as {
          id: string;
          state: 'scheduled';
          cooldownUntil: string;
        };
        return await finishResendDispatch(input, {
          key,
          hash,
          path,
          claim,
          payload: retained.sealed_payload,
          value,
        });
      }
      return { kind: 'internal-error' };
    }
    let row = await findById(input.db, input.id);
    if (row === null)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'invitation-not-found',
      }))
        ? { kind: 'not-found' }
        : { kind: 'internal-error' };
    const now = Date.now();
    row = await materializeExpiry(input.db, row, now);
    if (row.state !== 'pending')
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'invalid-transition',
        revision: row.revision,
      }))
        ? { kind: 'conflict' }
        : { kind: 'internal-error' };
    if (row.claim_token?.startsWith('dispatching:') && (row.claim_expires_at ?? Infinity) > now) {
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'delivery-scheduling-failed',
      }))
        ? { kind: 'delivery-scheduling-failed' }
        : { kind: 'internal-error' };
    }
    if (row.cooldown_until > now) {
      const retryAfter = Math.ceil((row.cooldown_until - now) / 1000);
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'cooldown-active',
        retryAfterSeconds: retryAfter,
        revision: row.revision,
      }))
        ? { kind: 'cooldown-active', retryAfter }
        : { kind: 'internal-error' };
    }
    const nextToken = token(),
      digest = await digestVerificationToken(nextToken),
      claim = claimMarker(),
      cooldown = now + COOLDOWN_MS,
      expiry = now + input.runtime.administratorInvitationTtlSeconds * 1_000;
    const payload = await input.runtime.sealAdministratorInvitationMessage({
      to: row.email,
      token: nextToken,
    });
    if (payload === null) return { kind: 'internal-error' };
    await input.db
      .prepare(
        "DELETE FROM admin_idempotency_record WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id=? AND key=? AND expires_at<=?",
      )
      .bind(input.actorId, path, input.id, key, now)
      .run();
    const changed = await input.db.batch([
      input.db
        .prepare(
          "UPDATE administrator_invitation SET token_digest=?,revision=revision+1,expires_at=?,cooldown_until=?,sealed_payload=?,claim_token=?,claim_expires_at=?,updated_at=? WHERE id=? AND state='pending' AND revision=? AND cooldown_until<=?",
        )
        .bind(
          digest,
          expiry,
          cooldown,
          payload,
          claim,
          now + DISPATCH_LEASE_MS,
          now,
          row.id,
          row.revision,
          now,
        ),
      input.db
        .prepare(
          "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) SELECT ?,1,'administrator-invitation-resent',?,'administrator',?,'administrator',?,'success',?,NULL,'{}' WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND token_digest=?)",
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.actorId,
          row.id,
          input.requestId ?? crypto.randomUUID(),
          row.id,
          claim,
          digest,
        ),
      input.db
        .prepare(
          "INSERT INTO admin_idempotency_record (id,actor_id,key,method,normalized_path,target_id,body_hash,response_status,response_body,retry_payload,created_at,expires_at) SELECT ?,?,?,'POST',?,?,?,102,?,?,?,? WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND token_digest=?)",
        )
        .bind(
          crypto.randomUUID(),
          input.actorId,
          key,
          path,
          input.id,
          hash,
          JSON.stringify({
            id: row.id,
            state: 'scheduled',
            cooldownUntil: new Date(cooldown).toISOString(),
          }),
          payload,
          now,
          now + 86_400_000,
          row.id,
          claim,
          digest,
        ),
    ]);
    if (
      changed[0]?.meta.changes !== 1 ||
      changed[1]?.meta.changes !== 1 ||
      changed[2]?.meta.changes !== 1
    ) {
      const raced = await input.db
        .prepare(
          "SELECT body_hash,response_status,response_body FROM admin_idempotency_record WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id=? AND key=? AND expires_at>?",
        )
        .bind(input.actorId, path, input.id, key, Date.now())
        .first<{ body_hash: string; response_status: number; response_body: string }>();
      if (raced !== null) {
        if (raced.body_hash !== hash)
          return (await recordInvitationCommandFailure({
            db: input.db,
            actorId: input.actorId,
            requestId: input.requestId,
            operation: 'resend',
            problemCode: 'idempotency-key-reused',
          }))
            ? { kind: 'idempotency-key-reused' }
            : { kind: 'internal-error' };
        if (raced.response_status === 202)
          return {
            kind: 'success',
            status: 202,
            value: JSON.parse(raced.response_body) as {
              id: string;
              state: 'scheduled';
              cooldownUntil: string;
            },
          };
      }
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'invalid-transition',
        revision: row.revision,
      }))
        ? { kind: 'conflict' }
        : { kind: 'internal-error' };
    }
    const value = {
      id: row.id,
      state: 'scheduled' as const,
      cooldownUntil: new Date(cooldown).toISOString(),
    };
    return await finishResendDispatch(input, { key, hash, path, claim, payload, value });
  } catch {
    if (input.idempotencyKey !== undefined) {
      try {
        const replay = await input.db
          .prepare(
            "SELECT body_hash,response_status,response_body FROM admin_idempotency_record WHERE actor_id=? AND method='POST' AND normalized_path='/v1/admin/administrator-invitations/{invitationId}/messages' AND target_id=? AND key=? AND expires_at>?",
          )
          .bind(input.actorId, input.id, input.idempotencyKey, Date.now())
          .first<{ body_hash: string; response_status: number; response_body: string }>();
        if (replay !== null) {
          if (replay.body_hash !== (await bodyHash({}))) return { kind: 'idempotency-key-reused' };
          if (replay.response_status === 202)
            return {
              kind: 'success',
              status: 202,
              value: JSON.parse(replay.response_body) as {
                id: string;
                state: 'scheduled';
                cooldownUntil: string;
              },
            };
          return { kind: 'delivery-scheduling-failed' };
        }
      } catch {
        return { kind: 'internal-error' };
      }
    }
    return { kind: 'internal-error' };
  }
}

async function finishResendDispatch(
  input: Parameters<typeof resendAdministratorInvitation>[0],
  dispatch: {
    key: string;
    hash: string;
    path: string;
    claim: string;
    payload: string;
    value: { id: string; state: 'scheduled'; cooldownUntil: string };
  },
): Promise<InvitationOutcome<{ id: string; state: 'scheduled'; cooldownUntil: string }>> {
  let scheduled: 'accepted' | 'rejected' | 'invalid-envelope';
  try {
    scheduled = await (input.schedule === undefined
      ? input.runtime.retryAdministratorMessageScheduling(dispatch.payload)
      : input.schedule(dispatch.payload));
  } catch {
    scheduled = 'rejected';
  }
  const retryable = retryableMarker(dispatch.claim);
  if (scheduled !== 'accepted') {
    const result = await input.db.batch([
      input.db
        .prepare(
          'UPDATE administrator_invitation SET claim_token=?,claim_expires_at=NULL WHERE id=? AND claim_token=?',
        )
        .bind(retryable, dispatch.value.id, dispatch.claim),
      input.db
        .prepare(
          "UPDATE admin_idempotency_record SET response_status=503,retry_payload=? WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id=? AND key=? AND body_hash=? AND response_status=102 AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NOT NULL)",
        )
        .bind(
          dispatch.payload,
          input.actorId,
          dispatch.path,
          dispatch.value.id,
          dispatch.key,
          dispatch.hash,
          dispatch.value.id,
          retryable,
        ),
    ]);
    return result[0]?.meta.changes === 1 && result[1]?.meta.changes === 1
      ? { kind: 'delivery-scheduling-failed' }
      : { kind: 'internal-error' };
  }
  const marker = await dispatchMarker(input.actorId, dispatch.key);
  try {
    const result = await input.db.batch([
      input.db
        .prepare(
          'UPDATE administrator_invitation SET sealed_payload=NULL,claim_token=?,claim_expires_at=NULL WHERE id=? AND claim_token=?',
        )
        .bind(marker, dispatch.value.id, dispatch.claim),
      input.db
        .prepare(
          "UPDATE admin_idempotency_record SET response_status=202,response_body=?,retry_payload=NULL WHERE actor_id=? AND method='POST' AND normalized_path=? AND target_id=? AND key=? AND body_hash=? AND response_status=102 AND EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND claim_token=? AND sealed_payload IS NULL)",
        )
        .bind(
          JSON.stringify(dispatch.value),
          input.actorId,
          dispatch.path,
          dispatch.value.id,
          dispatch.key,
          dispatch.hash,
          dispatch.value.id,
          marker,
        ),
    ]);
    if (result[0]?.meta.changes !== 1 || result[1]?.meta.changes !== 1)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'resend',
        problemCode: 'delivery-scheduling-failed',
      }))
        ? { kind: 'delivery-scheduling-failed' }
        : { kind: 'internal-error' };
  } catch {
    return (await recordInvitationCommandFailure({
      db: input.db,
      actorId: input.actorId,
      requestId: input.requestId,
      operation: 'resend',
      problemCode: 'delivery-scheduling-failed',
    }))
      ? { kind: 'delivery-scheduling-failed' }
      : { kind: 'internal-error' };
  }
  return { kind: 'success', status: 202, value: dispatch.value };
}

export async function cancelAdministratorInvitation(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  actorId: string;
  headers: Headers;
  id: string;
  ifMatch?: string;
  idempotencyKey?: string;
  requestId?: string;
}): Promise<InvitationOutcome<AdminAdministratorInvitation>> {
  try {
    const auth = await authorized(input);
    if (auth.kind !== 'allowed') return auth;
    if (!input.idempotencyKey)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'precondition-required',
      }))
        ? { kind: 'precondition-required' }
        : { kind: 'internal-error' };
    const hash = await bodyHash({});
    const replay = await readReplay<AdminAdministratorInvitation>({
      db: input.db,
      actorId: input.actorId,
      key: input.idempotencyKey,
      method: 'DELETE',
      path: '/v1/admin/administrator-invitations/{invitationId}',
      target: input.id,
      hash,
    });
    if (replay !== null) {
      if (replay.kind === 'idempotency-key-reused') {
        return (await recordInvitationCommandFailure({
          db: input.db,
          actorId: input.actorId,
          requestId: input.requestId,
          operation: 'cancel',
          problemCode: 'idempotency-key-reused',
        }))
          ? replay
          : { kind: 'internal-error' };
      }
      return replay;
    }
    let row = await findById(input.db, input.id);
    if (row === null)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'invitation-not-found',
      }))
        ? { kind: 'not-found' }
        : { kind: 'internal-error' };
    row = await materializeExpiry(input.db, row, Date.now());
    if (!input.ifMatch)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'precondition-required',
      }))
        ? { kind: 'precondition-required' }
        : { kind: 'internal-error' };
    if (input.ifMatch !== `"${String(row.revision)}"`)
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'stale-revision',
        revision: row.revision,
      }))
        ? { kind: 'stale-revision' }
        : { kind: 'internal-error' };
    if (row.state !== 'pending')
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'invalid-transition',
        revision: row.revision,
      }))
        ? { kind: 'conflict' }
        : { kind: 'internal-error' };
    const now = Date.now();
    const transition = `cancelled:${crypto.randomUUID()}`;
    const resultBody = toInvitation({
      ...row,
      state: 'cancelled',
      revision: row.revision + 1,
      updated_at: now,
      claim_token: transition,
      claim_expires_at: null,
    });
    const path = '/v1/admin/administrator-invitations/{invitationId}';
    await input.db
      .prepare(
        "DELETE FROM admin_idempotency_record WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=? AND expires_at<=?",
      )
      .bind(input.actorId, path, input.id, input.idempotencyKey, now)
      .run();
    await input.db
      .prepare(
        "DELETE FROM admin_idempotency_record WHERE actor_id=? AND method='DELETE' AND normalized_path=? AND target_id=? AND key=? AND expires_at<=?",
      )
      .bind(input.actorId, path, input.id, input.idempotencyKey, now)
      .run();
    const result = await input.db.batch([
      input.db
        .prepare(
          "UPDATE administrator_invitation SET state='cancelled',revision=revision+1,updated_at=?,sealed_payload=NULL,claim_token=?,claim_expires_at=NULL WHERE id=? AND state='pending' AND revision=?",
        )
        .bind(now, transition, row.id, row.revision),
      input.db
        .prepare(
          "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) SELECT ?,1,'administrator-invitation-cancelled',?,'administrator',?,'administrator',?,'success',?,NULL,'{}' WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='cancelled' AND claim_token=?)",
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.actorId,
          row.id,
          input.requestId ?? crypto.randomUUID(),
          row.id,
          transition,
        ),
      input.db
        .prepare(
          "INSERT INTO admin_idempotency_record (id,actor_id,key,method,normalized_path,target_id,body_hash,response_status,response_body,retry_payload,created_at,expires_at) SELECT ?,?,?,'DELETE',?,?,?,200,?,NULL,?,? WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='cancelled' AND claim_token=?)",
        )
        .bind(
          crypto.randomUUID(),
          input.actorId,
          input.idempotencyKey,
          path,
          input.id,
          hash,
          JSON.stringify(resultBody),
          now,
          now + 86_400_000,
          row.id,
          transition,
        ),
    ]);
    if (
      result[0]?.meta.changes !== 1 ||
      result[1]?.meta.changes !== 1 ||
      result[2]?.meta.changes !== 1
    ) {
      const racedReplay = await readReplay<AdminAdministratorInvitation>({
        db: input.db,
        actorId: input.actorId,
        key: input.idempotencyKey,
        method: 'DELETE',
        path,
        target: input.id,
        hash,
      });
      if (racedReplay?.kind === 'success') return racedReplay;
      return (await recordInvitationCommandFailure({
        db: input.db,
        actorId: input.actorId,
        requestId: input.requestId,
        operation: 'cancel',
        problemCode: 'stale-revision',
        revision: row.revision,
      }))
        ? { kind: 'stale-revision' }
        : { kind: 'internal-error' };
    }
    const updated = await findById(input.db, row.id);
    return updated === null
      ? { kind: 'internal-error' }
      : {
          kind: 'success',
          status: 200,
          etag: `"${String(updated.revision)}"`,
          value: toInvitation(updated),
        };
  } catch {
    if (input.idempotencyKey !== undefined) {
      try {
        const replay = await readReplay<AdminAdministratorInvitation>({
          db: input.db,
          actorId: input.actorId,
          key: input.idempotencyKey,
          method: 'DELETE',
          path: '/v1/admin/administrator-invitations/{invitationId}',
          target: input.id,
          hash: await bodyHash({}),
        });
        if (replay !== null) return replay;
      } catch {
        return { kind: 'internal-error' };
      }
    }
    return { kind: 'internal-error' };
  }
}

export async function inspectAdministratorInvitation(input: {
  db: D1Database;
  token: string;
  requestId?: string;
}): Promise<InvitationOutcome<PublicAdministratorInvitationInspect>> {
  try {
    const digest = await digestVerificationToken(input.token);
    let row = await input.db
      .prepare('SELECT * FROM administrator_invitation WHERE token_digest=?')
      .bind(digest)
      .first<InvitationRow>();
    if (row === null) {
      await recordPublicInvitationAttempt({
        db: input.db,
        requestId: input.requestId ?? crypto.randomUUID(),
        problemCode: 'verification-invalid',
      });
      return { kind: 'invalid-invitation' };
    }
    row = await materializeExpiry(input.db, row, Date.now());
    const masked = maskInvitationEmail(row.email);
    const projection = PublicAdministratorInvitationInspectSchema.safeParse({
      email: masked,
      state: row.state,
      expiresAt: new Date(row.expires_at).toISOString(),
    });
    if (!projection.success) return { kind: 'invalid-invitation' };
    return {
      kind: 'success',
      value: projection.data,
    };
  } catch {
    return { kind: 'invalid-invitation' };
  }
}

export async function acceptAdministratorInvitation(input: {
  db: D1Database;
  runtime: IdentityRuntime;
  body: PublicAdministratorInvitationAcceptRequest;
  requestId?: string;
  beforeCommit?: () => Promise<void>;
}): Promise<InvitationOutcome<{ accepted: true }>> {
  try {
    if (!input.runtime.authPolicy.emailPasswordEnabled) return { kind: 'email-password-disabled' };
    const policy = input.runtime.authPolicy.passwordPolicy;
    if (input.body.password !== input.body.passwordConfirmation)
      return { kind: 'password-confirmation-mismatch' };
    if (!evaluatePasswordPolicy(input.body.password, policy).valid)
      return { kind: 'password-policy-violation' };
    const digest = await digestVerificationToken(input.body.token);
    let row = await input.db
      .prepare('SELECT * FROM administrator_invitation WHERE token_digest=? LIMIT 1')
      .bind(digest)
      .first<InvitationRow>();
    if (row === null) {
      await recordPublicInvitationAttempt({
        db: input.db,
        requestId: input.requestId ?? crypto.randomUUID(),
        problemCode: 'verification-invalid',
      });
      return { kind: 'invalid-invitation' };
    }
    row = await materializeExpiry(input.db, row, Date.now());
    if (row.state !== 'pending' || row.expires_at <= Date.now()) {
      await recordPublicInvitationAttempt({
        db: input.db,
        requestId: input.requestId ?? crypto.randomUUID(),
        problemCode: 'verification-invalid',
      });
      return { kind: 'invalid-invitation' };
    }
    const exists = await input.db
      .prepare('SELECT id FROM admin_user WHERE lower(email)=?')
      .bind(row.normalized_email)
      .first();
    if (exists !== null) {
      await recordPublicInvitationAttempt({
        db: input.db,
        requestId: input.requestId ?? crypto.randomUUID(),
        problemCode: 'email-conflict',
      });
      return { kind: 'email-conflict' };
    }
    const now = Math.floor(Date.now() / 1000),
      acceptedAt = Date.now(),
      userId = crypto.randomUUID(),
      accountId = crypto.randomUUID(),
      eventId = crypto.randomUUID();
    const password = await hashPassword(input.body.password);
    await input.beforeCommit?.();
    const result = await input.db.batch([
      input.db
        .prepare(
          "INSERT INTO admin_user (id,name,email,email_verified,created_at,updated_at,role,banned) SELECT ?,?,?,1,?,?,'admin',0 WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='pending' AND token_digest=? AND expires_at>?) AND NOT EXISTS (SELECT 1 FROM admin_user WHERE lower(email)=?)",
        )
        .bind(
          userId,
          input.body.name.trim(),
          row.email,
          now,
          now,
          row.id,
          digest,
          acceptedAt,
          row.normalized_email,
        ),
      input.db
        .prepare(
          "INSERT INTO admin_account (id,account_id,provider_id,user_id,password,created_at,updated_at) SELECT ?,?,'credential',?,?,?,? WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='pending' AND token_digest=? AND expires_at>?) AND EXISTS (SELECT 1 FROM admin_user WHERE id=?)",
        )
        .bind(accountId, userId, userId, password, now, now, row.id, digest, acceptedAt, userId),
      input.db
        .prepare(
          "UPDATE administrator_invitation SET state='accepted',revision=revision+1,accepted_at=?,updated_at=?,sealed_payload=NULL,claim_token=NULL WHERE id=? AND state='pending' AND token_digest=? AND expires_at>? AND EXISTS (SELECT 1 FROM admin_user WHERE id=?) AND EXISTS (SELECT 1 FROM admin_account WHERE user_id=? AND provider_id='credential')",
        )
        .bind(acceptedAt, acceptedAt, row.id, digest, acceptedAt, userId, userId),
      input.db
        .prepare(
          "INSERT INTO identity_event (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata) SELECT ?,1,'administrator-invitation-accepted',?,'administrator',?,'administrator',?,'success',? ,NULL,'{}' WHERE EXISTS (SELECT 1 FROM administrator_invitation WHERE id=? AND state='accepted' AND accepted_at=?)",
        )
        .bind(eventId, acceptedAt, userId, userId, crypto.randomUUID(), row.id, acceptedAt),
    ]);
    if (result.some((entry) => entry.meta.changes !== 1)) return { kind: 'invalid-invitation' };
    return { kind: 'success', status: 201, value: { accepted: true } };
  } catch {
    try {
      const digest = await digestVerificationToken(input.body.token);
      const accepted = await input.db
        .prepare(
          "SELECT id FROM administrator_invitation WHERE token_digest=? AND state='accepted'",
        )
        .bind(digest)
        .first();
      if (accepted !== null) return { kind: 'invalid-invitation' };
    } catch {
      // Return the redacted internal outcome below.
    }
    return { kind: 'internal-error' };
  }
}
