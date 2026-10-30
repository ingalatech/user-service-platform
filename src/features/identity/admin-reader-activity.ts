import type { D1Database } from '@cloudflare/workers-types';
import type { createAdministrationAuth } from './auth.js';
import type { AdminReaderActivity } from './contract.js';
import { authorizeAdministrator } from './admin-authorization.js';

const ACTIVITY_TYPES = [
  'email-verified',
  'email-changed',
  'social-identity-unlinked',
  'sessions-revoked',
  'access-disabled',
  'access-rehabilitated',
  'deletion-requested',
  'deletion-approved',
  'deletion-rejected',
  'deletion-cancelled',
] as const;

type ActivityType = (typeof ACTIVITY_TYPES)[number];

interface ActivityCursor {
  readonly occurredAt: number;
  readonly id: string;
}

function encodeCursor(cursor: ActivityCursor): string {
  return btoa(JSON.stringify(cursor)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function decodeCursor(value: string): ActivityCursor | null {
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
      decoded.id.length === 0
    ) {
      return null;
    }
    return { occurredAt: decoded.occurredAt, id: decoded.id };
  } catch {
    return null;
  }
}

interface EventRow {
  readonly id: string;
  readonly type: ActivityType;
  readonly occurred_at: number;
  readonly actor_id: string;
}

export type AdminReaderActivityOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderActivity }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'reader-not-found' }
  | { readonly kind: 'bad-cursor' };

export async function readAdminReaderActivity(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly readerId: string;
  readonly limit: number;
  readonly cursor?: string;
}): Promise<AdminReaderActivityOutcome> {
  const authorization = await authorizeAdministrator({
    auth: input.auth,
    db: input.db,
    administratorId: input.administratorId,
    headers: input.headers,
  });
  if (authorization.kind !== 'allowed') return { kind: authorization.kind };

  const target = await input.db
    .prepare(`SELECT id FROM user WHERE id = ? AND (role IS NULL OR role <> 'admin')`)
    .bind(input.readerId)
    .first<{ id: string }>();
  if (target === null) return { kind: 'reader-not-found' };

  const cursor = input.cursor === undefined ? undefined : decodeCursor(input.cursor);
  if (input.cursor !== undefined && cursor === null) return { kind: 'bad-cursor' };
  const placeholders = ACTIVITY_TYPES.map(() => '?').join(', ');
  const cursorClause =
    cursor === undefined ? '' : 'AND (occurred_at < ? OR (occurred_at = ? AND id < ?))';
  const statement = input.db.prepare(
    `SELECT id, type, occurred_at, actor_id
     FROM identity_event
     WHERE subject_realm = 'reader' AND subject_id = ?
       AND actor_realm = 'administrator' AND result = 'success' AND version = 1
       AND type IN (${placeholders})
       ${cursorClause}
     ORDER BY occurred_at DESC, id DESC
     LIMIT ?`,
  );
  const bindings: (string | number)[] = [input.readerId, ...ACTIVITY_TYPES];
  if (cursor !== undefined && cursor !== null) {
    bindings.push(cursor.occurredAt, cursor.occurredAt, cursor.id);
  }
  bindings.push(input.limit + 1);
  const result = await statement.bind(...bindings).all<EventRow>();
  const rows = result.results.slice(0, input.limit);
  const last = rows.at(-1);
  return {
    kind: 'success',
    value: {
      items: rows.map((row) => ({
        id: row.id,
        type: row.type,
        occurredAt: new Date(row.occurred_at).toISOString(),
        actor: { id: row.actor_id, realm: 'administrator' },
      })),
      nextCursor:
        result.results.length > input.limit && last !== undefined
          ? encodeCursor({ occurredAt: last.occurred_at, id: last.id })
          : null,
    },
  };
}
