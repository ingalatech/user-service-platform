import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import type { ExecutionContext, R2Bucket, ScheduledController } from '@cloudflare/workers-types';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import worker from '../../index.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env as typeof env & { readonly FILES: R2Bucket };
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
const MAX_ACCOUNT_PHOTO_BYTES = 2 * 1024 * 1024;

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

function jpegPayload(size = 16): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  bytes.set([0xff, 0xd9], size - 2);
  return bytes;
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

    expect((await upload(cookie, jpegPayload(MAX_ACCOUNT_PHOTO_BYTES))).status).toBe(204);
    const detailsAtLimit = await (await request('/v1/account-details', { cookie })).json();
    const oversizedPayload = jpegPayload(MAX_ACCOUNT_PHOTO_BYTES + 1);
    const oversized = await upload(cookie, oversizedPayload);
    expect(oversized.status).toBe(413);
    expect(await (await request('/v1/account-details', { cookie })).json()).toEqual(detailsAtLimit);
    expect(detailsAtLimit).not.toEqual(detailsBefore);
  });

  it('replaces and removes photos through the owner session and does not expose an absent object', async () => {
    const cookie = await signedInUser();
    expect((await upload(cookie, jpegPayload())).status).toBe(204);
    const firstDetails = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };

    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    expect((await upload(cookie, png, 'image/png')).status).toBe(204);
    const secondDetails = (await (await request('/v1/account-details', { cookie })).json()) as {
      image: string;
    };
    expect(secondDetails.image).not.toBe(firstDetails.image);
    expect((await request(firstDetails.image, { cookie })).status).toBe(404);
    expect((await request(secondDetails.image, { cookie })).status).toBe(200);

    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
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
      upload(cookie, new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), 'image/png'),
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

    const approvedUpload = await request('/v1/account-photo', {
      method: 'POST',
      cookie,
      body: jpegPayload(),
      headers: {
        'content-type': 'image/jpeg',
        'content-length': '16',
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
      const replacement = await upload(
        cookie,
        new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
        'image/png',
      );
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

    const scheduledTasks: Promise<unknown>[] = [];
    worker.scheduled({} as ScheduledController, testEnv(), {
      waitUntil(task: Promise<unknown>) {
        scheduledTasks.push(task);
      },
    } as unknown as ExecutionContext);
    await Promise.all(scheduledTasks);
    expect((await request(details.image, { cookie })).status).toBe(404);
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
