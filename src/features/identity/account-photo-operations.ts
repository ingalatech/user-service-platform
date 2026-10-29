import type {
  D1Database,
  FixedLengthStream as FixedLengthStreamType,
  R2Bucket,
} from '@cloudflare/workers-types';
import { createAccountPhotoStructureValidator } from './account-photo-structure.js';
import type { IdentityRuntime } from './identity-runtime.js';

export const MAX_ACCOUNT_PHOTO_BYTES = 2 * 1024 * 1024;
const PHOTO_KEY_PREFIX = 'account-photos/';
const PHOTO_LOCK_TTL_MS = 60 * 60 * 1000;
const STAGED_CLEANUP_GRACE_MS = PHOTO_LOCK_TTL_MS;
const PHOTO_CLEANUP_PAGE_SIZE = 100;
const PHOTO_CLEANUP_MAX_PER_RUN = 500;
const PHOTO_CLEANUP_RETRY_BASE_MS = 60 * 1000;
const PHOTO_CLEANUP_RETRY_MAX_MS = 15 * 60 * 1000;
const PHOTO_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

type PhotoFailure =
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'payload-too-large' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'service-unavailable' }
  | { readonly kind: 'internal-error' };

export type AccountPhotoUploadOutcome =
  { readonly kind: 'success'; readonly cookies: readonly string[] } | PhotoFailure;

export type AccountPhotoReadOutcome =
  | {
      readonly kind: 'success';
      readonly body: ReadableStream<Uint8Array>;
      readonly contentType: string;
      readonly byteLength: number;
    }
  | PhotoFailure;

export type AccountPhotoRemoveOutcome =
  { readonly kind: 'success'; readonly cookies: readonly string[] } | PhotoFailure;

export type AccountPhotoReferenceWriteOutcome =
  | { readonly kind: 'success'; readonly cookies: readonly string[] }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'internal-error' };

export type AccountPhotoReferenceWriter = (
  write: () => Promise<AccountPhotoReferenceWriteOutcome>,
) => Promise<AccountPhotoReferenceWriteOutcome>;

export interface AccountPhotoLockTiming {
  readonly leaseMs: number;
  readonly heartbeatMs: number;
}

interface PhotoOperationsInput {
  readonly runtime: IdentityRuntime;
  readonly db: D1Database;
  readonly files?: R2Bucket;
  readonly background?: (task: Promise<unknown>) => void;
  readonly referenceWriter?: AccountPhotoReferenceWriter;
  readonly lockTiming?: AccountPhotoLockTiming;
}

interface PhotoReference {
  readonly photoId: string;
  readonly value: string;
}

interface StoredPhoto {
  readonly photo_id: string;
  readonly user_id: string;
  readonly object_key: string;
  readonly content_type: string;
  readonly byte_length: number;
  readonly state: string;
}

interface PhotoSession {
  readonly userId: string;
  readonly image: string | null;
}

interface PhotoLock {
  readonly userId: string;
  readonly token: string;
}

interface PhotoCleanupRow {
  readonly cleanup_id: string;
  readonly user_id: string;
  readonly object_key: string;
  readonly photo_id: string | null;
  readonly source_photo_id: string | null;
  readonly replacement_photo_id: string | null;
  readonly state: 'staged' | 'pending' | 'orphan';
  readonly created_at: number;
  readonly attempt_count: number;
  readonly next_attempt_at: number;
}

class PayloadTooLargeError extends Error {
  constructor() {
    super('Account photo is larger than the permitted size.');
    this.name = 'PayloadTooLargeError';
  }
}

function cleanupRetryAt(attemptCount: number, now: number): number {
  const exponent = Math.min(attemptCount, 4);
  return now + Math.min(PHOTO_CLEANUP_RETRY_BASE_MS * 2 ** exponent, PHOTO_CLEANUP_RETRY_MAX_MS);
}

const fixedLengthStreamGlobal = globalThis as typeof globalThis & {
  readonly FixedLengthStream: new (length: number) => FixedLengthStreamType;
};

function photoReference(photoId: string): string {
  return `/v1/account-photo/${photoId}`;
}

function readPhotoReference(value: string | null): PhotoReference | null {
  if (value === null) return null;
  const match = /^\/v1\/account-photo\/([^/]+)$/.exec(value);
  const photoId = match?.[1];
  if (photoId === undefined || !PHOTO_ID_PATTERN.test(photoId)) return null;
  return { photoId, value };
}

function isImageMagic(bytes: Uint8Array, contentType: string): boolean {
  if (contentType === 'image/jpeg') {
    return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  }
  if (contentType === 'image/png') {
    return (
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  }
  return (
    contentType === 'image/webp' &&
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === 'RIFF' &&
    ascii(bytes, 8, 12) === 'WEBP'
  );
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let value = '';
  for (let index = start; index < end; index += 1) {
    value += String.fromCharCode(bytes[index] ?? 0);
  }
  return value;
}

function parseContentLength(value: string | null): number | undefined | null {
  if (value === null) return undefined;
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

async function boundedImageStream(
  body: ReadableStream<Uint8Array> | null,
  rawContentType: string | undefined,
  rawContentLength: string | undefined,
): Promise<
  | {
      readonly stream: ReadableStream<Uint8Array>;
      readonly contentType: string;
      readonly contentLength: number;
      readonly validation: { payloadTooLarge: boolean; invalidStructure: boolean };
    }
  | PhotoFailure
> {
  const contentType = (rawContentType ?? '').split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (!MEDIA_TYPES.has(contentType) || body === null) return { kind: 'bad-request' };
  const contentLength = parseContentLength(rawContentLength ?? null);
  if (contentLength === null) return { kind: 'bad-request' };
  if (contentLength === undefined) return { kind: 'bad-request' };
  if (contentLength > MAX_ACCOUNT_PHOTO_BYTES) {
    return { kind: 'payload-too-large' };
  }

  const reader = body.getReader();
  const signature = new Uint8Array(12);
  const initial: Uint8Array[] = [];
  let signatureLength = 0;
  let initialLength = 0;
  let ended = false;
  try {
    while (signatureLength < signature.byteLength) {
      const next = await reader.read();
      if (next.done) {
        ended = true;
        break;
      }
      const chunk = next.value;
      initialLength += chunk.byteLength;
      if (initialLength > MAX_ACCOUNT_PHOTO_BYTES) throw new PayloadTooLargeError();
      const copied = Math.min(signature.byteLength - signatureLength, chunk.byteLength);
      signature.set(chunk.subarray(0, copied), signatureLength);
      signatureLength += copied;
      if (copied < chunk.byteLength) initial.push(chunk.subarray(copied));
    }
    if (!isImageMagic(signature.subarray(0, signatureLength), contentType)) {
      await reader.cancel();
      return { kind: 'bad-request' };
    }
    const validation = { payloadTooLarge: false, invalidStructure: false };
    const validator = createAccountPhotoStructureValidator(contentType, contentLength);
    try {
      validator.write(signature.subarray(0, signatureLength));
      for (const chunk of initial) validator.write(chunk);
    } catch {
      await reader.cancel().catch(() => undefined);
      return { kind: 'bad-request' };
    }
    initial.unshift(signature.subarray(0, signatureLength));
    let totalBytes = initialLength;
    const bounded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const prefix = initial.shift();
        if (prefix !== undefined) {
          controller.enqueue(prefix);
          return;
        }
        if (ended) {
          controller.close();
          return;
        }
        try {
          const next = await reader.read();
          if (next.done) {
            if (!validation.invalidStructure) {
              try {
                validator.finish();
              } catch {
                validation.invalidStructure = true;
                controller.error(new Error('Invalid account photo structure.'));
                return;
              }
            }
            ended = true;
            controller.close();
            return;
          }
          totalBytes += next.value.byteLength;
          if (totalBytes > MAX_ACCOUNT_PHOTO_BYTES) {
            validation.payloadTooLarge = true;
            await reader.cancel();
            controller.error(new PayloadTooLargeError());
            return;
          }
          try {
            if (!validation.invalidStructure) validator.write(next.value);
          } catch {
            validation.invalidStructure = true;
            await reader.cancel().catch(() => undefined);
            controller.error(new Error('Invalid account photo structure.'));
            return;
          }
          controller.enqueue(next.value);
        } catch (error) {
          controller.error(error);
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
      },
    });
    return { stream: bounded, contentType, contentLength, validation };
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    return error instanceof PayloadTooLargeError
      ? { kind: 'payload-too-large' }
      : { kind: 'bad-request' };
  }
}

async function accountSession(
  runtime: IdentityRuntime,
  headers: Headers,
): Promise<PhotoSession | null> {
  try {
    const identity = await runtime.resolveSessionContext(headers);
    if (identity === null) return null;
    const result = await runtime.authentication().api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    return result === null
      ? null
      : result.user.id !== identity.user.id
        ? null
        : {
            userId: result.user.id,
            image: typeof result.user.image === 'string' ? result.user.image : null,
          };
  } catch {
    return null;
  }
}

async function acquirePhotoLock(
  db: D1Database,
  userId: string,
  leaseMs = PHOTO_LOCK_TTL_MS,
): Promise<PhotoLock | null> {
  const token = crypto.randomUUID();
  const now = Date.now();
  const result = await db
    .prepare(
      'INSERT INTO "user_photo_lock" (user_id, lock_token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET lock_token = excluded.lock_token, expires_at = excluded.expires_at WHERE "user_photo_lock".expires_at <= ?4',
    )
    .bind(userId, token, now + leaseMs, now)
    .run();
  return result.meta.changes === 1 ? { userId, token } : null;
}

async function renewPhotoLock(db: D1Database, lock: PhotoLock, leaseMs: number): Promise<boolean> {
  const now = Date.now();
  const result = await db
    .prepare(
      'UPDATE "user_photo_lock" SET expires_at = ?1 WHERE user_id = ?2 AND lock_token = ?3 AND expires_at > ?4',
    )
    .bind(now + leaseMs, lock.userId, lock.token, now)
    .run();
  return result.meta.changes === 1;
}

function photoLockStillOwned(db: D1Database, lock: PhotoLock): Promise<boolean> {
  return db
    .prepare(
      'SELECT lock_token FROM "user_photo_lock" WHERE user_id = ?1 AND lock_token = ?2 AND expires_at > ?3',
    )
    .bind(lock.userId, lock.token, Date.now())
    .first<{ lock_token: string }>()
    .then((row) => row !== null)
    .catch(() => false);
}

function startPhotoLockHeartbeat(
  db: D1Database,
  lock: PhotoLock,
  timing: AccountPhotoLockTiming,
  onLost: () => void,
): { readonly isLost: () => boolean; readonly stop: () => Promise<void> } {
  let stopped = false;
  let lost = false;
  let running = false;
  let heartbeat = Promise.resolve();
  const timer = setInterval(() => {
    if (stopped || lost || running) return;
    running = true;
    heartbeat = renewPhotoLock(db, lock, timing.leaseMs)
      .then((renewed) => {
        if (!renewed) {
          lost = true;
          onLost();
        }
      })
      .catch(() => {
        lost = true;
        onLost();
      })
      .finally(() => {
        running = false;
      });
  }, timing.heartbeatMs);
  return {
    isLost: () => lost,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await heartbeat;
    },
  };
}

async function releasePhotoLock(db: D1Database, lock: PhotoLock): Promise<void> {
  await db
    .prepare('DELETE FROM "user_photo_lock" WHERE user_id = ?1 AND lock_token = ?2')
    .bind(lock.userId, lock.token)
    .run();
}

async function currentStoredPhoto(
  db: D1Database,
  userId: string,
  photoId: string,
): Promise<StoredPhoto | null> {
  return db
    .prepare(
      'SELECT photo_id, user_id, object_key, content_type, byte_length, state FROM "user_photo" WHERE user_id = ?1 AND photo_id = ?2',
    )
    .bind(userId, photoId)
    .first<StoredPhoto>();
}

function scheduleCleanup(input: PhotoOperationsInput): void {
  if (input.files === undefined) return;
  const task = retryAccountPhotoCleanup(input.db, input.files).catch(() => undefined);
  try {
    input.background?.(task);
  } catch {
    task.catch(() => undefined);
  }
}

async function insertOrphanCleanup(
  db: D1Database,
  userId: string,
  photoId: string,
  objectKey: string,
): Promise<void> {
  await db
    .prepare(
      'INSERT OR IGNORE INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, photo_id, source_photo_id, replacement_photo_id, state, created_at) VALUES (?1, ?2, ?3, ?4, NULL, ?4, \'orphan\', ?5)',
    )
    .bind(crypto.randomUUID(), userId, objectKey, photoId, Date.now())
    .run();
}

async function deleteStagedObject(input: {
  readonly db: D1Database;
  readonly files: R2Bucket;
  readonly userId: string;
  readonly photoId: string;
  readonly objectKey: string;
}): Promise<void> {
  try {
    await input.files.delete(input.objectKey);
    await input.db
      .prepare('DELETE FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2')
      .bind(input.photoId, input.userId)
      .run();
  } catch {
    try {
      await insertOrphanCleanup(input.db, input.userId, input.photoId, input.objectKey);
    } catch {
      // Never log a key. If D1 itself is unavailable, the failed API response
      // and the still-private random R2 key are safer than exposing it.
    }
  }
}

async function activatePhotoReference(
  db: D1Database,
  userId: string,
  photoId: string,
): Promise<void> {
  await db.batch([
    db
      .prepare('UPDATE "user_photo" SET state = \'current\' WHERE photo_id = ?1 AND user_id = ?2')
      .bind(photoId, userId),
    db
      .prepare(
        "UPDATE \"user_photo_cleanup\" SET state = 'pending' WHERE user_id = ?1 AND replacement_photo_id = ?2 AND state = 'staged'",
      )
      .bind(userId, photoId),
  ]);
}

async function cancelPhotoCleanupCandidate(
  db: D1Database,
  userId: string,
  replacementPhotoId: string,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM "user_photo_cleanup" WHERE user_id = ?1 AND replacement_photo_id = ?2 AND state = \'staged\'',
    )
    .bind(userId, replacementPhotoId)
    .run();
}

async function cancelPhotoCleanupForSource(
  db: D1Database,
  userId: string,
  sourcePhotoId: string,
): Promise<void> {
  await db
    .prepare(
      'DELETE FROM "user_photo_cleanup" WHERE user_id = ?1 AND source_photo_id = ?2 AND state = \'staged\'',
    )
    .bind(userId, sourcePhotoId)
    .run();
}

async function persistPhotoReference(input: {
  readonly db: D1Database;
  readonly lock: PhotoLock;
  readonly expectedImage: string | null;
  readonly image: string | null;
}): Promise<AccountPhotoReferenceWriteOutcome> {
  const now = Date.now();
  const updated = await input.db
    .prepare(
      'UPDATE "user" SET image = ?1, updated_at = ?2 WHERE id = ?3 AND image IS ?4 AND EXISTS (SELECT 1 FROM "user_photo_lock" WHERE user_id = ?3 AND lock_token = ?5 AND expires_at > ?6)',
    )
    .bind(
      input.image,
      Math.floor(now / 1000),
      input.lock.userId,
      input.expectedImage,
      input.lock.token,
      now,
    )
    .run();
  if (updated.meta.changes !== 1) return { kind: 'conflict' };

  const persisted = await input.db
    .prepare('SELECT image FROM "user" WHERE id = ?1')
    .bind(input.lock.userId)
    .first<{ image: string | null }>();
  if (persisted === null) return { kind: 'internal-error' };
  if (persisted.image !== input.image) return { kind: 'conflict' };
  return { kind: 'success', cookies: [] };
}

async function writePhotoReference(
  input: PhotoOperationsInput,
  lock: PhotoLock,
  expectedImage: string | null,
  image: string | null,
): Promise<AccountPhotoReferenceWriteOutcome> {
  const write = () => persistPhotoReference({ db: input.db, lock, expectedImage, image });
  try {
    return input.referenceWriter === undefined ? await write() : await input.referenceWriter(write);
  } catch {
    return { kind: 'internal-error' };
  }
}

export function createAccountPhotoOperations(input: PhotoOperationsInput) {
  async function upload(
    headers: Headers,
    body: ReadableStream<Uint8Array> | null,
    contentType: string | undefined,
    contentLength: string | undefined,
  ): Promise<AccountPhotoUploadOutcome> {
    const initialSession = await accountSession(input.runtime, headers);
    if (initialSession === null) return { kind: 'unauthenticated' };
    if (input.files === undefined) return { kind: 'service-unavailable' };

    const uploadAbort = new AbortController();
    const prepared = await boundedImageStream(body, contentType, contentLength);
    if ('kind' in prepared) return prepared;

    const photoId = crypto.randomUUID();
    const objectKey = `${PHOTO_KEY_PREFIX}${crypto.randomUUID()}`;
    const lockTiming = input.lockTiming ?? {
      leaseMs: PHOTO_LOCK_TTL_MS,
      heartbeatMs: Math.max(1, Math.floor(PHOTO_LOCK_TTL_MS / 3)),
    };
    let lock: PhotoLock | null;
    try {
      lock = await acquirePhotoLock(input.db, initialSession.userId, lockTiming.leaseMs);
    } catch {
      await prepared.stream.cancel().catch(() => undefined);
      return { kind: 'service-unavailable' };
    }
    if (lock === null) {
      await prepared.stream.cancel().catch(() => undefined);
      return { kind: 'conflict' };
    }

    const heartbeat = startPhotoLockHeartbeat(input.db, lock, lockTiming, () => {
      uploadAbort.abort(new Error('Account Photo upload lost its D1 lease.'));
    });
    let intentCreated = false;
    let cleanupCandidateCreated = false;
    try {
      const session = await accountSession(input.runtime, headers);
      if (session?.userId !== initialSession.userId) {
        await prepared.stream.cancel().catch(() => undefined);
        return { kind: 'unauthenticated' };
      }
      const oldReference = readPhotoReference(session.image);
      const oldPhoto =
        oldReference === null
          ? null
          : await currentStoredPhoto(input.db, session.userId, oldReference.photoId);
      if (oldReference !== null && oldPhoto === null) {
        await prepared.stream.cancel().catch(() => undefined);
        return { kind: 'service-unavailable' };
      }
      const statements = [
        input.db
          .prepare(
            'INSERT INTO "user_photo" (photo_id, user_id, object_key, content_type, byte_length, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, \'uploading\', ?6)',
          )
          .bind(
            photoId,
            session.userId,
            objectKey,
            prepared.contentType,
            prepared.contentLength,
            Date.now(),
          ),
      ];
      if (oldPhoto !== null) {
        statements.push(
          input.db
            .prepare(
              'INSERT INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, photo_id, source_photo_id, replacement_photo_id, state, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, \'staged\', ?7)',
            )
            .bind(
              crypto.randomUUID(),
              session.userId,
              oldPhoto.object_key,
              null,
              oldPhoto.photo_id,
              photoId,
              Date.now(),
            ),
        );
      }
      await input.db.batch(statements);
      intentCreated = true;
      cleanupCandidateCreated = oldPhoto !== null;

      let uploadedSize: number;
      try {
        const fixed = new fixedLengthStreamGlobal.FixedLengthStream(prepared.contentLength);
        const transfer = prepared.stream.pipeTo(fixed.writable, { signal: uploadAbort.signal });
        const [putResult, transferResult] = await Promise.allSettled([
          input.files.put(objectKey, fixed.readable, {
            httpMetadata: { contentType: prepared.contentType },
          }),
          transfer,
        ]);
        if (putResult.status === 'rejected') throw putResult.reason;
        if (transferResult.status === 'rejected') throw transferResult.reason;
        uploadedSize = putResult.value.size;
      } catch (error) {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
            () => undefined,
          );
          cleanupCandidateCreated = false;
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return heartbeat.isLost()
          ? { kind: 'conflict' }
          : prepared.validation.invalidStructure
            ? { kind: 'bad-request' }
            : error instanceof PayloadTooLargeError || prepared.validation.payloadTooLarge
              ? { kind: 'payload-too-large' }
              : { kind: 'service-unavailable' };
      }
      if (prepared.validation.invalidStructure) {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
            () => undefined,
          );
          cleanupCandidateCreated = false;
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return { kind: 'bad-request' };
      }
      if (heartbeat.isLost() || !(await photoLockStillOwned(input.db, lock))) {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
            () => undefined,
          );
          cleanupCandidateCreated = false;
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return { kind: 'conflict' };
      }
      try {
        const staged = await input.db
          .prepare(
            "UPDATE \"user_photo\" SET byte_length = ?1, state = 'staged' WHERE photo_id = ?2 AND user_id = ?3 AND state = 'uploading'",
          )
          .bind(uploadedSize, photoId, session.userId)
          .run();
        if (staged.meta.changes !== 1) {
          if (cleanupCandidateCreated) {
            await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
              () => undefined,
            );
            cleanupCandidateCreated = false;
          }
          await deleteStagedObject({
            db: input.db,
            files: input.files,
            userId: session.userId,
            photoId,
            objectKey,
          });
          return { kind: 'conflict' };
        }
      } catch {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
            () => undefined,
          );
          cleanupCandidateCreated = false;
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return { kind: 'service-unavailable' };
      }

      if (heartbeat.isLost() || !(await photoLockStillOwned(input.db, lock))) {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, session.userId, photoId).catch(
            () => undefined,
          );
          cleanupCandidateCreated = false;
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return { kind: 'conflict' };
      }

      const updated = await writePhotoReference(
        input,
        lock,
        session.image,
        photoReference(photoId),
      );
      if (updated.kind !== 'success') {
        let storedImage: string | null | undefined;
        try {
          const user = await input.db
            .prepare('SELECT image FROM "user" WHERE id = ?1')
            .bind(session.userId)
            .first<{ image: string | null }>();
          storedImage = user?.image;
        } catch {
          scheduleCleanup(input);
          return { kind: 'service-unavailable' };
        }
        if (storedImage === photoReference(photoId)) {
          try {
            await activatePhotoReference(input.db, session.userId, photoId);
          } catch {
            // Better Auth committed the image route. Staged D1 metadata and
            // cleanup intent remain durable for the scheduled reconciler.
          }
          scheduleCleanup(input);
          // The engine mutation committed even though cookie response
          // processing failed. Do not report a false error after commit.
          return { kind: 'success', cookies: [] };
        }
        await input.db
          .prepare(
            'DELETE FROM "user_photo_cleanup" WHERE user_id = ?1 AND replacement_photo_id = ?2 AND state = \'staged\'',
          )
          .bind(session.userId, photoId)
          .run();
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: session.userId,
          photoId,
          objectKey,
        });
        return updated;
      }

      try {
        await activatePhotoReference(input.db, session.userId, photoId);
      } catch {
        // Better Auth already persisted the reference. Keep the staged photo
        // and durable cleanup candidate; the scheduled reconciler finalizes it.
      }
      scheduleCleanup(input);
      return { kind: 'success', cookies: updated.cookies };
    } catch {
      if (intentCreated) {
        if (cleanupCandidateCreated) {
          await cancelPhotoCleanupCandidate(input.db, initialSession.userId, photoId).catch(
            () => undefined,
          );
        }
        await deleteStagedObject({
          db: input.db,
          files: input.files,
          userId: initialSession.userId,
          photoId,
          objectKey,
        });
      } else {
        await prepared.stream.cancel().catch(() => undefined);
      }
      return { kind: 'service-unavailable' };
    } finally {
      await heartbeat.stop();
      await releasePhotoLock(input.db, lock).catch(() => undefined);
    }
  }

  async function read(headers: Headers, photoId: string): Promise<AccountPhotoReadOutcome> {
    const session = await accountSession(input.runtime, headers);
    if (session === null) return { kind: 'unauthenticated' };
    const currentReference = readPhotoReference(session.image);
    if (currentReference?.photoId !== photoId) {
      return { kind: 'not-found' };
    }
    if (input.files === undefined) return { kind: 'service-unavailable' };
    try {
      const photo = await currentStoredPhoto(input.db, session.userId, photoId);
      if (photo === null || (photo.state !== 'current' && photo.state !== 'staged')) {
        return { kind: 'not-found' };
      }
      const stored = await input.files.get(photo.object_key);
      if (stored?.body === undefined) {
        return { kind: 'not-found' };
      }
      if (stored.size !== photo.byte_length) return { kind: 'internal-error' };
      return {
        kind: 'success',
        body: stored.body as unknown as ReadableStream<Uint8Array>,
        contentType: photo.content_type,
        byteLength: photo.byte_length,
      };
    } catch {
      return { kind: 'service-unavailable' };
    }
  }

  async function availability(
    headers: Headers,
    reference: string,
  ): Promise<'available' | 'missing' | 'unauthenticated' | 'service-unavailable'> {
    const session = await accountSession(input.runtime, headers);
    if (session === null) return 'unauthenticated';
    const parsed = readPhotoReference(reference);
    if (parsed?.value !== session.image) return 'missing';
    if (input.files === undefined) return 'service-unavailable';
    try {
      const photo = await currentStoredPhoto(input.db, session.userId, parsed.photoId);
      if (photo === null || (photo.state !== 'current' && photo.state !== 'staged')) {
        return 'missing';
      }
      const object = await input.files.head(photo.object_key);
      if (object === null) return 'missing';
      return object.size === photo.byte_length ? 'available' : 'service-unavailable';
    } catch {
      return 'service-unavailable';
    }
  }

  async function remove(headers: Headers): Promise<AccountPhotoRemoveOutcome> {
    const session = await accountSession(input.runtime, headers);
    if (session === null) return { kind: 'unauthenticated' };
    if (input.files === undefined) return { kind: 'service-unavailable' };

    let lock: PhotoLock | null;
    try {
      lock = await acquirePhotoLock(input.db, session.userId);
    } catch {
      return { kind: 'service-unavailable' };
    }
    if (lock === null) return { kind: 'conflict' };
    try {
      const current = await accountSession(input.runtime, headers);
      if (current?.userId !== session.userId) return { kind: 'unauthenticated' };
      const currentReference = readPhotoReference(current.image);
      const photo =
        currentReference === null
          ? null
          : await currentStoredPhoto(input.db, current.userId, currentReference.photoId);
      if (currentReference !== null && photo === null) {
        return { kind: 'service-unavailable' };
      }
      if (photo !== null) {
        await input.db
          .prepare(
            'INSERT INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, photo_id, source_photo_id, replacement_photo_id, state, created_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, \'staged\', ?5)',
          )
          .bind(crypto.randomUUID(), current.userId, photo.object_key, photo.photo_id, Date.now())
          .run();
      }
      const updated = await writePhotoReference(input, lock, current.image, null);
      if (updated.kind !== 'success') {
        if (updated.kind === 'conflict') {
          scheduleCleanup(input);
          return updated;
        }
        let storedImage: string | null | undefined;
        try {
          const persisted = await input.db
            .prepare('SELECT image FROM "user" WHERE id = ?1')
            .bind(current.userId)
            .first<{ image: string | null }>();
          storedImage = persisted?.image;
        } catch {
          scheduleCleanup(input);
          return { kind: 'service-unavailable' };
        }
        if (storedImage === null) {
          if (photo !== null) {
            try {
              await input.db
                .prepare(
                  "UPDATE \"user_photo_cleanup\" SET state = 'pending' WHERE user_id = ?1 AND source_photo_id = ?2 AND state = 'staged'",
                )
                .bind(current.userId, photo.photo_id)
                .run();
            } catch {
              // The cleanup reconciler recognizes the persisted null image.
            }
          }
          scheduleCleanup(input);
          return { kind: 'success', cookies: [] };
        }
        if (storedImage !== current.image) {
          scheduleCleanup(input);
          return { kind: 'service-unavailable' };
        }
        if (photo !== null) {
          await input.db
            .prepare(
              'DELETE FROM "user_photo_cleanup" WHERE user_id = ?1 AND source_photo_id = ?2 AND state = \'staged\'',
            )
            .bind(current.userId, photo.photo_id)
            .run();
        }
        return updated;
      }
      if (photo !== null) {
        try {
          await input.db
            .prepare(
              "UPDATE \"user_photo_cleanup\" SET state = 'pending' WHERE user_id = ?1 AND source_photo_id = ?2 AND state = 'staged'",
            )
            .bind(current.userId, photo.photo_id)
            .run();
        } catch {
          // The durable staged intent is reconciled after the reference commit.
        }
      }
      scheduleCleanup(input);
      return { kind: 'success', cookies: updated.cookies };
    } catch {
      return { kind: 'service-unavailable' };
    } finally {
      await releasePhotoLock(input.db, lock).catch(() => undefined);
    }
  }

  async function updateAccountDetailsImage<T extends { readonly kind: string }>(
    headers: Headers,
    expectedImage: string | null,
    update: () => Promise<T>,
    targetUserId?: string,
    committedOutcome?: () => Promise<T>,
  ): Promise<
    | T
    | {
        readonly kind:
          'unauthenticated' | 'conflict' | 'service-unavailable' | 'photo-owner-required';
      }
  > {
    const session = await accountSession(input.runtime, headers);
    if (session === null) return { kind: 'unauthenticated' };
    const userId = targetUserId ?? session.userId;
    if (targetUserId !== undefined) {
      const target = await input.db
        .prepare('SELECT id FROM "user" WHERE id = ?1')
        .bind(userId)
        .first<{ id: string }>();
      if (target === null) return update();
    }
    let lock: PhotoLock | null;
    try {
      lock = await acquirePhotoLock(input.db, userId);
    } catch {
      return { kind: 'service-unavailable' };
    }
    if (lock === null) return { kind: 'conflict' };
    try {
      let image: string | null;
      if (targetUserId === undefined) {
        const current = await accountSession(input.runtime, headers);
        if (current?.userId !== session.userId) return { kind: 'unauthenticated' };
        image = current.image;
      } else {
        const current = await input.db
          .prepare('SELECT image FROM "user" WHERE id = ?1')
          .bind(userId)
          .first<{ image: string | null }>();
        if (current === null) return await update();
        image = current.image;
      }
      const oldReference = readPhotoReference(image);
      if (targetUserId !== undefined && oldReference !== null) {
        return { kind: 'photo-owner-required' };
      }
      const oldPhoto =
        oldReference === null
          ? null
          : await currentStoredPhoto(input.db, userId, oldReference.photoId);
      if (oldReference !== null && oldPhoto === null) return { kind: 'service-unavailable' };
      if (oldPhoto !== null && input.files === undefined) return { kind: 'service-unavailable' };
      if (oldPhoto !== null) {
        await input.db
          .prepare(
            'INSERT INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, photo_id, source_photo_id, replacement_photo_id, state, created_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, \'staged\', ?5)',
          )
          .bind(crypto.randomUUID(), userId, oldPhoto.object_key, oldPhoto.photo_id, Date.now())
          .run();
      }
      const outcome = await update();
      if (outcome.kind !== 'success') {
        if (oldPhoto !== null) {
          scheduleCleanup(input);
        }
        let persistedImage: string | null | undefined;
        try {
          const persisted = await input.db
            .prepare('SELECT image FROM "user" WHERE id = ?1')
            .bind(userId)
            .first<{ image: string | null }>();
          persistedImage = persisted?.image;
        } catch {
          scheduleCleanup(input);
          return { kind: 'service-unavailable' };
        }
        if (persistedImage === expectedImage) {
          if (oldPhoto !== null) {
            try {
              await input.db
                .prepare(
                  "UPDATE \"user_photo_cleanup\" SET state = 'pending' WHERE user_id = ?1 AND source_photo_id = ?2 AND state = 'staged'",
                )
                .bind(userId, oldPhoto.photo_id)
                .run();
            } catch {
              // Reconciliation compares the still-durable staged intent with
              // the committed reference on the next scheduled pass.
            }
          }
          scheduleCleanup(input);
          return committedOutcome === undefined ? outcome : await committedOutcome();
        }
        if (oldPhoto !== null && persistedImage === image) {
          await cancelPhotoCleanupForSource(input.db, userId, oldPhoto.photo_id).catch(
            () => undefined,
          );
        }
        return outcome;
      }
      if (oldPhoto !== null) {
        try {
          await input.db
            .prepare(
              "UPDATE \"user_photo_cleanup\" SET state = 'pending' WHERE user_id = ?1 AND source_photo_id = ?2 AND state = 'staged'",
            )
            .bind(userId, oldPhoto.photo_id)
            .run();
        } catch {
          // Preserve the staged cleanup intent for the scheduled reconciler.
        }
      }
      scheduleCleanup(input);
      return outcome;
    } catch {
      return { kind: 'service-unavailable' };
    } finally {
      await releasePhotoLock(input.db, lock).catch(() => undefined);
    }
  }

  return { upload, read, availability, remove, updateAccountDetailsImage };
}

export async function retryAccountPhotoCleanup(
  db: D1Database,
  files: R2Bucket,
  now = Date.now(),
): Promise<void> {
  let processed = 0;
  const graceCutoff = now - STAGED_CLEANUP_GRACE_MS;
  const activeUploadLock = `NOT EXISTS (SELECT 1 FROM "user_photo_lock" AS active_lock WHERE active_lock.user_id = user_photo_cleanup.user_id AND active_lock.expires_at > ?1)`;
  const sourceStillCurrent = `EXISTS (SELECT 1 FROM "user" AS source_user WHERE source_user.id = user_photo_cleanup.user_id AND source_user.image = '/v1/account-photo/' || user_photo_cleanup.source_photo_id)`;
  const replacementIsCurrent = `EXISTS (SELECT 1 FROM "user" AS replacement_user WHERE replacement_user.id = user_photo_cleanup.user_id AND replacement_user.image = '/v1/account-photo/' || user_photo_cleanup.replacement_photo_id)`;
  const eligibleCleanup = `state = 'orphan' OR (state = 'pending' AND (source_photo_id IS NULL OR NOT ${sourceStillCurrent})) OR (state = 'staged' AND (created_at <= ?2 OR (replacement_photo_id IS NOT NULL AND ${replacementIsCurrent}) OR (replacement_photo_id IS NULL AND source_photo_id IS NOT NULL AND NOT ${sourceStillCurrent})))`;

  while (processed < PHOTO_CLEANUP_MAX_PER_RUN) {
    const limit = Math.min(PHOTO_CLEANUP_PAGE_SIZE, PHOTO_CLEANUP_MAX_PER_RUN - processed);
    const page = await db
      .prepare(
        `SELECT cleanup_id, user_id, object_key, photo_id, source_photo_id, replacement_photo_id, state, created_at, attempt_count, next_attempt_at FROM "user_photo_cleanup" WHERE next_attempt_at <= ?1 AND ${activeUploadLock} AND (${eligibleCleanup}) ORDER BY next_attempt_at, created_at, cleanup_id LIMIT ?3`,
      )
      .bind(now, graceCutoff, limit)
      .all<PhotoCleanupRow>();
    if (page.results.length === 0) break;

    for (const job of page.results) {
      processed += 1;
      try {
        await processPhotoCleanupRow(db, files, job);
      } catch {
        await db
          .prepare(
            'UPDATE "user_photo_cleanup" SET attempt_count = attempt_count + 1, next_attempt_at = ?1 WHERE cleanup_id = ?2',
          )
          .bind(cleanupRetryAt(job.attempt_count, now), job.cleanup_id)
          .run()
          .catch(() => undefined);
      }
    }
    if (page.results.length < limit) break;
  }

  processed = 0;
  const activePhotoLock = `NOT EXISTS (SELECT 1 FROM "user_photo_lock" AS active_lock WHERE active_lock.user_id = user_photo.user_id AND active_lock.expires_at > ?1)`;
  const photoReferenceCurrent = `EXISTS (SELECT 1 FROM "user" AS photo_user WHERE photo_user.id = user_photo.user_id AND photo_user.image = '/v1/account-photo/' || user_photo.photo_id)`;
  while (processed < PHOTO_CLEANUP_MAX_PER_RUN) {
    const limit = Math.min(PHOTO_CLEANUP_PAGE_SIZE, PHOTO_CLEANUP_MAX_PER_RUN - processed);
    const photos = await db
      .prepare(
        `SELECT photo_id, user_id, object_key, state, created_at, attempt_count, next_attempt_at FROM "user_photo" WHERE state IN ('uploading', 'staged') AND next_attempt_at <= ?1 AND ${activePhotoLock} AND ((state = 'uploading' AND created_at <= ?2) OR (state = 'staged' AND (created_at <= ?2 OR ${photoReferenceCurrent}))) ORDER BY next_attempt_at, created_at, photo_id LIMIT ?3`,
      )
      .bind(now, graceCutoff, limit)
      .all<{
        readonly photo_id: string;
        readonly user_id: string;
        readonly object_key: string;
        readonly state: 'uploading' | 'staged';
        readonly created_at: number;
        readonly attempt_count: number;
        readonly next_attempt_at: number;
      }>();
    if (photos.results.length === 0) break;

    for (const photo of photos.results) {
      processed += 1;
      try {
        const user = await db
          .prepare('SELECT image FROM "user" WHERE id = ?1')
          .bind(photo.user_id)
          .first<{ image: string | null }>();
        if (readPhotoReference(user?.image ?? null)?.photoId === photo.photo_id) {
          await db
            .prepare(
              'UPDATE "user_photo" SET state = \'current\' WHERE photo_id = ?1 AND user_id = ?2',
            )
            .bind(photo.photo_id, photo.user_id)
            .run();
        } else {
          await files.delete(photo.object_key);
          await db
            .prepare(
              "DELETE FROM \"user_photo\" WHERE photo_id = ?1 AND user_id = ?2 AND state IN ('uploading', 'staged')",
            )
            .bind(photo.photo_id, photo.user_id)
            .run();
        }
      } catch {
        await db
          .prepare(
            'UPDATE "user_photo" SET attempt_count = attempt_count + 1, next_attempt_at = ?1 WHERE photo_id = ?2 AND user_id = ?3',
          )
          .bind(cleanupRetryAt(photo.attempt_count, now), photo.photo_id, photo.user_id)
          .run()
          .catch(() => undefined);
      }
    }
    if (photos.results.length < limit) break;
  }
}

async function processPhotoCleanupRow(
  db: D1Database,
  files: R2Bucket,
  job: PhotoCleanupRow,
): Promise<void> {
  const user = await db
    .prepare('SELECT image FROM "user" WHERE id = ?1')
    .bind(job.user_id)
    .first<{ image: string | null }>();
  const currentReference = readPhotoReference(user?.image ?? null);
  if (job.state === 'orphan') {
    if (currentReference?.photoId === job.replacement_photo_id) {
      await db.batch([
        db
          .prepare(
            'UPDATE "user_photo" SET state = \'current\' WHERE photo_id = ?1 AND user_id = ?2',
          )
          .bind(job.photo_id, job.user_id),
        db.prepare('DELETE FROM "user_photo_cleanup" WHERE cleanup_id = ?1').bind(job.cleanup_id),
      ]);
      return;
    }
    await files.delete(job.object_key);
    await db.batch([
      db
        .prepare('DELETE FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2')
        .bind(job.photo_id, job.user_id),
      db.prepare('DELETE FROM "user_photo_cleanup" WHERE cleanup_id = ?1').bind(job.cleanup_id),
    ]);
    return;
  }

  if (job.state === 'staged') {
    const committed =
      job.replacement_photo_id === null
        ? currentReference?.photoId !== job.source_photo_id
        : currentReference?.photoId === job.replacement_photo_id;
    if (committed) {
      await db.batch([
        ...(job.replacement_photo_id === null
          ? []
          : [
              db
                .prepare(
                  'UPDATE "user_photo" SET state = \'current\' WHERE photo_id = ?1 AND user_id = ?2',
                )
                .bind(job.replacement_photo_id, job.user_id),
            ]),
        db
          .prepare('UPDATE "user_photo_cleanup" SET state = \'pending\' WHERE cleanup_id = ?1')
          .bind(job.cleanup_id),
      ]);
      return;
    }

    if (job.replacement_photo_id !== null) {
      const replacement = await currentStoredPhoto(db, job.user_id, job.replacement_photo_id);
      if (replacement !== null) {
        await files.delete(replacement.object_key);
        await db
          .prepare('DELETE FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2')
          .bind(replacement.photo_id, job.user_id)
          .run();
      }
    }
    if (job.source_photo_id !== null && currentReference?.photoId !== job.source_photo_id) {
      await files.delete(job.object_key);
      await db
        .prepare('DELETE FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2')
        .bind(job.source_photo_id, job.user_id)
        .run();
    }
    await db
      .prepare('DELETE FROM "user_photo_cleanup" WHERE cleanup_id = ?1')
      .bind(job.cleanup_id)
      .run();
    return;
  }

  if (job.source_photo_id !== null && currentReference?.photoId === job.source_photo_id) {
    return;
  }
  await files.delete(job.object_key);
  await db.batch([
    ...(job.source_photo_id === null
      ? []
      : [
          db
            .prepare('DELETE FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2')
            .bind(job.source_photo_id, job.user_id),
        ]),
    db.prepare('DELETE FROM "user_photo_cleanup" WHERE cleanup_id = ?1').bind(job.cleanup_id),
  ]);
}
