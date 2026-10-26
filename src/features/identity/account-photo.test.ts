import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import type {
  ExecutionContext,
  FixedLengthStream as FixedLengthStreamType,
  R2Bucket,
  ScheduledController,
} from '@cloudflare/workers-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import worker from '../../index.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env as typeof env & { readonly FILES: R2Bucket };
const fixedLengthStreamGlobal = globalThis as typeof globalThis & {
  readonly FixedLengthStream: new (length: number) => FixedLengthStreamType;
};
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
let failPhotoReferenceResponseAfterCommit = false;
let failAccountDetailsImageResponseAfterCommit = false;
const app = createApp({
  authMailer: mailer,
  accountPhotoReferenceWriter: async (write) => {
    const outcome = await write();
    if (failPhotoReferenceResponseAfterCommit && outcome.kind === 'success') {
      failPhotoReferenceResponseAfterCommit = false;
      return { kind: 'internal-error' };
    }
    return outcome;
  },
  accountDetailsImageUpdater: async (update) => {
    const outcome = await update();
    if (failAccountDetailsImageResponseAfterCommit && outcome.kind === 'success') {
      failAccountDetailsImageResponseAfterCommit = false;
      return { kind: 'internal-error' };
    }
    return outcome;
  },
});
const MAX_ACCOUNT_PHOTO_BYTES = 2 * 1024 * 1024;
const VALID_JPEG = decodeBase64(
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAFR/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9k=',
);
const VALID_PNG = decodeBase64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/Uj8AAAAASUVORK5CYII=',
);
const VALID_WEBP = decodeBase64(
  'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEAAUAmJaQAA3AA/v89WAAAAA==',
).subarray(0, 42);

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    FILES: workerEnv.FILES,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    ...overrides,
  };
}

interface HttpRequestOptions {
  readonly method?: string;
  readonly cookie?: string;
  readonly body?: Uint8Array | string | null;
  readonly headers?: Record<string, string>;
  readonly env?: Partial<Env>;
}

function request(path: string, options: HttpRequestOptions = {}): Promise<Response> {
  return Promise.resolve(
    app.request(
      path,
      {
        method: options.method ?? 'GET',
        headers: {
          ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
          ...(options.headers ?? {}),
        },
        ...(options.body === undefined ? {} : { body: options.body }),
      },
      testEnv(options.env),
    ),
  );
}

function cookieFrom(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined || cookie.length === 0)
    throw new Error('Expected an auth session cookie.');
  return cookie;
}

async function verificationFor(email: string) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const message = mailer.sent.filter((candidate) => candidate.to === email).at(-1);
    if (message !== undefined) return message;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Expected the fixture mailer to capture verification.');
}

async function runPhotoCleanup(files: R2Bucket = workerEnv.FILES): Promise<void> {
  const tasks: Promise<unknown>[] = [];
  worker.scheduled({} as ScheduledController, testEnv({ FILES: files }), {
    waitUntil(task: Promise<unknown>) {
      tasks.push(task);
    },
  } as unknown as ExecutionContext);
  await Promise.all(tasks);
}

async function signedInUser(): Promise<string> {
  const email = `photo-${crypto.randomUUID()}@example.test`;
  const registration = await request('/v2/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: 'Correct-horse-41' }),
  });
  expect(registration.status).toBe(201);
  const verification = await verificationFor(email);
  const token = new URL(verification.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  expect(
    (
      await request('/v1/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(200);
  return cookieFrom(
    await request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-horse-41' }),
    }),
  );
}

async function signedInAdmin(): Promise<string> {
  const email = `admin-photo-${crypto.randomUUID()}@example.test`;
  const bootstrap = await request('/v1/auth/admin/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Photo Admin', email, password: 'Correct-horse-41' }),
  });
  expect(bootstrap.status).toBe(201);
  const verification = await verificationFor(email);
  const token = new URL(verification.url).searchParams.get('token');
  if (token === null) throw new Error('Expected an admin verification token.');
  expect(
    (
      await request('/v1/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
    ).status,
  ).toBe(200);
  return cookieFrom(
    await request('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-horse-41' }),
    }),
  );
}

function decodeBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (byte) => byte.charCodeAt(0));
}

function jpegPayload(size = VALID_JPEG.byteLength): Uint8Array {
  if (size === VALID_JPEG.byteLength) return VALID_JPEG.slice();
  if (size < VALID_JPEG.byteLength) throw new Error('JPEG fixture size is below its minimum.');
  const scanOffset = VALID_JPEG.findIndex(
    (byte, index) => byte === 0xff && VALID_JPEG[index + 1] === 0xda,
  );
  if (scanOffset < 0) throw new Error('JPEG fixture has no start-of-scan marker.');
  const segments: Uint8Array[] = [];
  let remaining = size - VALID_JPEG.byteLength;
  while (remaining > 0) {
    const segmentBytes = Math.min(65_537, remaining);
    if (segmentBytes < 4) throw new Error('JPEG fixture padding cannot fit a marker segment.');
    const segment = new Uint8Array(segmentBytes);
    segment.set([0xff, 0xfe, (segmentBytes - 2) >>> 8, (segmentBytes - 2) & 0xff]);
    segment.fill(0xa5, 4);
    segments.push(segment);
    remaining -= segmentBytes;
  }
  const total = new Uint8Array(size);
  let offset = 0;
  total.set(VALID_JPEG.subarray(0, scanOffset), offset);
  offset += scanOffset;
  for (const segment of segments) {
    total.set(segment, offset);
    offset += segment.byteLength;
  }
  total.set(VALID_JPEG.subarray(scanOffset), offset);
  return total;
}

function withJpegDimensions(width: number, height: number): Uint8Array {
  const bytes = VALID_JPEG.slice();
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  for (let index = 0; index + 8 < bytes.length; index += 1) {
    if (bytes[index] === 0xff && startOfFrameMarkers.has(bytes[index + 1] ?? 0)) {
      bytes[index + 5] = (height >>> 8) & 0xff;
      bytes[index + 6] = height & 0xff;
      bytes[index + 7] = (width >>> 8) & 0xff;
      bytes[index + 8] = width & 0xff;
      return bytes;
    }
  }
  throw new Error('JPEG fixture has no frame header.');
}

function withPngDimensions(width: number, height: number): Uint8Array {
  const bytes = VALID_PNG.slice();
  writeUint32BE(bytes, 16, width);
  writeUint32BE(bytes, 20, height);
  return bytes;
}

function withWebpDimensions(width: number, height: number): Uint8Array {
  const bytes = VALID_WEBP.slice();
  const frameMarker = bytes.findIndex(
    (byte, index) => byte === 0x9d && bytes[index + 1] === 0x01 && bytes[index + 2] === 0x2a,
  );
  if (frameMarker < 0) throw new Error('WebP fixture has no VP8 frame header.');
  writeUint16LE(bytes, frameMarker + 3, width);
  writeUint16LE(bytes, frameMarker + 5, height);
  return bytes;
}

function writeUint16LE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
}

function writeUint32BE(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

function upload(cookie: string, bytes: Uint8Array, contentType = 'image/jpeg'): Promise<Response> {
  return request('/v1/account-photo', {
    method: 'POST',
    cookie,
    body: bytes,
    headers: {
      'content-type': contentType,
      'content-length': String(bytes.byteLength),
    },
  });
}

beforeAll(async () => applyD1Migrations(workerEnv.DB, testMigrations));

describe('Account Photo HTTP boundary', () => {
  it('streams an accepted image into private storage and exposes only its owner-authorized service reference', async () => {
    const cookie = await signedInUser();
    const payload = jpegPayload();
    const uploaded = await upload(cookie, payload);

    expect(uploaded.status).toBe(204);
    expect(uploaded.headers.get('cache-control')).toBe('private, no-store');
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(details.image).toMatch(/^\/v1\/account-photo\/[0-9a-f-]+$/);
    expect(details.image).not.toContain('r2');
    if (details.image === null) throw new Error('Expected the committed photo route.');

    const photo = await request(details.image, { cookie });
    expect(photo.status).toBe(200);
    expect(photo.headers.get('content-type')).toBe('image/jpeg');
    expect(photo.headers.get('cache-control')).toBe('private, no-store');
    expect(photo.headers.get('x-content-type-options')).toBe('nosniff');
    expect(new Uint8Array(await photo.arrayBuffer())).toEqual(payload);

    const otherOwner = await signedInUser();
    expect((await request(details.image, { cookie: otherOwner })).status).toBe(404);
    expect((await request(details.image)).status).toBe(401);
  });

  it('rejects unsupported, mismatched, spoofed, and oversized file content without changing the current photo', async () => {
    const cookie = await signedInUser();
    const original = await upload(cookie, jpegPayload());
    expect(original.status).toBe(204);
    const detailsBefore = await (await request('/v1/account-details', { cookie })).json();

    const mismatched = await upload(cookie, jpegPayload(), 'image/png');
    expect(mismatched.status).toBe(400);
    expect(((await mismatched.json()) as { code: string }).code).toBe('bad-request');
    const svg = await upload(
      cookie,
      new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'),
      'image/svg+xml',
    );
    expect(svg.status).toBe(400);
    const html = await upload(
      cookie,
      new TextEncoder().encode('<!doctype html><script>alert(1)</script>'),
      'image/png',
    );
    expect(html.status).toBe(400);
    const fakeJpegHeader = await upload(
      cookie,
      new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0, 0, 0, 0, 0, 0]),
      'image/jpeg',
    );
    expect(fakeJpegHeader.status).toBe(400);
    const fakePngHeader = await upload(
      cookie,
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
      'image/png',
    );
    expect(fakePngHeader.status).toBe(400);
    const fakeWebpHeader = await upload(
      cookie,
      new Uint8Array([0x52, 0x49, 0x46, 0x46, 4, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]),
      'image/webp',
    );
    expect(fakeWebpHeader.status).toBe(400);

    expect((await upload(cookie, jpegPayload(MAX_ACCOUNT_PHOTO_BYTES))).status).toBe(204);
    const detailsAtLimit = await (await request('/v1/account-details', { cookie })).json();
    const oversizedPayload = jpegPayload(MAX_ACCOUNT_PHOTO_BYTES + 1);
    const oversized = await upload(cookie, oversizedPayload);
    expect(oversized.status).toBe(413);
    expect(await (await request('/v1/account-details', { cookie })).json()).toEqual(detailsAtLimit);
    expect(detailsAtLimit).not.toEqual(detailsBefore);
  });

  it('rejects compact valid-container headers with excessive dimensions or pixel area for all formats', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, VALID_JPEG)).status).toBe(204);
    const oversizedDimensions = [
      [withJpegDimensions(8193, 1), 'image/jpeg'],
      [withJpegDimensions(7000, 7000), 'image/jpeg'],
      [withPngDimensions(8193, 1), 'image/png'],
      [withPngDimensions(7000, 7000), 'image/png'],
      [withWebpDimensions(8193, 1), 'image/webp'],
      [withWebpDimensions(7000, 7000), 'image/webp'],
    ] as const;
    for (const [bytes, mediaType] of oversizedDimensions) {
      expect((await upload(cookie, bytes, mediaType)).status).toBe(400);
    }
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    expect((await request(details.image, { cookie })).status).toBe(200);
  });

  it('aborts the R2 stream on structural corruption discovered after streaming begins', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const before = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const corrupted = VALID_PNG.slice();
    const iend = corrupted.findIndex(
      (byte, index) =>
        byte === 0x49 &&
        corrupted[index + 1] === 0x45 &&
        corrupted[index + 2] === 0x4e &&
        corrupted[index + 3] === 0x44,
    );
    if (iend < 0) throw new Error('PNG fixture has no IEND chunk.');
    corrupted[iend] = 0x58;

    let receivedBytes = 0;
    const filesWithObservedStream = {
      ...workerEnv.FILES,
      put: async (_key: string, value: Parameters<R2Bucket['put']>[1]) => {
        if (typeof value !== 'object' || value === null || !('getReader' in value)) {
          throw new Error('Expected a streamed R2 upload.');
        }
        const reader = (value as unknown as ReadableStream<Uint8Array>).getReader();
        try {
          for (;;) {
            const next = await reader.read();
            if (next.done) break;
            receivedBytes += next.value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }
        throw new Error('Corrupt stream unexpectedly completed.');
      },
    };
    const chunks = [corrupted.subarray(0, 12), corrupted.subarray(12, 40), corrupted.subarray(40)];
    let chunkIndex = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        const chunk = chunks[chunkIndex++];
        if (chunk === undefined) controller.close();
        else controller.enqueue(chunk);
      },
    });
    const response = await app.request(
      '/v1/account-photo',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'image/png',
          'content-length': String(corrupted.byteLength),
        },
        body,
      },
      testEnv({ FILES: filesWithObservedStream }),
    );

    expect(response.status).toBe(400);
    expect(receivedBytes).toBeLessThan(corrupted.byteLength);
    const after = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    expect(after.image).toBe(before.image);
    expect((await request(before.image, { cookie })).status).toBe(200);
  });

  it('replaces and removes photos through the owner session and does not expose an absent object', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const firstDetails = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };

    const png = VALID_PNG;
    expect((await upload(cookie, png, 'image/png')).status).toBe(204);
    const secondDetails = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    expect(secondDetails.image).not.toBe(firstDetails.image);
    expect((await request(firstDetails.image, { cookie })).status).toBe(404);
    expect((await request(secondDetails.image, { cookie })).status).toBe(200);

    const webp = VALID_WEBP;
    expect((await upload(cookie, webp, 'image/webp')).status).toBe(204);
    const thirdDetails = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const webpPhoto = await request(thirdDetails.image, { cookie });
    expect(webpPhoto.status).toBe(200);
    expect(webpPhoto.headers.get('content-type')).toBe('image/webp');
    expect(new Uint8Array(await webpPhoto.arrayBuffer())).toEqual(webp);

    expect((await request('/v1/account-photo', { method: 'DELETE', cookie })).status).toBe(204);
    const cleared = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(cleared.image).toBeNull();
    expect((await request(thirdDetails.image, { cookie })).status).toBe(404);
    expect((await request('/v1/account-photo', { method: 'DELETE', cookie })).status).toBe(204);
  });

  it('returns a safe not-found problem if the current reference points at a missing R2 object', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const photoId = details.image.split('/').at(-1);
    if (photoId === undefined) throw new Error('Expected an opaque photo reference.');
    const currentUser = (await (await request('/v1/me', { cookie })).json()) as { id: string };
    const key = await workerEnv.DB.prepare(
      'SELECT object_key FROM "user_photo" WHERE photo_id = ?1 AND user_id = ?2',
    )
      .bind(photoId, currentUser.id)
      .first<{ object_key: string }>();
    if (key === null) throw new Error('Expected the private object row.');
    await workerEnv.FILES.delete(key.object_key);

    const missing = await request(details.image, { cookie });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('content-type')).toContain('application/problem+json');
    expect(((await missing.json()) as { code: string }).code).toBe('not-found');
    const hiddenMissing = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(hiddenMissing.image).toBeNull();
  });

  it('does not grant photo access or reference mutations to an Administrator', async () => {
    const ownerCookie = await signedInUser();
    expect((await upload(ownerCookie, jpegPayload())).status).toBe(204);
    const owner = (await (await request('/v1/me', { cookie: ownerCookie })).json()) as {
      id: string;
    };
    const account = (await (
      await request('/v1/account-details', { cookie: ownerCookie })
    ).json()) as { image: string };
    const administratorCookie = await signedInAdmin();

    const privatePhoto = await request(account.image, { cookie: administratorCookie });
    expect(privatePhoto.status).toBe(404);
    const adminPatch = await request(
      `/v1/admin/users/${encodeURIComponent(owner.id)}/account-details`,
      {
        method: 'PATCH',
        cookie: administratorCookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: null }),
      },
    );
    expect(adminPatch.status).toBe(400);
    expect((await request(account.image, { cookie: ownerCookie })).status).toBe(200);
  });

  it('serializes concurrent replacements and profile edits without losing the referenced object', async () => {
    const cookie = await signedInUser();
    const [first, second, edit, imageEdit] = await Promise.all([
      upload(cookie, jpegPayload()),
      upload(cookie, VALID_PNG, 'image/png'),
      request('/v1/account-details', {
        method: 'PATCH',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ firstName: 'Concurrent edit' }),
      }),
      request('/v1/account-details', {
        method: 'PATCH',
        cookie,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ image: null }),
      }),
    ]);
    expect([first.status, second.status].every((status) => status === 204 || status === 409)).toBe(
      true,
    );
    expect(edit.status).toBe(204);
    expect([204, 409]).toContain(imageEdit.status);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
      firstName: string;
    };
    expect(details.firstName).toBe('Concurrent edit');
    if (details.image !== null) {
      expect(details.image).toMatch(/^\/v1\/account-photo\//);
      expect((await request(details.image, { cookie })).status).toBe(200);
    }
  });

  it('enforces exact browser origins and credentialed CORS for photo writes', async () => {
    const cookie = await signedInUser();
    const allowedOrigin = 'https://consumer.example.test';
    const denied = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: jpegPayload(),
      headers: {
        'content-type': 'image/jpeg',
        'content-length': '16',
        origin: 'https://attacker.example.test',
        'sec-fetch-site': 'cross-site',
      },
      env: { AUTH_CONSUMER_ORIGINS: allowedOrigin },
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await request('/v1/account-photo', {
      method: 'OPTIONS',
      headers: {
        origin: allowedOrigin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
      env: { AUTH_CONSUMER_ORIGINS: allowedOrigin },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(preflight.headers.get('access-control-allow-credentials')).toBe('true');

    const deletePreflight = await request('/v1/account-photo', {
      method: 'OPTIONS',
      headers: {
        origin: allowedOrigin,
        'access-control-request-method': 'DELETE',
      },
      env: { AUTH_CONSUMER_ORIGINS: allowedOrigin },
    });
    expect(deletePreflight.status).toBe(204);
    expect(deletePreflight.headers.get('access-control-allow-methods')).toContain('DELETE');

    const approvedBytes = jpegPayload();
    const approvedUpload = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: approvedBytes,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(approvedBytes.byteLength),
        origin: allowedOrigin,
        'sec-fetch-site': 'cross-site',
      },
      env: { AUTH_CONSUMER_ORIGINS: allowedOrigin },
    });
    expect(approvedUpload.status).toBe(204);
    expect(approvedUpload.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(approvedUpload.headers.get('access-control-allow-credentials')).toBe('true');
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const corsRead = await request(details.image, {
      cookie,
      headers: { origin: allowedOrigin },
      env: { AUTH_CONSUMER_ORIGINS: allowedOrigin },
    });
    expect(corsRead.status).toBe(200);
    expect(corsRead.headers.get('access-control-allow-origin')).toBe(allowedOrigin);
    expect(corsRead.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('keeps an old photo reference intact when D1 fails before replacement commit', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const before = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    await workerEnv.DB.prepare(
      "CREATE TRIGGER fail_staged_photo_cleanup BEFORE INSERT ON user_photo_cleanup WHEN NEW.state = 'staged' BEGIN SELECT RAISE(ABORT, 'injected D1 failure'); END",
    ).run();
    try {
      const replacement = await upload(cookie, VALID_PNG, 'image/png');
      expect(replacement.status).toBe(503);
      const after = (await (await request('/v1/account-details', { cookie })).json()) as {
        image: string;
      };
      expect(after.image).toBe(before.image);
      expect((await request(before.image, { cookie })).status).toBe(200);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_staged_photo_cleanup').run();
    }
  });

  it('returns success when Better Auth commits the reference but D1 finalization is temporarily unavailable', async () => {
    const cookie = await signedInUser();
    await workerEnv.DB.prepare(
      "CREATE TRIGGER fail_photo_activation BEFORE UPDATE OF state ON user_photo WHEN NEW.state = 'current' BEGIN SELECT RAISE(ABORT, 'injected D1 finalization failure'); END",
    ).run();
    try {
      const uploaded = await upload(cookie, jpegPayload());
      expect(uploaded.status).toBe(204);
      const details = (await (await request('/v1/account-details', { cookie })).json()) as {
        image: string;
      };
      expect(details.image).toMatch(/^\/v1\/account-photo\//);
      expect((await request(details.image, { cookie })).status).toBe(200);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_photo_activation').run();
    }
  });

  it('reconciles a remove whose Better Auth response fails after the user image update committed', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    failPhotoReferenceResponseAfterCommit = true;
    const removed = await request('/v1/account-photo', { method: 'DELETE', cookie });
    expect(removed.status).toBe(204);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(details.image).toBeNull();
  });

  it('returns the committed Account Details image clear after Better Auth response failure', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const before = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const { id: userId } = (await (await request('/v1/me', { cookie })).json()) as { id: string };
    const photoId = before.image.split('/').at(-1);
    if (photoId === undefined) throw new Error('Expected a saved Account Photo reference.');
    const storedObject = await workerEnv.DB.prepare(
      'SELECT object_key FROM "user_photo" WHERE user_id = ?1 AND photo_id = ?2',
    )
      .bind(userId, photoId)
      .first<{ object_key: string }>();
    if (storedObject === null) throw new Error('Expected the private object metadata.');
    failAccountDetailsImageResponseAfterCommit = true;
    const cleared = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image: null }),
    });
    expect(cleared.status).toBe(204);
    const after = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(after.image).toBeNull();
    expect((await request(before.image, { cookie })).status).toBe(404);
    await runPhotoCleanup();
    expect(await workerEnv.FILES.get(storedObject.object_key)).toBeNull();
  });

  it('keeps failed R2 deletion durable and retries cleanup from the Worker scheduled event', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    const failingFiles = {
      ...workerEnv.FILES,
      delete: () => Promise.reject(new Error('injected R2 failure')),
    } as R2Bucket;
    const removed = await request('/v1/account-photo', {
      method: 'DELETE',
      cookie,
      env: { FILES: failingFiles },
    });
    expect(removed.status).toBe(204);
    const cleared = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(cleared.image).toBeNull();

    await runPhotoCleanup();
    expect((await request(details.image, { cookie })).status).toBe(404);
  });

  it('recovers interrupted R2 intents, respects live upload locks, and reconciles an already referenced photo', async () => {
    const cookie = await signedInUser();
    const { id: userId } = (await (await request('/v1/me', { cookie })).json()) as { id: string };
    const createdAt = Date.now() - 61 * 60 * 1000;
    const insertPhotoIntent = async (photoId: string, objectKey: string) =>
      workerEnv.DB.prepare(
        "INSERT INTO \"user_photo\" (photo_id, user_id, object_key, content_type, byte_length, state, created_at) VALUES (?1, ?2, ?3, 'image/jpeg', ?4, 'uploading', ?5)",
      )
        .bind(photoId, userId, objectKey, VALID_JPEG.byteLength, createdAt)
        .run();
    const putFixture = (key: string) =>
      workerEnv.FILES.put(key, VALID_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });

    const interruptedId = crypto.randomUUID();
    const interruptedKey = `account-photos/${crypto.randomUUID()}`;
    await putFixture(interruptedKey);
    await insertPhotoIntent(interruptedId, interruptedKey);
    await runPhotoCleanup();
    expect(await workerEnv.FILES.get(interruptedKey)).toBeNull();
    expect(
      await workerEnv.DB.prepare('SELECT photo_id FROM "user_photo" WHERE photo_id = ?1')
        .bind(interruptedId)
        .first(),
    ).toBeNull();

    const activeId = crypto.randomUUID();
    const activeKey = `account-photos/${crypto.randomUUID()}`;
    await putFixture(activeKey);
    await insertPhotoIntent(activeId, activeKey);
    await workerEnv.DB.prepare(
      'INSERT INTO "user_photo_lock" (user_id, lock_token, expires_at) VALUES (?1, ?2, ?3)',
    )
      .bind(userId, crypto.randomUUID(), Date.now() + 2 * 60 * 60 * 1000)
      .run();
    await runPhotoCleanup();
    expect(await workerEnv.FILES.get(activeKey)).not.toBeNull();
    await workerEnv.DB.prepare('UPDATE "user_photo_lock" SET expires_at = 0 WHERE user_id = ?1')
      .bind(userId)
      .run();
    await runPhotoCleanup();
    expect(await workerEnv.FILES.get(activeKey)).toBeNull();

    const referencedId = crypto.randomUUID();
    const referencedKey = `account-photos/${crypto.randomUUID()}`;
    await putFixture(referencedKey);
    await insertPhotoIntent(referencedId, referencedKey);
    await workerEnv.DB.prepare('UPDATE "user" SET image = ?1 WHERE id = ?2')
      .bind(`/v1/account-photo/${referencedId}`, userId)
      .run();
    await runPhotoCleanup();
    const repaired = await workerEnv.DB.prepare(
      'SELECT state FROM "user_photo" WHERE photo_id = ?1',
    )
      .bind(referencedId)
      .first<{ state: string }>();
    expect(repaired?.state).toBe('current');
    expect((await request(`/v1/account-photo/${referencedId}`, { cookie })).status).toBe(200);

    let intentVisibleBeforeR2Put = false;
    const filesWithIntentProbe = {
      ...workerEnv.FILES,
      put: async (
        key: string,
        value: Parameters<R2Bucket['put']>[1],
        options?: Parameters<R2Bucket['put']>[2],
      ) => {
        const intent = await workerEnv.DB.prepare(
          'SELECT state FROM "user_photo" WHERE object_key = ?1',
        )
          .bind(key)
          .first<{ state: string }>();
        intentVisibleBeforeR2Put = intent?.state === 'uploading';
        return workerEnv.FILES.put(key, value, options);
      },
      delete: (keys: string | string[]) => workerEnv.FILES.delete(keys),
    };
    const finalUpload = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: VALID_JPEG,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(VALID_JPEG.byteLength),
      },
      env: { FILES: filesWithIntentProbe },
    });
    expect(finalUpload.status).toBe(204);
    expect(intentVisibleBeforeR2Put).toBe(true);
  });

  it('renews the upload fence while R2 is blocked beyond its initial lease', async () => {
    const cookie = await signedInUser();
    let signalPutStarted: () => void = () => undefined;
    let releasePut: () => void = () => undefined;
    const putStarted = new Promise<void>((resolve) => {
      signalPutStarted = resolve;
    });
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    const filesWithSlowPut = {
      ...workerEnv.FILES,
      put: async (
        key: string,
        value: Parameters<R2Bucket['put']>[1],
        options?: Parameters<R2Bucket['put']>[2],
      ) => {
        // Buffer only this tiny fixture so the local R2 binding can be held
        // mid-write after receiving its first byte; production stays streamed.
        if (typeof value !== 'object' || value === null || !('getReader' in value)) {
          throw new Error('Expected a streamed R2 upload in the long-lease test.');
        }
        const reader = (value as unknown as ReadableStream<Uint8Array>).getReader();
        const chunks: Uint8Array[] = [];
        let totalBytes = 0;
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          const chunk = next.value.slice();
          chunks.push(chunk);
          totalBytes += chunk.byteLength;
        }
        const payload = new Uint8Array(totalBytes);
        let offset = 0;
        for (const chunk of chunks) {
          payload.set(chunk, offset);
          offset += chunk.byteLength;
        }
        const fixed = new fixedLengthStreamGlobal.FixedLengthStream(totalBytes);
        const put = workerEnv.FILES.put(key, fixed.readable, options);
        const write = async () => {
          const writer = fixed.writable.getWriter();
          await writer.write(payload.subarray(0, 1));
          signalPutStarted();
          await putGate;
          await writer.write(payload.subarray(1));
          await writer.close();
        };
        const [object] = await Promise.all([put, write()]);
        return object;
      },
    };
    const shortLeaseApp = createApp({
      authMailer: mailer,
      accountPhotoLockTiming: { leaseMs: 60, heartbeatMs: 10 },
    });
    const uploadResponse = shortLeaseApp.request(
      '/v1/account-photo',
      {
        method: 'POST',
        headers: {
          cookie,
          'content-type': 'image/jpeg',
          'content-length': String(VALID_JPEG.byteLength),
        },
        body: VALID_JPEG,
      },
      testEnv({ FILES: filesWithSlowPut }),
    );
    try {
      await putStarted;
      await new Promise((resolve) => setTimeout(resolve, 150));
      await runPhotoCleanup();
      const uploading = await workerEnv.DB.prepare(
        'SELECT photo_id FROM "user_photo" WHERE state = \'uploading\' LIMIT 1',
      ).first<{ photo_id: string }>();
      expect(uploading).not.toBeNull();
    } finally {
      releasePut();
    }
    expect((await uploadResponse).status).toBe(204);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    expect((await request(details.image, { cookie })).status).toBe(200);
  });

  it('does not persist a Better Auth photo reference when the D1 upload intent was removed', async () => {
    const cookie = await signedInUser();
    const uploadedKeys: string[] = [];
    const filesRemovingIntent = {
      ...workerEnv.FILES,
      put: async (
        key: string,
        value: Parameters<R2Bucket['put']>[1],
        options?: Parameters<R2Bucket['put']>[2],
      ) => {
        uploadedKeys.push(key);
        await workerEnv.DB.prepare('DELETE FROM "user_photo" WHERE object_key = ?1')
          .bind(key)
          .run();
        return workerEnv.FILES.put(key, value, options);
      },
      delete: (keys: string | string[]) => workerEnv.FILES.delete(keys),
    };
    const rejected = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: VALID_JPEG,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(VALID_JPEG.byteLength),
      },
      env: { FILES: filesRemovingIntent },
    });
    expect(rejected.status).toBe(409);
    const details = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string | null;
    };
    expect(details.image).toBeNull();
    const uploadedKey = uploadedKeys[0];
    if (uploadedKey === undefined) throw new Error('Expected the fixture R2 put to run.');
    expect(await workerEnv.FILES.get(uploadedKey)).toBeNull();
  });

  it('moves past over 100 poisoned cleanup rows and still processes healthy R2/D1 work', async () => {
    const cookie = await signedInUser();
    const { id: userId } = (await (await request('/v1/me', { cookie })).json()) as { id: string };
    const createdAt = Date.now() - 60_000;
    const entries = [
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `poison-r2-${String(index).padStart(3, '0')}`,
        key: `poison-r2/${String(index).padStart(3, '0')}`,
      })),
      ...Array.from({ length: 60 }, (_, index) => ({
        id: `poison-d1-${String(index).padStart(3, '0')}`,
        key: `poison-d1/${String(index).padStart(3, '0')}`,
      })),
    ];
    for (const [index, entry] of entries.entries()) {
      await workerEnv.DB.prepare(
        'INSERT INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, state, created_at) VALUES (?1, ?2, ?3, \'pending\', ?4)',
      )
        .bind(entry.id, userId, entry.key, createdAt + index)
        .run();
    }
    const healthyKey = `account-photos/${crypto.randomUUID()}`;
    await workerEnv.FILES.put(healthyKey, VALID_JPEG, {
      httpMetadata: { contentType: 'image/jpeg' },
    });
    await workerEnv.DB.prepare(
      'INSERT INTO "user_photo_cleanup" (cleanup_id, user_id, object_key, state, created_at) VALUES (?1, ?2, ?3, \'pending\', ?4)',
    )
      .bind('healthy-cleanup', userId, healthyKey, createdAt + entries.length)
      .run();
    await workerEnv.DB.prepare(
      "CREATE TRIGGER fail_poisoned_cleanup BEFORE DELETE ON user_photo_cleanup WHEN OLD.cleanup_id LIKE 'poison-d1-%' BEGIN SELECT RAISE(ABORT, 'injected row-specific D1 cleanup failure'); END",
    ).run();
    const filesWithPoisonedDeletes = {
      ...workerEnv.FILES,
      delete: (keys: string | string[]) => {
        const requested = Array.isArray(keys) ? keys : [keys];
        if (requested.some((key) => key.startsWith('poison-r2/'))) {
          return Promise.reject(new Error('injected row-specific R2 cleanup failure'));
        }
        return workerEnv.FILES.delete(keys);
      },
    };
    try {
      await runPhotoCleanup(filesWithPoisonedDeletes);
      expect(await workerEnv.FILES.get(healthyKey)).toBeNull();
      expect(
        await workerEnv.DB.prepare(
          'SELECT cleanup_id FROM "user_photo_cleanup" WHERE cleanup_id = ?1',
        )
          .bind('healthy-cleanup')
          .first(),
      ).toBeNull();
      expect(
        await workerEnv.DB.prepare(
          'SELECT COUNT(*) AS count FROM "user_photo_cleanup" WHERE cleanup_id LIKE \'poison-%\' AND next_attempt_at > ?1',
        )
          .bind(Date.now())
          .first<{ count: number }>(),
      ).toMatchObject({ count: 120 });
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER fail_poisoned_cleanup').run();
    }
  });

  it('keeps the Worker operational when the optional R2 binding is not configured', async () => {
    const cookie = await signedInUser();
    const bytes = jpegPayload();
    const unavailable = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: bytes,
      headers: {
        'content-type': 'image/jpeg',
        'content-length': String(bytes.byteLength),
      },
      env: { FILES: undefined },
    });
    expect(unavailable.status).toBe(503);
    expect(((await unavailable.json()) as { code: string }).code).toBe('service-unavailable');
  });
});
