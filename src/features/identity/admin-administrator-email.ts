import type { D1Database } from '@cloudflare/workers-types';
import { authorizeAdministrator } from './admin-authorization.js';
import {
  AdminAdministratorMessageSchema,
  type AdminAdministratorMessage,
  type AdminAdministratorMessageRequest,
} from './contract.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { createProblem, type ProblemCode } from '../../shared/problem.js';

const COOLDOWN_MS = 60_000;
const CLAIM_LEASE_MS = 30_000;
const IDEMPOTENCY_RETENTION_MS = 86_400_000;

export const ADMINISTRATOR_EMAIL_VERIFICATION_MESSAGE_PATH =
  '/v1/admin/administrators/:administratorId/email-verification/messages';
export const ADMINISTRATOR_PASSWORD_RECOVERY_MESSAGE_PATH =
  '/v1/admin/administrators/:administratorId/password-recovery/messages';

type AdministratorMessageKind = 'email-verification' | 'password-recovery';
// Keep realm-specific claim SQL and validation explicit here. The Reader flow
// has deletion/revision fences and different token lifecycle ownership; sharing
// the whole state machine would require callback/table-name plumbing that would
// obscure rather than centralize those invariants. Revisit with a dual-realm
// extraction plan and contract tests, not a parameterized SQL middle layer.
export type AdministratorMessageSchedulingResult = 'accepted' | 'rejected' | 'invalid-envelope';
type FailureKind =
  | 'forbidden'
  | 'administrator-disabled'
  | 'administrator-not-found'
  | 'precondition-required'
  | 'invalid-transition'
  | 'no-usable-login-method'
  | 'idempotency-key-reused'
  | 'internal-error'
  | 'delivery-scheduling-failed';

interface AdministratorTarget {
  readonly id: string;
  readonly email: string;
  readonly email_verified: number;
  readonly revision: number | null;
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

export type RequestAdministratorMessageOutcome =
  | {
      readonly kind: 'accepted';
      readonly status: 200 | 202;
      readonly value: AdminAdministratorMessage;
    }
  | { readonly kind: Exclude<FailureKind, 'cooldown-active'> }
  | { readonly kind: 'cooldown-active'; readonly retryAfterSeconds: number };

function opaqueId(): string {
  return crypto.randomUUID();
}

async function digestBody(body: AdminAdministratorMessageRequest): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(JSON.stringify(body)),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function currentRevision(target: AdministratorTarget): number {
  return target.revision ?? 1;
}

function responseValue(input: {
  readonly workflowId: string;
  readonly kind: AdministratorMessageKind;
  readonly cooldownUntil: number;
  readonly revision: number;
}): AdminAdministratorMessage {
  return {
    workflowId: input.workflowId,
    kind: input.kind,
    state: 'scheduled',
    cooldownUntil: new Date(input.cooldownUntil).toISOString(),
    revision: input.revision,
  };
}

function parseCommittedResponse(body: string): AdminAdministratorMessage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = AdminAdministratorMessageSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function failureBody(path: string): string {
  return JSON.stringify(
    createProblem({
      status: 503,
      code: 'delivery-scheduling-failed',
      title: 'Delivery scheduling failed',
      detail: 'The message was committed and can be retried with the same idempotency key.',
      instance: path,
    }),
  );
}

async function readTarget(
  db: D1Database,
  administratorId: string,
): Promise<AdministratorTarget | null> {
  const row = await db
    .prepare(
      `SELECT au.id, au.email, au.email_verified, aas.revision
       FROM admin_user AS au
       LEFT JOIN administrator_access_state AS aas ON aas.user_id = au.id
       WHERE au.id = ? AND au.role = 'admin'
       LIMIT 1`,
    )
    .bind(administratorId)
    .first<AdministratorTarget>();
  return row ?? null;
}

async function hasUsableCredential(db: D1Database, administratorId: string): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS usable FROM admin_account
       WHERE user_id = ? AND provider_id = 'credential'
         AND password IS NOT NULL AND length(password) > 0 LIMIT 1`,
    )
    .bind(administratorId)
    .first<{ readonly usable: number }>();
  return row !== null;
}

async function readWorkflow(
  db: D1Database,
  administratorId: string,
  kind: AdministratorMessageKind,
): Promise<MessageWorkflow | null> {
  const row = await db
    .prepare(
      `SELECT id, state, cooldown_until, claim_token, claimed_at, updated_at
       FROM administrator_message_workflow WHERE user_id = ? AND kind = ? LIMIT 1`,
    )
    .bind(administratorId, kind)
    .first<MessageWorkflow>();
  return row ?? null;
}

async function readIdempotency(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly path: string;
  readonly targetId: string;
  readonly key: string;
  readonly now: number;
}): Promise<IdempotencyRow | null> {
  const row = await input.db
    .prepare(
      `SELECT body_hash, response_status, response_body, retry_payload
       FROM admin_idempotency_record
       WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
         AND key = ? AND expires_at > ? LIMIT 1`,
    )
    .bind(input.actorId, input.path, input.targetId, input.key, input.now)
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
      input.subjectId === null ? null : 'administrator',
      input.subjectId,
      input.result,
      input.requestId,
      input.problemCode ?? null,
      input.metadata === undefined ? null : JSON.stringify(input.metadata),
    )
    .run();
}

async function auditedFailure(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string | null;
  readonly requestId: string;
  readonly kind: FailureKind;
  readonly messageKind: AdministratorMessageKind;
}): Promise<RequestAdministratorMessageOutcome> {
  try {
    await audit({
      ...input,
      type: `${input.messageKind}-attempt`,
      result: 'failure',
      problemCode: input.kind,
    });
    return { kind: input.kind };
  } catch {
    return { kind: 'internal-error' };
  }
}

async function auditedCooldown(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly subjectId: string;
  readonly requestId: string;
  readonly kind: AdministratorMessageKind;
  readonly retryAfterSeconds: number;
}): Promise<RequestAdministratorMessageOutcome> {
  try {
    await audit({
      ...input,
      type: `${input.kind}-attempt`,
      result: 'failure',
      problemCode: 'cooldown-active',
      metadata: { retryAfterSeconds: input.retryAfterSeconds },
    });
    return { kind: 'cooldown-active', retryAfterSeconds: input.retryAfterSeconds };
  } catch {
    return { kind: 'internal-error' };
  }
}

async function prepareMessage(input: {
  readonly runtime: IdentityRuntime;
  readonly kind: AdministratorMessageKind;
  readonly email: string;
  readonly retryPayload: string | null;
}): Promise<string | null> {
  if (input.retryPayload !== null) return input.retryPayload;
  try {
    const auth = input.runtime.administratorMessaging();
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
    if (!(response instanceof Response) || !response.ok) return null;
    return await input.runtime.sealPreparedAdministratorMessage();
  } catch {
    return null;
  }
}

async function finalizeScheduling(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly kind: AdministratorMessageKind;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly key: string;
  readonly bodyHash: string;
  readonly path: string;
  readonly requestId: string;
  readonly response: AdminAdministratorMessage;
  readonly retryPayload: string | null;
  readonly scheduled: boolean;
}): Promise<boolean> {
  const now = Date.now();
  const responseStatus = input.scheduled ? 202 : 503;
  const responseBody = input.scheduled ? JSON.stringify(input.response) : failureBody(input.path);
  const statements = [
    input.db
      .prepare(
        `UPDATE administrator_message_workflow
         SET state = ?, updated_at = ?,
           last_scheduled_at = CASE WHEN ? = 1 THEN ? ELSE last_scheduled_at END
         WHERE id = ? AND claim_token = ?`,
      )
      .bind(
        input.scheduled ? 'scheduled' : 'scheduling-failed',
        now,
        input.scheduled ? 1 : 0,
        now,
        input.workflowId,
        input.claimToken,
      ),
    input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET response_status = ?, response_body = ?, retry_payload = ?
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
           AND key = ? AND body_hash = ?
           AND EXISTS (
             SELECT 1 FROM administrator_message_workflow WHERE id = ? AND claim_token = ?
           )`,
      )
      .bind(
        responseStatus,
        responseBody,
        input.scheduled ? null : input.retryPayload,
        input.actorId,
        input.path,
        input.targetId,
        input.key,
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
           SELECT ?, 1, ?, ?, 'administrator', ?, 'administrator', ?, 'failure', ?,
             'delivery-scheduling-failed', ?
           WHERE EXISTS (
             SELECT 1 FROM administrator_message_workflow WHERE id = ? AND claim_token = ?
           )`,
        )
        .bind(
          opaqueId(),
          `${input.kind}-attempt`,
          now,
          input.actorId,
          input.targetId,
          input.requestId,
          JSON.stringify({ state: 'scheduling-failed' }),
          input.workflowId,
          input.claimToken,
        ),
    );
  }
  const results = await input.db.batch(statements);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

async function markAcceptedDispatch(input: {
  readonly db: D1Database;
  readonly actorId: string;
  readonly targetId: string;
  readonly workflowId: string;
  readonly claimToken: string;
  readonly key: string;
  readonly bodyHash: string;
  readonly path: string;
  readonly response: AdminAdministratorMessage;
}): Promise<boolean> {
  // Persist the no-redispatch fence first. Once 103 is durable, replay returns
  // the accepted response even if updating the presentation workflow fails.
  try {
    const terminal = await input.db
      .prepare(
        `UPDATE admin_idempotency_record
         SET response_status = 103, response_body = ?, retry_payload = NULL
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
           AND key = ? AND body_hash = ? AND response_status IN (102, 202)
           AND EXISTS (
             SELECT 1 FROM administrator_message_workflow
             WHERE id = ? AND claim_token = ?
           )`,
      )
      .bind(
        JSON.stringify(input.response),
        input.actorId,
        input.path,
        input.targetId,
        input.key,
        input.bodyHash,
        input.workflowId,
        input.claimToken,
      )
      .run();
    if (terminal.meta.changes !== 1) {
      const workflow = await input.db
        .prepare(
          `UPDATE administrator_message_workflow
           SET state = 'scheduled', updated_at = ?, last_scheduled_at = ?,
             claim_token = NULL, claimed_at = NULL
           WHERE id = ? AND claim_token = ?`,
        )
        .bind(Date.now(), Date.now(), input.workflowId, input.claimToken)
        .run();
      return workflow.meta.changes === 1;
    }
  } catch {
    // A second durable fence is the workflow state. If the idempotency marker
    // is unavailable, scheduled state still prevents this key from dispatching
    // again; replay repairs the marker when storage is available.
    try {
      const workflow = await input.db
        .prepare(
          `UPDATE administrator_message_workflow
           SET state = 'scheduled', updated_at = ?, last_scheduled_at = ?,
             claim_token = NULL, claimed_at = NULL
           WHERE id = ? AND claim_token = ?`,
        )
        .bind(Date.now(), Date.now(), input.workflowId, input.claimToken)
        .run();
      return workflow.meta.changes === 1;
    } catch {
      return false;
    }
  }

  try {
    await input.db
      .prepare(
        `UPDATE administrator_message_workflow
         SET state = 'scheduled', updated_at = ?, last_scheduled_at = ?,
           claim_token = NULL, claimed_at = NULL
         WHERE id = ? AND claim_token = ?`,
      )
      .bind(Date.now(), Date.now(), input.workflowId, input.claimToken)
      .run();
  } catch {
    // The response marker is authoritative for replay and blocks redispatch.
  }
  return true;
}

export async function requestAdministratorMessage(input: {
  readonly db: D1Database;
  readonly runtime: IdentityRuntime;
  readonly schedule?: (payload: string) => Promise<AdministratorMessageSchedulingResult>;
  readonly actorId: string;
  readonly administratorId: string;
  readonly kind: AdministratorMessageKind;
  readonly headers: Headers;
  readonly idempotencyKey?: string;
  readonly body: AdminAdministratorMessageRequest;
  readonly normalizedPath: string;
  readonly instancePath: string;
  readonly requestId: string;
}): Promise<RequestAdministratorMessageOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.runtime.administration(),
      db: input.db,
      administratorId: input.actorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') {
    return auditedFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: authorization.kind,
      messageKind: input.kind,
    });
  }
  if (input.idempotencyKey === undefined || input.idempotencyKey.length === 0) {
    return auditedFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'precondition-required',
      messageKind: input.kind,
    });
  }

  const idempotencyKey = input.idempotencyKey;
  const bodyHash = await digestBody(input.body);
  const now = Date.now();
  const readCommitted = (): Promise<IdempotencyRow | null> =>
    readIdempotency({
      db: input.db,
      actorId: input.actorId,
      path: input.normalizedPath,
      targetId: input.administratorId,
      key: idempotencyKey,
      now,
    });
  let existingIdempotency: IdempotencyRow | null;
  try {
    existingIdempotency = await readCommitted();
  } catch {
    return { kind: 'internal-error' };
  }
  if (existingIdempotency !== null && existingIdempotency.body_hash !== bodyHash) {
    return auditedFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'idempotency-key-reused',
      messageKind: input.kind,
    });
  }
  if (
    existingIdempotency?.response_status === 200 ||
    existingIdempotency?.response_status === 202 ||
    existingIdempotency?.response_status === 103
  ) {
    const value = parseCommittedResponse(existingIdempotency.response_body);
    return value === null
      ? { kind: 'internal-error' }
      : {
          kind: 'accepted',
          status: existingIdempotency.response_status === 200 ? 200 : 202,
          value,
        };
  }
  if (existingIdempotency?.response_status === 102) {
    const workflow = await readWorkflow(input.db, input.administratorId, input.kind);
    if (workflow?.state === 'scheduled') {
      const value = parseCommittedResponse(existingIdempotency.response_body);
      if (value === null) return { kind: 'internal-error' };
      try {
        await input.db
          .prepare(
            `UPDATE admin_idempotency_record SET response_status = 103, retry_payload = NULL
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
               AND key = ? AND body_hash = ? AND response_status = 102`,
          )
          .bind(
            input.actorId,
            input.normalizedPath,
            input.administratorId,
            idempotencyKey,
            bodyHash,
          )
          .run();
      } catch {
        // The scheduled workflow row remains a same-key no-redispatch fence.
      }
      return { kind: 'accepted', status: 202, value };
    }
  }
  const target = await readTarget(input.db, input.administratorId);
  if (target === null) {
    return auditedFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: null,
      requestId: input.requestId,
      kind: 'administrator-not-found',
      messageKind: input.kind,
    });
  }
  if (input.kind === 'email-verification' && target.email_verified === 1) {
    const response: AdminAdministratorMessage = {
      kind: 'email-verification',
      state: 'verified',
      changed: false,
      revision: currentRevision(target),
    };
    try {
      await input.db.batch([
        input.db
          .prepare(
            `INSERT INTO admin_idempotency_record
             (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
              response_body, retry_payload, created_at, expires_at)
             VALUES (?, ?, ?, 'POST', ?, ?, ?, 200, ?, NULL, ?, ?)
             ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO NOTHING`,
          )
          .bind(
            opaqueId(),
            input.actorId,
            idempotencyKey,
            input.normalizedPath,
            target.id,
            bodyHash,
            JSON.stringify(response),
            now,
            now + IDEMPOTENCY_RETENTION_MS,
          ),
        input.db
          .prepare(
            `INSERT INTO identity_event
             (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
              result, request_id, problem_code, metadata)
             SELECT ?, 1, 'email-verification-attempt', ?, 'administrator', ?, 'administrator', ?,
               'success', ?, NULL, ?
             WHERE EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
                 AND key = ? AND body_hash = ? AND response_status = 200
             )`,
          )
          .bind(
            opaqueId(),
            now,
            input.actorId,
            target.id,
            input.requestId,
            JSON.stringify({ changed: false }),
            input.actorId,
            input.normalizedPath,
            target.id,
            idempotencyKey,
            bodyHash,
          ),
      ]);
      const committed = await readCommitted();
      if (committed?.body_hash !== bodyHash) {
        return await auditedFailure({
          db: input.db,
          actorId: input.actorId,
          subjectId: target.id,
          requestId: input.requestId,
          kind: 'idempotency-key-reused',
          messageKind: input.kind,
        });
      }
      const committedResponse = parseCommittedResponse(committed.response_body);
      return committedResponse === null
        ? { kind: 'internal-error' }
        : { kind: 'accepted', status: 200, value: committedResponse };
    } catch {
      return { kind: 'internal-error' };
    }
  }
  if (input.kind === 'password-recovery' && !(await hasUsableCredential(input.db, target.id))) {
    return auditedFailure({
      db: input.db,
      actorId: input.actorId,
      subjectId: target.id,
      requestId: input.requestId,
      kind: 'no-usable-login-method',
      messageKind: input.kind,
    });
  }
  const retrying =
    existingIdempotency?.response_status === 503 || existingIdempotency?.response_status === 102;
  const workflow = await readWorkflow(input.db, target.id, input.kind);
  if (!retrying && workflow !== null && workflow.cooldown_until > now) {
    return auditedCooldown({
      db: input.db,
      actorId: input.actorId,
      subjectId: target.id,
      requestId: input.requestId,
      kind: input.kind,
      retryAfterSeconds: Math.max(1, Math.ceil((workflow.cooldown_until - now) / 1000)),
    });
  }

  const candidateWorkflowId = workflow?.id ?? opaqueId();
  const claimToken = opaqueId();
  const cooldownUntil =
    retrying && workflow !== null && workflow.cooldown_until > now
      ? workflow.cooldown_until
      : now + COOLDOWN_MS;
  const failureResponse = failureBody(input.instancePath);
  const requestEventType =
    input.kind === 'email-verification'
      ? 'email-verification-requested'
      : 'password-recovery-requested';
  try {
    await input.db.batch([
      input.db
        .prepare(
          `INSERT INTO administrator_message_workflow
           (id, user_id, kind, state, cooldown_until, created_at, updated_at, last_scheduled_at,
            claim_token, claimed_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?, NULL, ?, ?)
           ON CONFLICT(user_id, kind) DO UPDATE SET
             state = 'pending', cooldown_until = excluded.cooldown_until,
             updated_at = excluded.updated_at, claim_token = excluded.claim_token,
             claimed_at = excluded.claimed_at
           WHERE (
             administrator_message_workflow.state = 'scheduling-failed'
             OR administrator_message_workflow.cooldown_until <= excluded.created_at
             OR (administrator_message_workflow.state = 'pending'
                 AND COALESCE(administrator_message_workflow.claimed_at,
                              administrator_message_workflow.updated_at) <= ?)
           ) AND NOT EXISTS (
               SELECT 1 FROM admin_idempotency_record
               WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
                 AND target_id = ? AND key = ? AND expires_at > excluded.created_at
                 AND NOT (body_hash = ? AND response_status IN (102, 503))
             )`,
        )
        .bind(
          candidateWorkflowId,
          target.id,
          input.kind,
          cooldownUntil,
          now,
          now,
          claimToken,
          now,
          now - CLAIM_LEASE_MS,
          input.actorId,
          input.normalizedPath,
          target.id,
          idempotencyKey,
          bodyHash,
        ),
      input.db
        .prepare(
          `INSERT INTO admin_idempotency_record
           (id, actor_id, key, method, normalized_path, target_id, body_hash, response_status,
            response_body, retry_payload, created_at, expires_at)
           SELECT ?, ?, ?, 'POST', ?, ?, ?, 102, ?, NULL, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM administrator_message_workflow
             WHERE user_id = ? AND kind = ? AND claim_token = ?
           )
           ON CONFLICT(actor_id, method, normalized_path, target_id, key) DO UPDATE SET
             id = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.id ELSE admin_idempotency_record.id END,
             body_hash = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.body_hash ELSE admin_idempotency_record.body_hash END,
             retry_payload = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN NULL ELSE admin_idempotency_record.retry_payload END,
             created_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.created_at ELSE admin_idempotency_record.created_at END,
             expires_at = CASE WHEN admin_idempotency_record.expires_at <= excluded.created_at
               THEN excluded.expires_at ELSE admin_idempotency_record.expires_at END,
             response_status = 102, response_body = excluded.response_body
           WHERE admin_idempotency_record.expires_at <= excluded.created_at
             OR (admin_idempotency_record.body_hash = excluded.body_hash
                 AND admin_idempotency_record.response_status IN (102, 503)
                 AND admin_idempotency_record.expires_at > excluded.created_at)`,
        )
        .bind(
          opaqueId(),
          input.actorId,
          idempotencyKey,
          input.normalizedPath,
          target.id,
          bodyHash,
          failureResponse,
          now,
          now + IDEMPOTENCY_RETENTION_MS,
          target.id,
          input.kind,
          claimToken,
        ),
      input.db
        .prepare(
          `INSERT INTO identity_event
           (id, version, type, occurred_at, actor_realm, actor_id, subject_realm, subject_id,
            result, request_id, problem_code, metadata)
           SELECT ?, 1, ?, ?, 'administrator', ?, 'administrator', ?, 'success', ?, NULL,
             json_object('workflowId', (
               SELECT id FROM administrator_message_workflow
               WHERE user_id = ? AND kind = ? AND claim_token = ?
             ))
           WHERE EXISTS (
             SELECT 1 FROM administrator_message_workflow
             WHERE user_id = ? AND kind = ? AND claim_token = ?
           ) AND EXISTS (
             SELECT 1 FROM admin_idempotency_record
             WHERE actor_id = ? AND method = 'POST' AND normalized_path = ?
               AND target_id = ? AND key = ? AND body_hash = ? AND response_status = 102
           ) AND ? = 0`,
        )
        .bind(
          opaqueId(),
          requestEventType,
          now,
          input.actorId,
          target.id,
          input.requestId,
          target.id,
          input.kind,
          claimToken,
          target.id,
          input.kind,
          claimToken,
          input.actorId,
          input.normalizedPath,
          target.id,
          idempotencyKey,
          bodyHash,
          retrying ? 1 : 0,
        ),
    ]);
  } catch {
    return { kind: 'internal-error' };
  }
  const claimedWorkflow = await readWorkflow(input.db, target.id, input.kind);
  const committedClaim = await readCommitted();
  if (claimedWorkflow?.claim_token !== claimToken) {
    if (committedClaim !== null && committedClaim.body_hash !== bodyHash) {
      return auditedFailure({
        db: input.db,
        actorId: input.actorId,
        subjectId: target.id,
        requestId: input.requestId,
        kind: 'idempotency-key-reused',
        messageKind: input.kind,
      });
    }
    if (committedClaim?.response_status === 202 || committedClaim?.response_status === 103) {
      const value = parseCommittedResponse(committedClaim.response_body);
      return value === null ? { kind: 'internal-error' } : { kind: 'accepted', status: 202, value };
    }
    if (committedClaim?.response_status === 503 || committedClaim?.response_status === 102) {
      return { kind: 'delivery-scheduling-failed' };
    }
    const current = await readWorkflow(input.db, target.id, input.kind);
    if (current !== null && current.cooldown_until > now) {
      const retryAfterSeconds = Math.max(1, Math.ceil((current.cooldown_until - now) / 1000));
      return auditedCooldown({
        db: input.db,
        actorId: input.actorId,
        subjectId: target.id,
        requestId: input.requestId,
        kind: input.kind,
        retryAfterSeconds,
      });
    }
    return { kind: 'internal-error' };
  }
  if (committedClaim === null) return { kind: 'internal-error' };
  if (committedClaim.body_hash !== bodyHash || committedClaim.response_status !== 102) {
    return { kind: 'internal-error' };
  }
  if (!retrying) {
    const event = await input.db
      .prepare(
        `SELECT 1 AS present FROM identity_event
         WHERE request_id = ? AND subject_id = ? AND type = ? AND result = 'success' LIMIT 1`,
      )
      .bind(input.requestId, target.id, requestEventType)
      .first<{ readonly present: number }>();
    if (event === null) return { kind: 'internal-error' };
  }
  const workflowId = claimedWorkflow.id;
  const response = responseValue({
    workflowId,
    kind: input.kind,
    cooldownUntil,
    revision: currentRevision(target),
  });

  const retryPayload = await prepareMessage({
    runtime: input.runtime,
    kind: input.kind,
    email: target.email,
    retryPayload: retrying ? (existingIdempotency?.retry_payload ?? null) : null,
  });
  if (retryPayload === null) {
    try {
      const finalized = await finalizeScheduling({
        db: input.db,
        actorId: input.actorId,
        targetId: target.id,
        kind: input.kind,
        workflowId,
        claimToken,
        key: idempotencyKey,
        bodyHash,
        path: input.normalizedPath,
        requestId: input.requestId,
        response,
        retryPayload: null,
        scheduled: false,
      });
      return finalized ? { kind: 'delivery-scheduling-failed' } : { kind: 'internal-error' };
    } catch {
      return { kind: 'internal-error' };
    }
  }
  try {
    const persisted = await input.db
      .prepare(
        `UPDATE admin_idempotency_record SET retry_payload = ?, response_body = ?
         WHERE actor_id = ? AND method = 'POST' AND normalized_path = ? AND target_id = ?
           AND key = ? AND body_hash = ? AND response_status = 102
           AND EXISTS (
             SELECT 1 FROM administrator_message_workflow WHERE id = ? AND claim_token = ?
           )`,
      )
      .bind(
        retryPayload,
        JSON.stringify(response),
        input.actorId,
        input.normalizedPath,
        target.id,
        idempotencyKey,
        bodyHash,
        workflowId,
        claimToken,
      )
      .run();
    if (persisted.meta.changes !== 1) return { kind: 'internal-error' };
  } catch {
    return { kind: 'internal-error' };
  }
  let scheduling: 'accepted' | 'rejected' | 'invalid-envelope';
  try {
    scheduling = await (input.schedule === undefined
      ? input.runtime.retryAdministratorMessageScheduling(retryPayload)
      : input.schedule(retryPayload));
  } catch {
    scheduling = 'rejected';
  }
  if (scheduling === 'invalid-envelope') {
    try {
      const finalized = await finalizeScheduling({
        db: input.db,
        actorId: input.actorId,
        targetId: target.id,
        kind: input.kind,
        workflowId,
        claimToken,
        key: idempotencyKey,
        bodyHash,
        path: input.normalizedPath,
        requestId: input.requestId,
        response,
        retryPayload: null,
        scheduled: false,
      });
      return finalized ? { kind: 'delivery-scheduling-failed' } : { kind: 'internal-error' };
    } catch {
      return { kind: 'internal-error' };
    }
  }
  let applied: boolean;
  try {
    applied = await finalizeScheduling({
      db: input.db,
      actorId: input.actorId,
      targetId: target.id,
      kind: input.kind,
      workflowId,
      claimToken,
      key: idempotencyKey,
      bodyHash,
      path: input.normalizedPath,
      requestId: input.requestId,
      response,
      retryPayload,
      scheduled: scheduling === 'accepted',
    });
  } catch {
    applied = false;
  }
  if (!applied) {
    let committed: IdempotencyRow | null = null;
    try {
      committed = await readCommitted();
    } catch {
      // Continue to the accepted-dispatch fallback rather than returning an
      // ambiguous server error after the scheduler has accepted the task.
    }
    if (committed?.response_status === 202) {
      const value = parseCommittedResponse(committed.response_body);
      return value === null ? { kind: 'internal-error' } : { kind: 'accepted', status: 202, value };
    }
    if (scheduling === 'accepted') {
      const marked = await markAcceptedDispatch({
        db: input.db,
        actorId: input.actorId,
        targetId: target.id,
        workflowId,
        claimToken,
        key: idempotencyKey,
        bodyHash,
        path: input.normalizedPath,
        response,
      });
      if (marked) return { kind: 'accepted', status: 202, value: response };
      return { kind: 'internal-error' };
    }
    return { kind: 'delivery-scheduling-failed' };
  }
  return scheduling === 'accepted'
    ? { kind: 'accepted', status: 202, value: response }
    : { kind: 'delivery-scheduling-failed' };
}
