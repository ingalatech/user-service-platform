import type { D1Database } from '@cloudflare/workers-types';
import type { createAdministrationAuth } from './auth.js';
import type { AdminReaderSessionRevocation, AdminReaderSessions } from './contract.js';
import { authorizeAdministrator } from './admin-authorization.js';
import { prepareReaderSessionRevocation, readerSessionTimestamp } from './reader-session-store.js';

const SESSION_REVOKE_ATTEMPT = 'session-revoke-attempt';
const SESSIONS_REVOKE_ATTEMPT = 'sessions-revoke-attempt';
const SESSION_REVOKED = 'session-revoked';
const SESSIONS_REVOKED = 'sessions-revoked';

interface SessionCursor {
  readonly updatedAt: number;
  readonly id: string;
}

const SELECTOR_PREFIX = 's1_';
const SELECTOR_KEY_PURPOSE = 'reader-session-selector-v1';
const CURSOR_KEY_PURPOSE = 'reader-session-cursor-v1';
const MAX_SESSION_ID_LENGTH = 128;

interface SessionRow {
  readonly id: string;
  readonly created_at: number;
  readonly updated_at: number;
  readonly expires_at: number;
}

interface ReaderStateRow {
  readonly state: string | null;
  readonly revision: number | null;
  readonly deletion_state: string | null;
}

type AuthorizationFailure = 'forbidden' | 'administrator-disabled';

export type AdminReaderSessionsOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderSessions }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'reader-not-found' }
  | { readonly kind: 'bad-cursor' }
  | { readonly kind: 'internal-error' };

export type AdminReaderSessionRevocationOutcome =
  | { readonly kind: 'success'; readonly value: AdminReaderSessionRevocation }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'reader-not-found' }
  | { readonly kind: 'internal-error' };

async function deriveAesKey(secret: string, purpose: string) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    'HKDF',
    false,
    ['deriveKey'],
  );
  return crypto.subtle.deriveKey(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new TextEncoder().encode('user-service-platform/identity/admin-reader-sessions'),
      info: new TextEncoder().encode(purpose),
    },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function encodeUrlSafe(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function decodeUrlSafe(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), (character) =>
    character.charCodeAt(0),
  );
}

async function encodeSelector(id: string, secret: string): Promise<string> {
  const key = await deriveAesKey(secret, SELECTOR_KEY_PURPOSE);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(id),
  );
  const payload = new Uint8Array(iv.length + ciphertext.byteLength);
  payload.set(iv);
  payload.set(new Uint8Array(ciphertext), iv.length);
  return `${SELECTOR_PREFIX}${encodeUrlSafe(payload)}`;
}

async function decodeSelector(selector: string, secret: string): Promise<string | null> {
  try {
    if (!selector.startsWith(SELECTOR_PREFIX)) return null;
    const bytes = decodeUrlSafe(selector.slice(SELECTOR_PREFIX.length));
    if (bytes.length < 29 || bytes.length > 156) return null;
    const key = await deriveAesKey(secret, SELECTOR_KEY_PURPOSE);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    );
    const id = new TextDecoder('utf-8', { fatal: true }).decode(plaintext);
    if (id.length < 1 || id.length > MAX_SESSION_ID_LENGTH) return null;
    return id;
  } catch {
    return null;
  }
}

async function encodeCursor(cursor: SessionCursor, secret: string): Promise<string> {
  const key = await deriveAesKey(secret, CURSOR_KEY_PURPOSE);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(cursor)),
  );
  const bytes = new Uint8Array(iv.length + ciphertext.byteLength);
  bytes.set(iv);
  bytes.set(new Uint8Array(ciphertext), iv.length);
  return encodeUrlSafe(bytes);
}

async function decodeCursor(value: string, secret: string): Promise<SessionCursor | null> {
  try {
    const bytes = decodeUrlSafe(value);
    if (bytes.length < 29) return null;
    const key = await deriveAesKey(secret, CURSOR_KEY_PURPOSE);
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12) },
      key,
      bytes.slice(12),
    );
    const decoded: unknown = JSON.parse(new TextDecoder().decode(plaintext));
    if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) return null;
    const record = decoded as Record<string, unknown>;
    if (
      Object.keys(record).length !== 2 ||
      !Number.isSafeInteger(record.updatedAt) ||
      typeof record.id !== 'string' ||
      record.id.length < 1 ||
      record.id.length > 128
    ) {
      return null;
    }
    return { updatedAt: record.updatedAt as number, id: record.id };
  } catch {
    return null;
  }
}

async function authorized(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
}): Promise<'allowed' | AuthorizationFailure | 'internal-error'> {
  try {
    const outcome = await authorizeAdministrator(input);
    return outcome.kind === 'allowed' ? 'allowed' : outcome.kind;
  } catch {
    return 'internal-error';
  }
}

async function readerState(db: D1Database, readerId: string): Promise<ReaderStateRow | null> {
  return db
    .prepare(
      `SELECT u.id, ras.state, ras.revision,
         (SELECT state FROM reader_deletion_request
          WHERE user_id=u.id AND state IN ('pending_review','approved') LIMIT 1) AS deletion_state
       FROM user u LEFT JOIN reader_access_state ras ON ras.user_id=u.id
       WHERE u.id=? AND (u.role IS NULL OR u.role <> 'admin') LIMIT 1`,
    )
    .bind(readerId)
    .first<ReaderStateRow>();
}

function publicState(state: ReaderStateRow): AdminReaderSessionRevocation['state'] {
  if (state.deletion_state === 'pending_review' || state.deletion_state === 'approved') {
    return 'suspended';
  }
  return state.state === 'disabled' ? 'disabled' : 'active';
}

function currentRevision(state: ReaderStateRow): number {
  return state.revision ?? 1;
}

export async function listAdminReaderSessions(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly readerId: string;
  readonly limit: number;
  readonly cursor?: string;
  readonly cursorSecret: string;
  readonly now?: number;
}): Promise<AdminReaderSessionsOutcome> {
  const authorization = await authorized(input);
  if (authorization !== 'allowed') return { kind: authorization };

  let target: ReaderStateRow | null;
  try {
    target = await readerState(input.db, input.readerId);
  } catch {
    return { kind: 'internal-error' };
  }
  if (target === null) return { kind: 'reader-not-found' };

  const cursor =
    input.cursor === undefined ? undefined : await decodeCursor(input.cursor, input.cursorSecret);
  if (input.cursor !== undefined && cursor === null) return { kind: 'bad-cursor' };
  try {
    const now = readerSessionTimestamp(input.now ?? Date.now());
    const totalRow = await input.db
      .prepare('SELECT count(*) AS total FROM session WHERE user_id=? AND expires_at>?')
      .bind(input.readerId, now)
      .first<{ total: number }>();
    const cursorClause =
      cursor === undefined ? '' : 'AND (updated_at < ? OR (updated_at = ? AND id < ?))';
    const query = input.db.prepare(
      `SELECT id, created_at, updated_at, expires_at FROM session
       WHERE user_id=? AND expires_at>? ${cursorClause}
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    );
    const binds: (number | string)[] = [input.readerId, now];
    if (cursor !== undefined && cursor !== null)
      binds.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
    binds.push(input.limit + 1);
    const result = await query.bind(...binds).all<SessionRow>();
    const pageRows = result.results.slice(0, input.limit);
    const page = await Promise.all(
      pageRows.map(async (row) => ({
        selector: await encodeSelector(row.id, input.cursorSecret),
        createdAt: new Date(row.created_at * 1_000).toISOString(),
        updatedAt: new Date(row.updated_at * 1_000).toISOString(),
        expiresAt: new Date(row.expires_at * 1_000).toISOString(),
        updatedAtMs: row.updated_at,
        id: row.id,
      })),
    );
    const last = page.at(-1);
    return {
      kind: 'success',
      value: {
        items: page.map((row) => ({
          selector: row.selector,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          expiresAt: row.expiresAt,
        })),
        total: totalRow?.total ?? 0,
        nextCursor:
          result.results.length > input.limit && last !== undefined
            ? await encodeCursor({ updatedAt: last.updatedAtMs, id: last.id }, input.cursorSecret)
            : null,
      },
    };
  } catch {
    return { kind: 'internal-error' };
  }
}

async function auditFailure(input: {
  readonly db: D1Database;
  readonly administratorId: string;
  readonly readerId: string | null;
  readonly requestId: string;
  readonly type: string;
  readonly code: string;
}): Promise<void> {
  await input.db
    .prepare(
      `INSERT INTO identity_event
       (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
       VALUES (?,1,?,?,'administrator',?,'reader',?,'failure',?,?,NULL)`,
    )
    .bind(
      crypto.randomUUID(),
      input.type,
      Date.now(),
      input.administratorId,
      input.readerId,
      input.requestId,
      input.code,
    )
    .run();
}

async function revokeReaderSession(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
  readonly readerId: string;
  readonly requestId: string;
  readonly selector?: string;
  readonly cursorSecret: string;
  readonly now?: number;
}): Promise<AdminReaderSessionRevocationOutcome> {
  const auditType = input.selector === undefined ? SESSIONS_REVOKE_ATTEMPT : SESSION_REVOKE_ATTEMPT;
  const authorization = await authorized(input);
  if (authorization !== 'allowed') {
    if (authorization === 'internal-error') return { kind: authorization };
    try {
      await auditFailure({
        db: input.db,
        administratorId: input.administratorId,
        readerId: null,
        requestId: input.requestId,
        type: auditType,
        code: authorization,
      });
    } catch {
      return { kind: 'internal-error' };
    }
    return { kind: authorization };
  }

  let target: ReaderStateRow | null;
  try {
    target = await readerState(input.db, input.readerId);
  } catch {
    return { kind: 'internal-error' };
  }
  if (target === null) {
    try {
      await auditFailure({
        db: input.db,
        administratorId: input.administratorId,
        readerId: null,
        requestId: input.requestId,
        type: auditType,
        code: 'reader-not-found',
      });
    } catch {
      return { kind: 'internal-error' };
    }
    return { kind: 'reader-not-found' };
  }

  const nowMilliseconds = input.now ?? Date.now();
  const nowSeconds = readerSessionTimestamp(nowMilliseconds);
  const revision = currentRevision(target);
  try {
    let changed: boolean;
    if (input.selector === undefined) {
      const lifecycle = input.db
        .prepare(
          `INSERT INTO identity_event
         (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
         SELECT ?,1,?,?,'administrator',?,'reader',?,'success',?,NULL,
           json_object('count',(SELECT count(*) FROM session WHERE user_id=? AND expires_at>?),'revision',?)
         WHERE EXISTS (SELECT 1 FROM session WHERE user_id=? AND expires_at>?)`,
        )
        .bind(
          crypto.randomUUID(),
          SESSIONS_REVOKED,
          nowMilliseconds,
          input.administratorId,
          input.readerId,
          input.requestId,
          input.readerId,
          nowSeconds,
          revision,
          input.readerId,
          nowSeconds,
        );
      const deletion = prepareReaderSessionRevocation(input.db, input.readerId, {
        kind: 'manual-all',
        now: nowMilliseconds,
      });
      const audit = input.db
        .prepare(
          `INSERT INTO identity_event
         (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
         VALUES (?,1,?,?,'administrator',?,'reader',?, 'success', ?, NULL,
            json_object(
              'changed',json(CASE WHEN (SELECT count(*) FROM session WHERE user_id=? AND expires_at>?)>0 THEN 'true' ELSE 'false' END),
              'count',(SELECT count(*) FROM session WHERE user_id=? AND expires_at>?),
              'revision',?
            ))`,
        )
        .bind(
          crypto.randomUUID(),
          SESSIONS_REVOKE_ATTEMPT,
          nowMilliseconds,
          input.administratorId,
          input.readerId,
          input.requestId,
          input.readerId,
          nowSeconds,
          input.readerId,
          nowSeconds,
          revision,
        );
      const results = await input.db.batch([lifecycle, audit, deletion]);
      changed = (results[2]?.meta.changes ?? 0) > 0;
    } else {
      const sessionId = await decodeSelector(input.selector, input.cursorSecret);
      if (sessionId === null) {
        await input.db.batch([
          input.db
            .prepare(
              `INSERT INTO identity_event
             (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
             VALUES (?,1,?,?,'administrator',?,'reader',?,'success',?,NULL,json_object('changed',0,'revision',?))`,
            )
            .bind(
              crypto.randomUUID(),
              SESSION_REVOKE_ATTEMPT,
              nowMilliseconds,
              input.administratorId,
              input.readerId,
              input.requestId,
              revision,
            ),
        ]);
        return {
          kind: 'success',
          value: { state: publicState(target), revision, changed: false },
        };
      }
      const activeSession = await input.db
        .prepare('SELECT 1 AS present FROM session WHERE id=? AND user_id=? AND expires_at>?')
        .bind(sessionId, input.readerId, nowSeconds)
        .first<{ present: number }>();
      if (activeSession === null) {
        await input.db
          .prepare(
            `INSERT INTO identity_event
             (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
             VALUES (?,1,? ,?,'administrator',?,'reader',?,'success',?,NULL,json_object('changed',0,'revision',?))`,
          )
          .bind(
            crypto.randomUUID(),
            SESSION_REVOKE_ATTEMPT,
            nowMilliseconds,
            input.administratorId,
            input.readerId,
            input.requestId,
            revision,
          )
          .run();
        return {
          kind: 'success',
          value: { state: publicState(target), revision, changed: false },
        };
      }
      const lifecycle = input.db
        .prepare(
          `INSERT INTO identity_event
         (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
         SELECT ?,1,?,?,'administrator',?,'reader',?,'success',?,NULL,json_object('selector',?,'revision',?)
         WHERE EXISTS (SELECT 1 FROM session WHERE id=? AND user_id=? AND expires_at>?)`,
        )
        .bind(
          crypto.randomUUID(),
          SESSION_REVOKED,
          nowMilliseconds,
          input.administratorId,
          input.readerId,
          input.requestId,
          input.selector,
          revision,
          sessionId,
          input.readerId,
          nowSeconds,
        );
      const deletion = prepareReaderSessionRevocation(input.db, input.readerId, {
        kind: 'manual-one',
        sessionId,
        now: nowMilliseconds,
      });
      const audit = input.db
        .prepare(
          `INSERT INTO identity_event
         (id,version,type,occurred_at,actor_realm,actor_id,subject_realm,subject_id,result,request_id,problem_code,metadata)
         VALUES (?,1,?,?,'administrator',?,'reader',?,'success',?,NULL,
            json_object(
              'changed',json(CASE WHEN EXISTS(SELECT 1 FROM session WHERE id=? AND user_id=? AND expires_at>?) THEN 'true' ELSE 'false' END),
              'revision',?
            ))`,
        )
        .bind(
          crypto.randomUUID(),
          SESSION_REVOKE_ATTEMPT,
          nowMilliseconds,
          input.administratorId,
          input.readerId,
          input.requestId,
          sessionId,
          input.readerId,
          nowSeconds,
          revision,
        );
      const results = await input.db.batch([lifecycle, audit, deletion]);
      changed = (results[2]?.meta.changes ?? 0) > 0;
    }
    return { kind: 'success', value: { state: publicState(target), revision, changed } };
  } catch {
    return { kind: 'internal-error' };
  }
}

export function revokeAdminReaderSession(input: Parameters<typeof revokeReaderSession>[0]) {
  return revokeReaderSession(input);
}

export function revokeAllAdminReaderSessions(
  input: Omit<Parameters<typeof revokeReaderSession>[0], 'selector'>,
) {
  return revokeReaderSession(input);
}
