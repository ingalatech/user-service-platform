import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';

const workerEnv = env;
const migrations = env.TEST_MIGRATIONS as D1Migration[];
const email = 'same-email@example.test';
const readerPassword = 'Reader-horse-41';
const adminPassword = 'Admin-horse-42';
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

function testEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    AUTH_JWT_ISSUER: 'https://identity.example.test',
    AUTH_READER_STATE_AUDIENCE: 'identity-reader-state',
    ...overrides,
  };
}

async function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie === undefined ? {} : { cookie }),
      },
      body: JSON.stringify(body),
    },
    testEnv(),
  );
}

async function get(path: string, cookie?: string): Promise<Response> {
  return app.request(
    path,
    { method: 'GET', headers: cookie === undefined ? {} : { cookie } },
    testEnv(),
  );
}

function sessionCookie(response: Response): { readonly pair: string; readonly header: string } {
  const header = response.headers.get('set-cookie');
  if (header === null) throw new Error('Expected the realm-specific Set-Cookie response.');
  const pair = header.split(';')[0]?.trim();
  if (pair === undefined || pair.length === 0) throw new Error('Expected a session cookie pair.');
  return { pair, header };
}

async function latestToken(afterCount = 0): Promise<string> {
  for (let attempt = 0; attempt < 30 && mailer.sent.length <= afterCount; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const message = mailer.sent.length > afterCount ? mailer.sent.at(-1) : undefined;
  if (message === undefined)
    throw new Error('Expected a captured auth verification/reset message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a token in the captured action URL.');
  return token;
}

async function latestResetToken(afterCount: number): Promise<string> {
  for (let attempt = 0; attempt < 30 && mailer.passwordResets.length <= afterCount; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const message =
    mailer.passwordResets.length > afterCount ? mailer.passwordResets.at(-1) : undefined;
  if (message === undefined) throw new Error('Expected a captured password-reset message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a password-reset token.');
  return token;
}

async function createReader(
  identityEmail = email,
): Promise<{ readonly id: string; readonly cookie: string }> {
  const messageCount = mailer.sent.length;
  const registered = await post('/v1/auth/register', {
    name: 'Reader identity',
    email: identityEmail,
    password: readerPassword,
  });
  expect(registered.status).toBe(201);
  const token = await latestToken(messageCount);
  expect((await post('/v1/admin/auth/verify-email', { token })).status).toBe(400);
  const verify = await post('/v1/auth/verify-email', { token });
  expect(verify.status).toBe(200);
  const login = await post('/v1/auth/login', { email: identityEmail, password: readerPassword });
  expect(login.status).toBe(200);
  const cookie = sessionCookie(login);
  expect(cookie.header).toContain('Path=/v1');
  expect(cookie.pair).toMatch(/^rch-reader\.session_token=/);
  const body: unknown = await login.json();
  if (!isRecord(body) || typeof body.id !== 'string') throw new Error('Expected Reader login ID.');
  return { id: body.id, cookie: cookie.pair };
}

async function createAdministrator(): Promise<{ readonly id: string; readonly cookie: string }> {
  const messageCount = mailer.sent.length;
  const created = await post('/v1/admin/auth/bootstrap', {
    name: 'Administrator identity',
    email,
    password: adminPassword,
  });
  expect(created.status).toBe(201);
  const body: unknown = await created.json();
  if (!isRecord(body) || typeof body.id !== 'string') throw new Error('Expected Administrator ID.');
  expect(body.realm).toBe('administrator');
  const token = await latestToken(messageCount);
  expect((await post('/v1/auth/verify-email', { token })).status).toBe(400);
  const verify = await post('/v1/admin/auth/verify-email', { token });
  expect(verify.status).toBe(200);
  const login = await post('/v1/admin/auth/login', { email, password: adminPassword });
  expect(login.status).toBe(200);
  const cookie = sessionCookie(login);
  expect(cookie.header).toContain('Path=/v1/admin');
  expect(cookie.pair).toMatch(/^rch-admin\.session_token=/);
  return { id: body.id, cookie: cookie.pair };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, migrations);
});

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare('DELETE FROM "admin_session"'),
    workerEnv.DB.prepare('DELETE FROM "admin_account"'),
    workerEnv.DB.prepare('DELETE FROM "admin_verification"'),
    workerEnv.DB.prepare('DELETE FROM "admin_email_verification_token"'),
    workerEnv.DB.prepare('DELETE FROM "admin_user"'),
    workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_attempt"'),
    workerEnv.DB.prepare('DELETE FROM "admin_bootstrap_guard"'),
    workerEnv.DB.prepare('DELETE FROM "session"'),
    workerEnv.DB.prepare('DELETE FROM "account"'),
    workerEnv.DB.prepare('DELETE FROM "verification"'),
    workerEnv.DB.prepare('DELETE FROM "email_verification_token"'),
    workerEnv.DB.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('Administrator and Reader identity realms', () => {
  it('allows the same email in both realms with independent cookies, auth routes, and Reader State', async () => {
    const administrator = await createAdministrator();
    const reader = await createReader();
    expect(administrator.id).not.toBe(reader.id);
    expect(administrator.cookie).not.toBe(reader.cookie);

    const readerMe = await get('/v1/me', reader.cookie);
    expect(readerMe.status).toBe(200);
    expect(await readerMe.json()).toMatchObject({ id: reader.id, email, realm: 'reader' });
    const bothRealmCookies = `${reader.cookie}; ${administrator.cookie}`;
    expect(await (await get('/v1/me', bothRealmCookies)).json()).toMatchObject({
      id: reader.id,
      realm: 'reader',
    });
    expect(await (await get('/v1/admin/me', bothRealmCookies)).json()).toMatchObject({
      id: administrator.id,
      realm: 'administrator',
    });
    expect((await get('/v1/me', administrator.cookie)).status).toBe(401);
    expect((await get('/v1/admin/me', reader.cookie)).status).toBe(403);
    expect(await (await get('/v1/admin/me', administrator.cookie)).json()).toMatchObject({
      id: administrator.id,
      email,
      realm: 'administrator',
      role: 'admin',
    });

    expect((await post('/v1/auth/reader-state', {}, administrator.cookie)).status).toBe(401);
    const readerState = await post('/v1/auth/reader-state', {}, reader.cookie);
    expect(readerState.status).toBe(200);

    expect((await post('/v1/admin/auth/sign-out', {}, administrator.cookie)).status).toBe(200);
    expect((await get('/v1/me', reader.cookie)).status).toBe(200);
    expect((await get('/v1/admin/me', administrator.cookie)).status).toBe(401);

    const newAdminLogin = await post('/v1/admin/auth/login', { email, password: adminPassword });
    expect(newAdminLogin.status).toBe(200);
    const freshAdministrator = sessionCookie(newAdminLogin).pair;
    expect((await post('/v1/auth/sign-out', {}, reader.cookie)).status).toBe(200);
    expect((await get('/v1/admin/me', freshAdministrator)).status).toBe(200);
    expect((await get('/v1/me', reader.cookie)).status).toBe(401);
  });

  it('updates Reader Account Details through Admin authorization without targeting admin_user', async () => {
    const administrator = await createAdministrator();
    const reader = await createReader();

    const update = await app.request(
      `/v1/admin/users/${reader.id}/account-details`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', cookie: administrator.cookie },
        body: JSON.stringify({ firstName: 'Reader', lastName: 'Edited', phone: '+1 555 0100' }),
      },
      testEnv(),
    );
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ firstName: 'Reader', lastName: 'Edited' });

    const readerDetails = await get('/v1/account-details', reader.cookie);
    expect(readerDetails.status).toBe(200);
    expect(await readerDetails.json()).toMatchObject({
      firstName: 'Reader',
      lastName: 'Edited',
      phone: '+1 555 0100',
    });
    expect(
      await workerEnv.DB.prepare('SELECT id FROM "user" WHERE id = ?')
        .bind(administrator.id)
        .first(),
    ).toBeNull();
    expect(
      await workerEnv.DB.prepare('SELECT email FROM "admin_user" WHERE id = ?')
        .bind(administrator.id)
        .first<{ email: string }>(),
    ).toEqual({ email });
    expect(
      (await get(`/v1/admin/users/${administrator.id}/account-details`, administrator.cookie))
        .status,
    ).toBe(404);
  });

  it('keeps password reset and ban effects inside the Administrator realm', async () => {
    const administrator = await createAdministrator();
    const reader = await createReader();

    const previousMessages = mailer.passwordResets.length;
    expect((await post('/v1/admin/auth/request-password-reset', { email })).status).toBe(202);
    const resetToken = await latestResetToken(previousMessages);
    expect(
      await (await post('/v1/auth/check-password-reset', { token: resetToken })).json(),
    ).toEqual({
      valid: false,
    });
    expect(
      (
        await post('/v1/admin/auth/reset-password', {
          token: resetToken,
          newPassword: 'Admin-new-horse-43',
        })
      ).status,
    ).toBe(200);
    expect((await get('/v1/admin/me', administrator.cookie)).status).toBe(401);
    expect((await get('/v1/me', reader.cookie)).status).toBe(200);
    expect(
      (await post('/v1/admin/auth/login', { email, password: adminPassword })).status,
    ).not.toBe(200);
    const replacement = await post('/v1/admin/auth/login', {
      email,
      password: 'Admin-new-horse-43',
    });
    expect(replacement.status).toBe(200);
    const replacementCookie = sessionCookie(replacement).pair;

    const previousReaderResetCount = mailer.passwordResets.length;
    expect((await post('/v1/auth/request-password-reset', { email })).status).toBe(202);
    const readerResetToken = await latestResetToken(previousReaderResetCount);
    expect(
      await (await post('/v1/admin/auth/check-password-reset', { token: readerResetToken })).json(),
    ).toEqual({
      valid: false,
    });
    expect(
      (
        await post('/v1/auth/reset-password', {
          token: readerResetToken,
          newPassword: 'Reader-new-horse-44',
        })
      ).status,
    ).toBe(200);
    expect((await get('/v1/admin/me', replacementCookie)).status).toBe(200);
    expect((await get('/v1/me', reader.cookie)).status).toBe(401);
    const replacementReader = await post('/v1/auth/login', {
      email,
      password: 'Reader-new-horse-44',
    });
    expect(replacementReader.status).toBe(200);
    const replacementReaderCookie = sessionCookie(replacementReader).pair;

    await workerEnv.DB.prepare('UPDATE "admin_user" SET banned = 1 WHERE id = ?')
      .bind(administrator.id)
      .run();
    const bannedAdmin = await post('/v1/admin/auth/login', {
      email,
      password: 'Admin-new-horse-43',
    });
    expect(bannedAdmin.status).not.toBe(200);
    expect((await get('/v1/admin/me', replacementCookie)).status).toBe(200);
    expect((await get('/v1/me', replacementReaderCookie)).status).toBe(200);
    expect((await post('/v1/auth/reader-state', {}, replacementReaderCookie)).status).toBe(200);
  });

  it('rejects legacy Reader rows with role=admin and their existing sessions', async () => {
    await createAdministrator();
    const legacyReader = await createReader('legacy-reader@example.test');
    await workerEnv.DB.prepare('UPDATE "user" SET role = ? WHERE id = ?')
      .bind('admin', legacyReader.id)
      .run();

    expect((await get('/v1/me', legacyReader.cookie)).status).toBe(401);
    expect((await post('/v1/auth/reader-state', {}, legacyReader.cookie)).status).toBe(401);
    const legacyLogin = await post('/v1/auth/login', {
      email: 'legacy-reader@example.test',
      password: readerPassword,
    });
    expect(legacyLogin.status).not.toBe(200);
  });
});
