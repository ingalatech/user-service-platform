import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    ...overrides,
  };
}

async function request(
  path: string,
  init: { method?: string; body?: unknown; cookie?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  if (init.cookie !== undefined) headers.cookie = init.cookie;
  return app.request(
    path,
    {
      method: init.method ?? 'GET',
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    testEnv(),
  );
}

function sessionCookie(response: Response): string {
  const cookie = response.headers.get('set-cookie')?.split(';')[0];
  if (cookie === undefined || cookie.length === 0) throw new Error('Expected a session cookie.');
  return cookie;
}

async function signedInUser(email: string): Promise<string> {
  const registration = await request('/v1/auth/register', {
    method: 'POST',
    body: { name: 'Technical Name', email, password: 'Correct-horse-41' },
  });
  expect(registration.status).toBe(201);
  const verification = mailer.sent.at(-1);
  if (verification === undefined) throw new Error('Expected a verification message.');
  const token = new URL(verification.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  expect((await request('/v1/auth/verify-email', { method: 'POST', body: { token } })).status).toBe(
    200,
  );
  const login = await request('/v1/auth/login', {
    method: 'POST',
    body: { email, password: 'Correct-horse-41' },
  });
  expect(login.status).toBe(200);
  return sessionCookie(login);
}

beforeAll(async () => applyD1Migrations(workerEnv.DB, testMigrations));

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare('DELETE FROM "session"'),
    workerEnv.DB.prepare('DELETE FROM "account"'),
    workerEnv.DB.prepare('DELETE FROM "verification"'),
    workerEnv.DB.prepare('DELETE FROM "email_verification_token"'),
    workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_attempt"'),
    workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_guard"'),
    workerEnv.DB.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('Account Details HTTP boundary', () => {
  it('lets a live session read and partially edit only its own optional details', async () => {
    const cookie = await signedInUser('details@example.com');

    const initial = await request('/v1/account-details', { cookie });
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({
      firstName: null,
      lastName: null,
      birthDate: null,
      phone: null,
      image: null,
    });
    const legacyMe = await request('/v1/me', { cookie });
    const legacyUser = (await legacyMe.json()) as Record<string, unknown>;
    expect(Object.keys(legacyUser).sort()).toEqual(['email', 'emailVerified', 'id']);
    expect(typeof legacyUser.id).toBe('string');
    expect(legacyUser.email).toBe('details@example.com');
    expect(legacyUser.emailVerified).toBe(true);
    const updateStartedAtSeconds = Math.floor(Date.now() / 1000);

    const updated = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: {
        firstName: 'Ada',
        birthDate: '1815-12-10',
        phone: '+44 20 7946 0958',
        image: 'https://images.example.test/ada.png',
      },
    });
    expect(updated.status).toBe(204);
    expect(await updated.text()).toBe('');
    expect(updated.headers.get('cache-control')).toBe('private, no-store');
    const storedUser = await workerEnv.DB.prepare('SELECT updated_at FROM "user" WHERE id = ?1')
      .bind(legacyUser.id)
      .first<{ updated_at: number }>();
    expect(storedUser).not.toBeNull();
    expect(storedUser?.updated_at).toBeGreaterThanOrEqual(updateStartedAtSeconds - 1);
    expect(storedUser?.updated_at).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
    const updatedSessionCookie = updated.headers.get('set-cookie');
    expect(updatedSessionCookie).not.toBeNull();
    const patchCookie = updatedSessionCookie?.split(';')[0] ?? cookie;
    const sessionAfterPatch = await request('/v1/me', { cookie: patchCookie });
    expect(sessionAfterPatch.status).toBe(200);
    expect(await sessionAfterPatch.json()).toMatchObject({ email: 'details@example.com' });

    const clearedImage = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: { image: null },
    });
    expect(clearedImage.status).toBe(204);
    expect(await (await request('/v1/account-details', { cookie })).json()).toMatchObject({
      firstName: 'Ada',
      birthDate: '1815-12-10',
      phone: '+44 20 7946 0958',
      image: null,
    });

    const rejected = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: {
        lastName: 'Lovelace',
        firstName: 'Injected',
        email: 'attacker@example.com',
        emailVerified: false,
        name: 'Injected Identity Name',
        role: 'admin',
        banned: true,
        banReason: 'malicious patch',
        banExpires: 1,
      },
    });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toMatchObject({ code: 'bad-request', status: 400 });
    expect(await (await request('/v1/account-details', { cookie })).json()).toMatchObject({
      firstName: 'Ada',
      lastName: null,
    });
    const unchangedIdentity = await request('/v1/me', { cookie });
    expect(await unchangedIdentity.json()).toEqual({
      id: legacyUser.id,
      email: 'details@example.com',
      emailVerified: true,
    });
    expect((await request('/v1/admin/me', { cookie })).status).toBe(403);
    const engineRouter = await request('/api/auth/update-user', {
      method: 'POST',
      cookie,
      body: { firstName: 'Unscoped mutation' },
    });
    expect(engineRouter.status).toBe(404);

    const cleared = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: { firstName: null, birthDate: null, phone: null, image: null },
    });
    expect(cleared.status).toBe(204);
    expect(await cleared.text()).toBe('');
    const detailsAfterClear = await request('/v1/account-details', { cookie });
    expect(await detailsAfterClear.json()).toEqual({
      firstName: null,
      lastName: null,
      birthDate: null,
      phone: null,
      image: null,
    });
  });

  it('commits Account Details and returns the session cookie when the post-commit session read would fail', async () => {
    const cookie = await signedInUser('post-commit@example.com');

    await workerEnv.DB.prepare(
      'CREATE TRIGGER expire_session_after_account_details_update AFTER UPDATE OF first_name ON "user" BEGIN UPDATE "session" SET expires_at = 0 WHERE user_id = NEW.id; END',
    ).run();

    let updated: Response;
    try {
      updated = await request('/v1/account-details', {
        method: 'PATCH',
        cookie,
        body: { firstName: 'Persisted despite read failure' },
      });
      expect(updated.status).toBe(204);
      expect(await updated.text()).toBe('');
      expect(updated.headers.get('cache-control')).toBe('private, no-store');
      expect(updated.headers.get('set-cookie')).not.toBeNull();

      const unreadableSession = await request('/v1/me', {
        cookie: updated.headers.get('set-cookie')?.split(';')[0] ?? cookie,
      });
      expect(unreadableSession.status).toBe(401);
    } finally {
      await workerEnv.DB.prepare('DROP TRIGGER expire_session_after_account_details_update').run();
    }

    const freshLogin = await request('/v1/auth/login', {
      method: 'POST',
      body: { email: 'post-commit@example.com', password: 'Correct-horse-41' },
    });
    expect(freshLogin.status).toBe(200);
    const freshCookie = sessionCookie(freshLogin);
    const persisted = await request('/v1/account-details', {
      cookie: freshCookie,
    });
    expect(persisted.status).toBe(200);
    expect(await persisted.json()).toMatchObject({ firstName: 'Persisted despite read failure' });
  });

  it('rejects anonymous, revoked, Reader State-only and invalid calendar-date requests', async () => {
    const anonymous = await request('/v1/account-details');
    expect(anonymous.status).toBe(401);

    const cookie = await signedInUser('invalid-date@example.com');
    const impossibleDate = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: { birthDate: '1900-02-29' },
    });
    expect(impossibleDate.status).toBe(400);
    expect(await impossibleDate.json()).toMatchObject({ code: 'bad-request' });
    const unchanged = await request('/v1/account-details', { cookie });
    expect(await unchanged.json()).toMatchObject({ birthDate: null });

    const insecureImage = await request('/v1/account-details', {
      method: 'PATCH',
      cookie,
      body: { image: 'http://images.example.test/photo.png' },
    });
    expect(insecureImage.status).toBe(400);
    expect(await (await request('/v1/account-details', { cookie })).json()).toMatchObject({
      image: null,
    });

    expect(
      (
        await request('/v1/account-details', {
          method: 'PATCH',
          body: { firstName: 'No cookie' },
          cookie: 'reader_state=not-an-authority',
        })
      ).status,
    ).toBe(401);

    await request('/v1/auth/sign-out', { method: 'POST', body: {}, cookie });
    expect((await request('/v1/account-details', { cookie })).status).toBe(401);
  });

  it('keeps details isolated between independent account sessions', async () => {
    const ownerCookie = await signedInUser('owner@example.com');
    const otherCookie = await signedInUser('other@example.com');
    const saved = await request('/v1/account-details', {
      method: 'PATCH',
      cookie: ownerCookie,
      body: { firstName: 'Private Name', phone: '+1 202 555 0147' },
    });
    expect(saved.status).toBe(204);

    const otherAccount = await request('/v1/account-details', { cookie: otherCookie });
    expect(await otherAccount.json()).toEqual({
      firstName: null,
      lastName: null,
      birthDate: null,
      phone: null,
      image: null,
    });
  });
});
