import type { D1Database } from '@cloudflare/workers-types';
import type { createAdministrationAuth } from './auth.js';
import type {
  AdminAuditEvent,
  AdminAuditEvents,
  AdminAuditEventsQuery,
  AdminAuditProblemCode,
} from './contract.js';
import {
  AdminAuditEventSchema,
  AdminAuditMetadataSchema,
  AdminAuditProblemCodeSchema,
} from './contract.js';
import { authorizeAdministrator } from './admin-authorization.js';

const RAW_SCAN_CHUNK_SIZE = 50;
const MAX_RAW_SCAN_ROWS = 1_000;

const ADMIN_AUDIT_EVENT_ALLOWLIST = [
  { version: 1, type: 'access-attempt' },
  { version: 1, type: 'access-disabled' },
  { version: 1, type: 'access-rehabilitated' },
  { version: 1, type: 'email-verification-attempt' },
  { version: 1, type: 'email-verification-requested' },
  { version: 1, type: 'email-verified' },
  { version: 1, type: 'email-change-attempt' },
  { version: 1, type: 'email-change-requested' },
  { version: 1, type: 'email-change-message-attempt' },
  { version: 1, type: 'email-change-message-requested' },
  { version: 1, type: 'email-change-cancelled' },
  { version: 1, type: 'email-changed' },
  { version: 1, type: 'password-recovery-attempt' },
  { version: 1, type: 'password-recovery-requested' },
] as const;

const PROBLEM_CODE_SET = new Set<string>(AdminAuditProblemCodeSchema.options);

const METADATA_FIELDS_BY_TYPE: Readonly<Record<string, readonly string[]>> = {
  'access-attempt': ['changed'],
  'access-disabled': ['revision'],
  'access-rehabilitated': ['revision'],
  'email-verification-attempt': ['changed', 'retryAfterSeconds', 'state'],
  'email-verified': ['operation', 'revision'],
  'email-verification-requested': ['workflowId'],
  'email-change-attempt': ['changed', 'revision', 'state', 'supersedesId'],
  'email-change-requested': ['workflowId', 'supersedesId'],
  'email-change-message-attempt': ['retryAfterSeconds', 'state'],
  'email-change-message-requested': ['workflowId'],
  'email-change-cancelled': ['changed', 'revision', 'workflowId'],
  'email-changed': ['revision', 'workflowId'],
  'password-recovery-attempt': ['retryAfterSeconds', 'state'],
  'password-recovery-requested': ['workflowId'],
};

interface AuditCursor {
  readonly occurredAt: number;
  readonly id: string;
}

interface AuditRow {
  readonly id: string;
  readonly version: number;
  readonly type: string;
  readonly occurred_at: number;
  readonly actor_realm: string;
  readonly actor_id: string;
  readonly subject_realm: string | null;
  readonly subject_id: string | null;
  readonly result: 'success' | 'failure';
  readonly request_id: string;
  readonly problem_code: string | null;
  readonly metadata: string | null;
}

export type AdminAuditEventsOutcome =
  | { readonly kind: 'success'; readonly value: AdminAuditEvents }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'bad-cursor' }
  | { readonly kind: 'internal-error' };

function encodeCursor(cursor: AuditCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value: string): AuditCursor | null {
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
      decoded.id.length === 0 ||
      decoded.id.length > 128
    ) {
      return null;
    }
    return { occurredAt: decoded.occurredAt, id: decoded.id };
  } catch {
    return null;
  }
}

function isOpaqueIdentifier(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function safeMetadata(type: string, serialized: string | null): AdminAuditEvent['metadata'] {
  if (serialized === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return null;
  }
  if (!isPlainRecord(parsed)) return null;

  const safe: Record<string, boolean | number | string> = {};
  for (const field of METADATA_FIELDS_BY_TYPE[type] ?? []) {
    const value = parsed[field];
    if (field === 'changed' && typeof value === 'boolean') safe.changed = value;
    if (
      field === 'revision' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value > 0
    ) {
      safe.revision = value;
    }
    if (
      field === 'retryAfterSeconds' &&
      typeof value === 'number' &&
      Number.isSafeInteger(value) &&
      value >= 1 &&
      value <= 86_400
    ) {
      safe.retryAfterSeconds = value;
    }
    if (
      field === 'workflowId' &&
      typeof value === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ) {
      safe.workflowId = value;
    }
    if (
      field === 'supersedesId' &&
      typeof value === 'string' &&
      /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ) {
      safe.supersedesId = value;
    }
    if (
      field === 'operation' &&
      typeof value === 'string' &&
      value.length <= 64 &&
      /^[a-z][a-z0-9-]*$/.test(value)
    ) {
      safe.operation = value;
    }
    if (field === 'state' && (value === 'committed' || value === 'scheduling-failed')) {
      safe.state = value;
    }
  }
  if (Object.keys(safe).length === 0) return null;
  const parsedSafe = AdminAuditMetadataSchema.safeParse(safe);
  return parsedSafe.success ? parsedSafe.data : null;
}

function isAdminAuditProblemCode(value: string): value is AdminAuditProblemCode {
  return PROBLEM_CODE_SET.has(value);
}

function safeProblemCode(value: string | null): AdminAuditProblemCode | null {
  return value !== null && isAdminAuditProblemCode(value) ? value : null;
}

function projectEvent(row: AuditRow): AdminAuditEvent | null {
  if (
    !ADMIN_AUDIT_EVENT_ALLOWLIST.some(
      (event) => event.version === row.version && event.type === row.type,
    ) ||
    !isOpaqueIdentifier(row.id) ||
    !isOpaqueIdentifier(row.actor_id) ||
    !isOpaqueIdentifier(row.request_id) ||
    !/^[a-z][a-z0-9.-]{0,127}$/.test(row.type) ||
    !Number.isSafeInteger(row.version) ||
    !Number.isSafeInteger(row.occurred_at)
  ) {
    return null;
  }
  if (row.subject_id !== null && !isOpaqueIdentifier(row.subject_id)) return null;
  const subject: AdminAuditEvent['subject'] =
    row.subject_id !== null &&
    (row.subject_realm === 'reader' || row.subject_realm === 'administrator')
      ? { id: row.subject_id, realm: row.subject_realm }
      : null;
  const candidate: unknown = {
    id: row.id,
    version: row.version,
    type: row.type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    actor: { id: row.actor_id, realm: 'administrator' },
    subject,
    result: row.result,
    requestId: row.request_id,
    problemCode: safeProblemCode(row.problem_code),
    metadata: safeMetadata(row.type, row.metadata),
  };
  const parsed = AdminAuditEventSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

async function fetchAuditRows(input: {
  readonly db: D1Database;
  readonly query: AdminAuditEventsQuery;
  readonly after?: AuditCursor;
  readonly limit: number;
}): Promise<AuditRow[]> {
  const conditions = [
    "actor_realm = 'administrator'",
    "result IN ('success', 'failure')",
    // These two fields form the cursor key. Keep them safe before encoding a
    // continuation; all other shape failures are handled by projectEvent and
    // skipped while scanning bounded raw chunks.
    "typeof(id) = 'text' AND length(id) BETWEEN 1 AND 128 AND id NOT GLOB '*[^A-Za-z0-9_-]*'",
    "typeof(occurred_at) = 'integer' AND occurred_at BETWEEN -8640000000000000 AND 8640000000000000",
    `(${ADMIN_AUDIT_EVENT_ALLOWLIST.map(() => '(version = ? AND type = ?)').join(' OR ')})`,
  ];
  const bindings: (string | number)[] = ADMIN_AUDIT_EVENT_ALLOWLIST.flatMap((event) => [
    event.version,
    event.type,
  ]);
  if (input.query.actorId !== undefined) {
    conditions.push('actor_id = ?');
    bindings.push(input.query.actorId);
  }
  if (input.query.action !== undefined) {
    conditions.push('type = ?');
    bindings.push(input.query.action);
  }
  if (input.query.result !== undefined) {
    conditions.push('result = ?');
    bindings.push(input.query.result);
  }
  if (input.query.from !== undefined) {
    conditions.push('occurred_at >= ?');
    bindings.push(Date.parse(input.query.from));
  }
  if (input.query.to !== undefined) {
    conditions.push('occurred_at <= ?');
    bindings.push(Date.parse(input.query.to));
  }
  if (input.after !== undefined) {
    conditions.push('(occurred_at < ? OR (occurred_at = ? AND id < ?))');
    bindings.push(input.after.occurredAt, input.after.occurredAt, input.after.id);
  }
  bindings.push(input.limit);
  const result = await input.db
    .prepare(
      `SELECT id, version, type, occurred_at, actor_realm, actor_id, subject_realm,
              subject_id, result, request_id, problem_code, metadata
       FROM identity_event
       WHERE ${conditions.join(' AND ')}
       ORDER BY occurred_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...bindings)
    .all<AuditRow>();
  return result.results;
}

export async function readAdminAuditEvents(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly query: AdminAuditEventsQuery;
}): Promise<AdminAuditEventsOutcome> {
  let authorization: Awaited<ReturnType<typeof authorizeAdministrator>>;
  try {
    authorization = await authorizeAdministrator({
      auth: input.auth,
      db: input.db,
      administratorId: input.administratorId,
      headers: input.headers,
    });
  } catch {
    return { kind: 'internal-error' };
  }
  if (authorization.kind !== 'allowed') return { kind: authorization.kind };

  const cursor = input.query.cursor === undefined ? undefined : decodeCursor(input.query.cursor);
  if (input.query.cursor !== undefined && cursor === null) return { kind: 'bad-cursor' };

  try {
    const items: AdminAuditEvent[] = [];
    let after = cursor ?? undefined;
    let lastScanned: AuditCursor | undefined;
    let scanned = 0;
    while (scanned < MAX_RAW_SCAN_ROWS) {
      const chunkLimit = Math.min(RAW_SCAN_CHUNK_SIZE, MAX_RAW_SCAN_ROWS - scanned);
      const rows = await fetchAuditRows({
        db: input.db,
        query: input.query,
        ...(after === undefined ? {} : { after }),
        limit: chunkLimit,
      });
      if (rows.length === 0) return { kind: 'success', value: { items, nextCursor: null } };
      for (const row of rows) {
        scanned += 1;
        const event = projectEvent(row);
        if (event !== null && items.length === input.query.limit) {
          return {
            kind: 'success',
            value: {
              items,
              nextCursor: lastScanned === undefined ? null : encodeCursor(lastScanned),
            },
          };
        }
        if (event !== null) items.push(event);
        lastScanned = { occurredAt: row.occurred_at, id: row.id };
      }
      after = lastScanned;
      if (rows.length < chunkLimit) {
        return { kind: 'success', value: { items, nextCursor: null } };
      }
    }
    const moreRows = await fetchAuditRows({
      db: input.db,
      query: input.query,
      ...(lastScanned === undefined ? {} : { after: lastScanned }),
      limit: 1,
    });
    return {
      kind: 'success',
      value: {
        items,
        nextCursor:
          moreRows.length > 0 && lastScanned !== undefined ? encodeCursor(lastScanned) : null,
      },
    };
  } catch {
    return { kind: 'internal-error' };
  }
}
