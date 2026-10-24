import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer } from './mailer.js';
import {
  PASSWORD_POLICY_BOUNDARY_PASSWORDS,
  PASSWORD_POLICY_VIOLATIONS,
  TEST_PASSWORD_POLICY,
} from './password-policy.test-data.js';
import { resolveAuthSecret } from './secret.js';

// Seam under test (ticket #10, ADR-0011): the public HTTP boundary of the built
// Worker, executed inside the Cloudflare Workers runtime with the isolated test
// D1 database. These tests prove registration, the pre-verification login
// block, verification, and the changed post-verification login eligibility —
// never Better Auth or D1 internals.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

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

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

async function post(path: string, body: unknown, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(
    path,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    testEnv(overrides),
  );
}

async function get(
  path: string,
  init: { cookie?: string | null; overrides?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.cookie !== undefined && init.cookie !== null && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  return app.request(path, { method: 'GET', headers }, testEnv(init.overrides));
}

async function postWithCookie(
  path: string,
  body: unknown,
  cookie: string | null,
  overrides: Partial<Env> = {},
): Promise<Response> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (cookie !== null && cookie.length > 0) {
    headers.cookie = cookie;
  }
  return app.request(
    path,
    { method: 'POST', headers, body: JSON.stringify(body) },
    testEnv(overrides),
  );
}

// Extracts the cookie pair (`name=value`) from a Set-Cookie header so it can
// be replayed as a Cookie header without coupling tests to cookie attributes.
function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

async function userCount(binding: Env['DB']): Promise<number> {
  const row = await binding.prepare('SELECT COUNT(*) AS total FROM "user"').first<{
    total: number;
  }>();
  return row?.total ?? 0;
}

async function userIdentity(
  binding: Env['DB'],
  email: string,
): Promise<{
  readonly name: string;
  readonly email: string;
  readonly email_verified: number;
}> {
  const row = await binding
    .prepare('SELECT "name", "email", "email_verified" FROM "user" WHERE "email" = ?')
    .bind(email)
    .first<{ name: string; email: string; email_verified: number }>();
  if (row === null) throw new Error('Expected identity row.');
  return row;
}

async function tokenFromLastMessage(): Promise<string> {
  await waitForVerificationMessages(1);
  const messages = mailer.sent;
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured verification message.');
  }
  const token = new URL(last.url).searchParams.get('token');
  if (token === null) {
    throw new Error('Expected a token in the captured verification action URL.');
  }
  return token;
}

async function waitForVerificationMessages(count: number): Promise<void> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length < count; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mailer.sent.length).toBeGreaterThanOrEqual(count);
}

function resetTokenFromLastMessage(): string {
  const messages = mailer.passwordResets;
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured password-reset message.');
  }
  expect(typeof last.token).toBe('string');
  expect(last.token.length).toBeGreaterThan(0);
  return last.token;
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM "session"'),
    db.prepare('DELETE FROM "account"'),
    db.prepare('DELETE FROM "verification"'),
    db.prepare('DELETE FROM "email_verification_token"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('POST /v1/auth/register', () => {
  it('registers a new user and schedules a verification message', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = (await res.json()) as { id: string; email: string; emailVerified: boolean };
    expect(typeof body.id).toBe('string');
    expect(body.email).toBe('ada@example.com');
    expect(body.emailVerified).toBe(false);

    await tokenFromLastMessage();
    await waitForVerificationMessages(1);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);
    const message = mailer.sent[0];
    expect(message?.to).toBe('ada@example.com');
    expect(message?.url).toContain('token=');
    // The captured action must not carry credential material with it.
    expect(JSON.stringify(message)).not.toContain('Correct-horse-41');

    expect(await userCount(workerEnv.DB)).toBe(1);
  });

  it('registers without a name using the email local-part for Better Auth', async () => {
    const res = await post('/v1/auth/register', {
      email: 'jperez@test.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect((await userIdentity(workerEnv.DB, 'jperez@test.com')).name).toBe('jperez');
  });

  it('preserves an explicitly provided name', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Ada Lovelace',
      email: 'ada-explicit@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect((await userIdentity(workerEnv.DB, 'ada-explicit@example.com')).name).toBe(
      'Ada Lovelace',
    );
  });

  it('rejects an explicitly empty name instead of treating it as omitted', async () => {
    const res = await post('/v1/auth/register', {
      name: '',
      email: 'empty-name@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(400);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('rejects an explicitly whitespace-only name', async () => {
    const res = await post('/v1/auth/register', {
      name: '   ',
      email: 'whitespace-name@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(400);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('accepts an omitted name when the derived local-part is exactly 200 characters', async () => {
    const localPart = 'a'.repeat(200);
    const email = `${localPart}@x.co`;
    const res = await post('/v1/auth/register', {
      email,
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    expect((await userIdentity(workerEnv.DB, email)).name).toBe(localPart);
  });

  it('rejects an omitted name when the derived local-part exceeds 200 characters', async () => {
    const email = `${'a'.repeat(201)}@x.co`;
    const res = await post('/v1/auth/register', {
      email,
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(400);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('rejects registration with a stable error when the policy disables it', async () => {
    const res = await post(
      '/v1/auth/register',
      { name: 'Grace Hopper', email: 'grace@example.com', password: 'Correct-horse-41' },
      { AUTH_REGISTRATION_ENABLED: 'false' },
    );

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('registration-disabled');
    expect(body.status).toBe(403);

    expect(mailer.sent).toHaveLength(0);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('rejects invalid registration input through the public contract', async () => {
    const res = await post('/v1/auth/register', {
      name: 'Bad Input',
      email: 'not-an-email',
      password: 'short',
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('bad-request');
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('enforces every configured password rule and both length boundaries', async () => {
    const policyEnv = {
      AUTH_PASSWORD_MIN_LENGTH: String(TEST_PASSWORD_POLICY.minLength),
      AUTH_PASSWORD_MAX_LENGTH: String(TEST_PASSWORD_POLICY.maxLength),
      AUTH_PASSWORD_MIN_UPPERCASE: String(TEST_PASSWORD_POLICY.minUppercase),
      AUTH_PASSWORD_MIN_LOWERCASE: String(TEST_PASSWORD_POLICY.minLowercase),
      AUTH_PASSWORD_MIN_DIGITS: String(TEST_PASSWORD_POLICY.minDigits),
      AUTH_PASSWORD_MIN_SYMBOLS: String(TEST_PASSWORD_POLICY.minSymbols),
    };

    for (const [index, violation] of PASSWORD_POLICY_VIOLATIONS.entries()) {
      const res = await post(
        '/v1/auth/register',
        {
          name: `Policy ${String(index)}`,
          email: `policy-${String(index)}@example.com`,
          password: violation.password,
        },
        policyEnv,
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        code: 'password-policy-violation',
        failedRules: [violation.rule],
        passwordPolicy: TEST_PASSWORD_POLICY,
      });
    }

    for (const [index, password] of PASSWORD_POLICY_BOUNDARY_PASSWORDS.entries()) {
      const res = await post(
        '/v1/auth/register',
        {
          name: `Boundary ${String(index)}`,
          email: `boundary-${String(index)}@example.com`,
          password,
        },
        policyEnv,
      );
      expect(res.status).toBe(201);
    }
  });

  it('returns the same password-policy problem for registration, reset, and bootstrap', async () => {
    const policyEnv = {
      AUTH_PASSWORD_MIN_LENGTH: String(TEST_PASSWORD_POLICY.minLength),
      AUTH_PASSWORD_MAX_LENGTH: String(TEST_PASSWORD_POLICY.maxLength),
      AUTH_PASSWORD_MIN_UPPERCASE: String(TEST_PASSWORD_POLICY.minUppercase),
      AUTH_PASSWORD_MIN_LOWERCASE: String(TEST_PASSWORD_POLICY.minLowercase),
      AUTH_PASSWORD_MIN_DIGITS: String(TEST_PASSWORD_POLICY.minDigits),
      AUTH_PASSWORD_MIN_SYMBOLS: String(TEST_PASSWORD_POLICY.minSymbols),
    };
    const cases = [
      {
        path: '/v1/auth/register',
        body: { name: 'Policy User', email: 'policy@example.com', password: 'Ab1!' },
      },
      {
        path: '/v1/auth/reset-password',
        body: { token: 'synthetic-reset-token', newPassword: 'Ab1!' },
      },
      {
        path: '/v1/auth/admin/bootstrap',
        body: { name: 'Policy Admin', email: 'policy-admin@example.com', password: 'Ab1!' },
      },
    ] as const;

    const results = await Promise.all(
      cases.map(async ({ path, body }) => {
        const response = await post(path, body, policyEnv);
        expect(response.status).toBe(400);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(response.headers.get('cache-control')).toBe('no-store');
        return (await response.json()) as Record<string, unknown>;
      }),
    );
    const [registrationProblem, resetProblem, bootstrapProblem] = results;
    if (
      registrationProblem === undefined ||
      resetProblem === undefined ||
      bootstrapProblem === undefined
    ) {
      throw new Error('Expected a password-policy problem from each credential operation.');
    }

    const withoutInstance = (problem: Record<string, unknown>) => {
      const details = { ...problem };
      delete details.instance;
      return details;
    };
    const registrationDetails = withoutInstance(registrationProblem);
    const resetDetails = withoutInstance(resetProblem);
    const bootstrapDetails = withoutInstance(bootstrapProblem);
    expect(resetDetails).toEqual(registrationDetails);
    expect(bootstrapDetails).toEqual(registrationDetails);
    expect(registrationProblem.instance).toBe('/v1/auth/register');
    expect(resetProblem.instance).toBe('/v1/auth/reset-password');
    expect(bootstrapProblem.instance).toBe('/v1/auth/admin/bootstrap');
    expect(registrationDetails).toEqual({
      type: 'urn:problem:password-policy-violation',
      title: 'Password does not meet policy',
      status: 400,
      detail: 'The password does not meet the effective password policy.',
      code: 'password-policy-violation',
      failedRules: ['min-length'],
      passwordPolicy: TEST_PASSWORD_POLICY,
    });
  });

  it('answers duplicate registration generically without duplicating identities', async () => {
    const payload = {
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      password: 'Correct-horse-41',
    };
    const first = await post('/v1/auth/register', payload);
    const second = await post('/v1/auth/register', payload);

    expect(first.status).toBe(201);
    // Same observable shape as a fresh registration so the response cannot
    // be used to probe for existing accounts.
    expect(second.status).toBe(201);
    expect(await userCount(workerEnv.DB)).toBe(1);
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);
  });

  it('rejects auth operations with a stable error when email/password is disabled', async () => {
    const disabled = { AUTH_EMAIL_PASSWORD_ENABLED: 'false' };

    const registerRes = await post(
      '/v1/auth/register',
      { name: 'No Auth', email: 'noauth@example.com', password: 'Correct-horse-41' },
      disabled,
    );
    const loginRes = await post(
      '/v1/auth/login',
      { email: 'noauth@example.com', password: 'Correct-horse-41' },
      disabled,
    );

    for (const res of [registerRes, loginRes]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'email-password-disabled', status: 403 });
    }
    expect(await userCount(workerEnv.DB)).toBe(0);
  });
});

describe('verified-email login gate', () => {
  it('blocks email/password login before verification with a machine-readable error', async () => {
    await post('/v1/auth/register', {
      name: 'Alan Turing',
      email: 'alan@example.com',
      password: 'Correct-horse-41',
    });

    const res = await post('/v1/auth/login', {
      email: 'alan@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = (await res.json()) as { code: string; status: number };
    expect(body).toMatchObject({ code: 'email-verification-required', status: 403 });
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('allows login after a valid verification action', async () => {
    await post('/v1/auth/register', {
      name: 'Alan Turing',
      email: 'alan@example.com',
      password: 'Correct-horse-41',
    });

    const verifyRes = await post('/v1/auth/verify-email', {
      token: await tokenFromLastMessage(),
    });
    expect(verifyRes.status).toBe(200);
    const verified = (await verifyRes.json()) as { emailVerified: boolean };
    expect(verified.emailVerified).toBe(true);

    const loginRes = await post('/v1/auth/login', {
      email: 'alan@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const sessionCookie = loginRes.headers.get('set-cookie');
    expect(sessionCookie).toContain('better-auth.session_token');

    const loginBody = JSON.stringify(await loginRes.json());
    expect(loginBody).toContain('alan@example.com');
    // Session material travels in the cookie, never in the JSON body.
    expect(loginBody).not.toContain('better-auth.session_token');
  });

  it('fails safely on invalid verification tokens without leaking material', async () => {
    const res = await post('/v1/auth/verify-email', { token: 'not-a-real-token' });

    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    const raw = await res.text();
    expect(raw).not.toContain('not-a-real-token');
    expect(JSON.parse(raw)).toMatchObject({ code: 'verification-invalid', status: 400 });
  });

  it('fails safely on expired verification tokens', async () => {
    await post('/v1/auth/register', {
      name: 'Expired Token',
      email: 'expired@example.com',
      password: 'Correct-horse-41',
    });

    const res = await post('/v1/auth/verify-email', {
      token: await expiredTokenFor('expired@example.com'),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe('verification-invalid');

    // The account is still unverified, so login stays blocked.
    const loginRes = await post('/v1/auth/login', {
      email: 'expired@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(403);
  });

  it('rejects wrong credentials without revealing account state', async () => {
    await post('/v1/auth/register', {
      name: 'Known User',
      email: 'known@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });

    const wrongPassword = await post('/v1/auth/login', {
      email: 'known@example.com',
      password: 'wrong-password-99',
    });
    const unknownEmail = await post('/v1/auth/login', {
      email: 'nobody@example.com',
      password: 'wrong-password-99',
    });

    expect(wrongPassword.status).toBe(401);
    expect(unknownEmail.status).toBe(401);
    // Both failures share the same stable shape so neither response reveals
    // whether the account exists.
    expect(await wrongPassword.json()).toEqual(await unknownEmail.json());
    // No session is established on credential failure.
    expect(wrongPassword.headers.get('set-cookie')).toBeNull();
    expect(unknownEmail.headers.get('set-cookie')).toBeNull();
  });
});

describe('POST /v1/auth/request-verification', () => {
  it('invalidates a superseded token and consumes the latest token once', async () => {
    await post('/v1/auth/register', {
      name: 'Latest Token',
      email: 'latest-token@example.com',
      password: 'Correct-horse-41',
    });
    const token1 = await tokenFromLastMessage();

    const resend = await post('/v1/auth/request-verification', {
      email: 'LATEST-TOKEN@example.com',
    });
    expect(resend.status).toBe(202);
    await waitForVerificationMessages(2);
    const token2 = await tokenFromLastMessage();
    expect(token2).not.toBe(token1);

    const stale = await post('/v1/auth/verify-email', { token: token1 });
    expect(stale.status).toBe(400);
    expect(await stale.json()).toMatchObject({ code: 'verification-invalid', status: 400 });
    expect((await userIdentity(workerEnv.DB, 'latest-token@example.com')).email_verified).toBe(0);

    const verified = await post('/v1/auth/verify-email', { token: token2 });
    expect(verified.status).toBe(200);

    const reused = await post('/v1/auth/verify-email', { token: token2 });
    expect(reused.status).toBe(400);
    expect(await reused.json()).toMatchObject({ code: 'verification-invalid', status: 400 });
  });

  it('consumes before a later engine failure and leaves identity state unchanged', async () => {
    await post('/v1/auth/register', {
      name: 'Engine Failure',
      email: 'engine-failure@example.com',
      password: 'Correct-horse-41',
    });
    const token = await tokenFromLastMessage();
    await workerEnv.DB.prepare('DELETE FROM "user" WHERE "email" = ?')
      .bind('engine-failure@example.com')
      .run();

    const failed = await post('/v1/auth/verify-email', { token });
    expect(failed.status).toBe(400);
    const consumed = await workerEnv.DB.prepare(
      'SELECT COUNT(*) AS total FROM "email_verification_token" WHERE "consumed_at" IS NOT NULL',
    ).first<{ total: number }>();
    expect(consumed?.total).toBe(1);
  });

  it('allows only one concurrent verification request to consume a token', async () => {
    await post('/v1/auth/register', {
      name: 'Race Token',
      email: 'race-token@example.com',
      password: 'Correct-horse-41',
    });
    const token = await tokenFromLastMessage();

    const results = await Promise.all([
      post('/v1/auth/verify-email', { token }),
      post('/v1/auth/verify-email', { token }),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect((await userIdentity(workerEnv.DB, 'race-token@example.com')).email_verified).toBe(1);
  });

  it('linearizes resend against verification at the consume boundary', async () => {
    await post('/v1/auth/register', {
      name: 'Resend Race',
      email: 'resend-race@example.com',
      password: 'Correct-horse-41',
    });
    const token = await tokenFromLastMessage();

    const [verification, resend] = await Promise.all([
      post('/v1/auth/verify-email', { token }),
      post('/v1/auth/request-verification', { email: 'resend-race@example.com' }),
    ]);
    expect(resend.status).toBe(202);
    expect([200, 400]).toContain(verification.status);
    const identity = await userIdentity(workerEnv.DB, 'resend-race@example.com');
    expect(identity.email_verified).toBe(verification.status === 200 ? 1 : 0);
  });

  it('resends verification without creating duplicate identities', async () => {
    await post('/v1/auth/register', {
      name: 'Resend Me',
      email: 'resend@example.com',
      password: 'Correct-horse-41',
    });
    await waitForVerificationMessages(1);
    expect(mailer.sent).toHaveLength(1);

    const first = await post('/v1/auth/request-verification', { email: 'resend@example.com' });
    const second = await post('/v1/auth/request-verification', { email: 'resend@example.com' });

    expect(first.status).toBe(202);
    expect(second.status).toBe(202);
    await waitForVerificationMessages(3);
    expect(await userCount(workerEnv.DB)).toBe(1);
    expect(mailer.sent.length).toBeGreaterThanOrEqual(3);
  });

  it('answers generically for unknown emails to resist enumeration', async () => {
    const res = await post('/v1/auth/request-verification', { email: 'ghost@example.com' });

    expect(res.status).toBe(202);
    expect(mailer.sent).toHaveLength(0);
    expect(await userCount(workerEnv.DB)).toBe(0);
  });

  it('keeps unknown and already-verified requests on the same public contract', async () => {
    await post('/v1/auth/register', {
      name: 'Already Verified',
      email: 'already-verified@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });

    const [verified, unknown] = await Promise.all([
      post('/v1/auth/request-verification', { email: 'already-verified@example.com' }),
      post('/v1/auth/request-verification', { email: 'not-registered@example.com' }),
    ]);
    expect(verified.status).toBe(202);
    expect(unknown.status).toBe(202);
    expect(await verified.json()).toEqual(await unknown.json());
  });
});

describe('GET /v1/me', () => {
  it('returns the current User for an authenticated session', async () => {
    await post('/v1/auth/register', {
      name: 'Ada Lovelace',
      email: 'ada-me@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    const loginRes = await post('/v1/auth/login', {
      email: 'ada-me@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();
    expect(cookie ?? '').toContain('better-auth.session_token=');

    const meRes = await get('/v1/me', { cookie });
    expect(meRes.status).toBe(200);
    expect(meRes.headers.get('content-type')).toContain('application/json');

    const me = (await meRes.json()) as { id: string; email: string; emailVerified: boolean };
    expect(typeof me.id).toBe('string');
    expect(me.email).toBe('ada-me@example.com');
    expect(me.emailVerified).toBe(true);
    // Session material travels in cookies, never in the JSON body.
    const raw = JSON.stringify(me);
    expect(raw).not.toContain('better-auth.session_token');
    expect(raw).not.toContain('password');
  });

  it('returns the agreed unauthenticated Problem Details shape without a session', async () => {
    const res = await get('/v1/me');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'urn:problem:unauthenticated',
      title: 'Unauthenticated',
      status: 401,
      code: 'unauthenticated',
      instance: '/v1/me',
    });
  });

  it('rejects forged session cookies without leaking material', async () => {
    const res = await get('/v1/me', { cookie: 'better-auth.session_token=forged-value' });

    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });
});

describe('POST /v1/auth/sign-out', () => {
  it('invalidates the current session across the full register -> me -> sign-out path', async () => {
    await post('/v1/auth/register', {
      name: 'Grace Hopper',
      email: 'grace-me@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    const loginRes = await post('/v1/auth/login', {
      email: 'grace-me@example.com',
      password: 'Correct-horse-41',
    });
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();

    const before = await get('/v1/me', { cookie });
    expect(before.status).toBe(200);

    const signOutRes = await postWithCookie('/v1/auth/sign-out', {}, cookie);
    expect(signOutRes.status).toBe(200);
    expect(await signOutRes.json()).toEqual({ status: 'ok' });

    const after = await get('/v1/me', { cookie });
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('sets security-appropriate session cookie attributes on sign-in', async () => {
    await post('/v1/auth/register', {
      name: 'Cookie Check',
      email: 'cookie@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    const loginRes = await post('/v1/auth/login', {
      email: 'cookie@example.com',
      password: 'Correct-horse-41',
    });

    const setCookie = loginRes.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('better-auth.session_token=');
    expect(setCookie).toMatch(/httponly/i);
    expect(setCookie).toMatch(/samesite/i);
  });
});

describe('password recovery', () => {
  it('accepts recovery requests generically and schedules a reset message', async () => {
    await post('/v1/auth/register', {
      name: 'Recover Me',
      email: 'recover@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();

    const res = await post('/v1/auth/request-password-reset', {
      email: 'recover@example.com',
    });

    expect(res.status).toBe(202);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ status: 'ok' });

    expect(mailer.passwordResets).toHaveLength(1);
    const message = mailer.passwordResets[0];
    expect(message?.to).toBe('recover@example.com');
    expect(typeof message?.token).toBe('string');
    expect(message?.token.length).toBeGreaterThan(0);
    expect(message?.url).toContain(message?.token ?? 'missing-token');
    // The captured action must not carry credential material with it.
    expect(JSON.stringify(message)).not.toContain('Correct-horse-41');
  });

  it('answers identically for unknown emails to resist enumeration', async () => {
    await post('/v1/auth/register', {
      name: 'Known Recover',
      email: 'known-recover@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();

    const known = await post('/v1/auth/request-password-reset', {
      email: 'known-recover@example.com',
    });
    const knownBody = await known.json();
    const scheduled = mailer.passwordResets.length;
    mailer.clear();

    const unknown = await post('/v1/auth/request-password-reset', {
      email: 'ghost-recover@example.com',
    });

    expect(known.status).toBe(202);
    expect(unknown.status).toBe(202);
    // Identical observable shape so the response cannot probe for accounts.
    expect(await unknown.json()).toEqual(knownBody);
    expect(scheduled).toBe(1);
    expect(mailer.passwordResets).toHaveLength(0);
  });

  it('checks a current reset action without consuming or exposing it', async () => {
    await post('/v1/auth/register', {
      name: 'Check Reset',
      email: 'check-reset@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'check-reset@example.com' });
    const token = resetTokenFromLastMessage();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const checked = await post('/v1/auth/check-password-reset', { token });
      expect(checked.status).toBe(200);
      expect(checked.headers.get('cache-control')).toBe('no-store');
      const raw = await checked.text();
      expect(raw).not.toContain(token);
      expect(JSON.parse(raw)).toEqual({ valid: true });
    }

    const concurrentChecks = await Promise.all(
      Array.from({ length: 8 }, () => post('/v1/auth/check-password-reset', { token })),
    );
    expect(concurrentChecks.every((response) => response.status === 200)).toBe(true);
    expect(await Promise.all(concurrentChecks.map((response) => response.json()))).toEqual(
      Array.from({ length: 8 }, () => ({ valid: true })),
    );

    const reset = await post('/v1/auth/reset-password', {
      token,
      newPassword: 'Brand-new-horse-42',
    });
    expect(reset.status).toBe(200);
  });

  it('returns false for expired, consumed, and unknown reset actions', async () => {
    await post('/v1/auth/register', {
      name: 'Invalid Check Reset',
      email: 'invalid-check-reset@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'invalid-check-reset@example.com' });
    const token = resetTokenFromLastMessage();

    const stored = await workerEnv.DB.prepare(
      'SELECT expires_at FROM "verification" WHERE identifier = ?',
    )
      .bind(`reset-password:${token}`)
      .first<{ expires_at: number }>();
    expect(stored?.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(stored?.expires_at).toBeLessThan(Date.now());
    const expiredAt = Math.floor(Date.now() / 1000) - 1;
    await workerEnv.DB.prepare('UPDATE "verification" SET expires_at = ? WHERE identifier = ?')
      .bind(expiredAt, `reset-password:${token}`)
      .run();
    const expired = await post('/v1/auth/check-password-reset', { token });
    expect(expired.status).toBe(200);
    expect(expired.headers.get('cache-control')).toBe('no-store');
    expect(await expired.json()).toEqual({ valid: false });

    await post('/v1/auth/request-password-reset', { email: 'invalid-check-reset@example.com' });
    const currentToken = resetTokenFromLastMessage();
    const consumed = await post('/v1/auth/reset-password', {
      token: currentToken,
      newPassword: 'Brand-new-horse-42',
    });
    expect(consumed.status).toBe(200);

    for (const candidate of [currentToken, 'unknown-reset-token']) {
      const checked = await post('/v1/auth/check-password-reset', { token: candidate });
      expect(checked.status).toBe(200);
      expect(checked.headers.get('cache-control')).toBe('no-store');
      const raw = await checked.text();
      expect(raw).not.toContain(candidate);
      expect(JSON.parse(raw)).toEqual({ valid: false });
    }
  });

  it('rejects malformed reset checks at the public contract', async () => {
    for (const token of ['', 'x'.repeat(4097)]) {
      const res = await post('/v1/auth/check-password-reset', { token });
      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await res.json()).toMatchObject({ code: 'bad-request', status: 400 });
    }
  });

  it('completes a valid reset, revokes sessions, and rotates credentials', async () => {
    await post('/v1/auth/register', {
      name: 'Rotate Me',
      email: 'rotate@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    const loginRes = await post('/v1/auth/login', {
      email: 'rotate@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
    const cookie = sessionCookieFrom(loginRes);
    expect(cookie).not.toBeNull();
    expect((await get('/v1/me', { cookie })).status).toBe(200);
    mailer.clear();

    await post('/v1/auth/request-password-reset', { email: 'rotate@example.com' });
    const resetRes = await post('/v1/auth/reset-password', {
      token: resetTokenFromLastMessage(),
      newPassword: 'Brand-new-horse-42',
    });

    expect(resetRes.status).toBe(200);
    expect(resetRes.headers.get('content-type')).toContain('application/json');
    expect(await resetRes.json()).toEqual({ status: 'ok' });

    // Previously issued sessions can no longer authenticate.
    const after = await get('/v1/me', { cookie });
    expect(after.status).toBe(401);
    expect(await after.json()).toMatchObject({ code: 'unauthenticated', status: 401 });

    // The old password no longer establishes a session; the new one does.
    const oldLogin = await post('/v1/auth/login', {
      email: 'rotate@example.com',
      password: 'Correct-horse-41',
    });
    expect(oldLogin.status).toBe(401);
    expect(await oldLogin.json()).toMatchObject({ code: 'invalid-credentials', status: 401 });

    const newLogin = await post('/v1/auth/login', {
      email: 'rotate@example.com',
      password: 'Brand-new-horse-42',
    });
    expect(newLogin.status).toBe(200);
    const newCookie = sessionCookieFrom(newLogin);
    expect(newCookie).not.toBeNull();
    const meRes = await get('/v1/me', { cookie: newCookie });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      email: 'rotate@example.com',
      emailVerified: true,
    });
  });

  it('fails safely on invalid, reused, and malformed reset actions', async () => {
    await post('/v1/auth/register', {
      name: 'Reset Safety',
      email: 'reset-safety@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'reset-safety@example.com' });
    const token = resetTokenFromLastMessage();

    const invalid = await post('/v1/auth/reset-password', {
      token: 'not-a-real-token',
      newPassword: 'Brand-new-horse-42',
    });
    expect(invalid.status).toBe(400);
    expect(invalid.headers.get('content-type')).toContain('application/problem+json');
    const invalidRaw = await invalid.text();
    expect(invalidRaw).not.toContain('not-a-real-token');
    expect(JSON.parse(invalidRaw)).toMatchObject({ code: 'reset-invalid', status: 400 });

    const first = await post('/v1/auth/reset-password', {
      token,
      newPassword: 'Brand-new-horse-42',
    });
    expect(first.status).toBe(200);

    // Reset actions are single use.
    const reuse = await post('/v1/auth/reset-password', {
      token,
      newPassword: 'Another-horse-43',
    });
    expect(reuse.status).toBe(400);
    const reuseRaw = await reuse.text();
    expect(reuseRaw).not.toContain(token);
    expect(JSON.parse(reuseRaw)).toMatchObject({ code: 'reset-invalid', status: 400 });

    // The first reset won; the reused action changed nothing further.
    const staleLogin = await post('/v1/auth/login', {
      email: 'reset-safety@example.com',
      password: 'Another-horse-43',
    });
    expect(staleLogin.status).toBe(401);
    const currentLogin = await post('/v1/auth/login', {
      email: 'reset-safety@example.com',
      password: 'Brand-new-horse-42',
    });
    expect(currentLogin.status).toBe(200);
  });

  it('fails safely on expired reset actions without rotating credentials', async () => {
    await post('/v1/auth/register', {
      name: 'Expired Reset',
      email: 'expired-reset@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'expired-reset@example.com' });
    const token = resetTokenFromLastMessage();

    // Expire the stored reset action directly; the public reset must then fail.
    const expiredAt = Math.floor(Date.now() / 1000) - 1;
    await workerEnv.DB.prepare('UPDATE "verification" SET expires_at = ? WHERE identifier = ?')
      .bind(expiredAt, `reset-password:${token}`)
      .run();

    const res = await post('/v1/auth/reset-password', {
      token,
      newPassword: 'Brand-new-horse-42',
    });
    expect(res.status).toBe(400);
    const raw = await res.text();
    expect(raw).not.toContain(token);
    expect(JSON.parse(raw)).toMatchObject({ code: 'reset-invalid', status: 400 });

    // The expired action rotated nothing: the original password still works.
    const loginRes = await post('/v1/auth/login', {
      email: 'expired-reset@example.com',
      password: 'Correct-horse-41',
    });
    expect(loginRes.status).toBe(200);
  });

  it('consumes one concurrent reset action exactly once', async () => {
    await post('/v1/auth/register', {
      name: 'Concurrent Reset',
      email: 'concurrent-reset@example.com',
      password: 'Correct-horse-41',
    });
    await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
    mailer.clear();
    await post('/v1/auth/request-password-reset', { email: 'concurrent-reset@example.com' });
    const token = resetTokenFromLastMessage();

    const [first, second] = await Promise.all([
      post('/v1/auth/reset-password', { token, newPassword: 'First-reset-horse-42' }),
      post('/v1/auth/reset-password', { token, newPassword: 'Second-reset-horse-43' }),
    ]);
    expect([first.status, second.status].sort()).toEqual([200, 400]);
    const invalid = first.status === 400 ? first : second;
    expect(await invalid.json()).toMatchObject({ code: 'reset-invalid', status: 400 });

    const firstLogin = await post('/v1/auth/login', {
      email: 'concurrent-reset@example.com',
      password: 'First-reset-horse-42',
    });
    const secondLogin = await post('/v1/auth/login', {
      email: 'concurrent-reset@example.com',
      password: 'Second-reset-horse-43',
    });
    expect([firstLogin.status, secondLogin.status].sort()).toEqual([200, 401]);
  });

  it('enforces every configured password rule and both length boundaries', async () => {
    const policyEnv = {
      AUTH_PASSWORD_MIN_LENGTH: String(TEST_PASSWORD_POLICY.minLength),
      AUTH_PASSWORD_MAX_LENGTH: String(TEST_PASSWORD_POLICY.maxLength),
      AUTH_PASSWORD_MIN_UPPERCASE: String(TEST_PASSWORD_POLICY.minUppercase),
      AUTH_PASSWORD_MIN_LOWERCASE: String(TEST_PASSWORD_POLICY.minLowercase),
      AUTH_PASSWORD_MIN_DIGITS: String(TEST_PASSWORD_POLICY.minDigits),
      AUTH_PASSWORD_MIN_SYMBOLS: String(TEST_PASSWORD_POLICY.minSymbols),
    };

    for (const [index, violation] of PASSWORD_POLICY_VIOLATIONS.entries()) {
      const email = `reset-policy-${String(index)}@example.com`;
      await post(
        '/v1/auth/register',
        { name: `Reset Policy ${String(index)}`, email, password: 'Abcdef1!' },
        policyEnv,
      );
      await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() }, policyEnv);
      mailer.clear();
      await post('/v1/auth/request-password-reset', { email }, policyEnv);

      const res = await post(
        '/v1/auth/reset-password',
        { token: resetTokenFromLastMessage(), newPassword: violation.password },
        policyEnv,
      );

      expect(res.status).toBe(400);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toMatchObject({
        code: 'password-policy-violation',
        failedRules: [violation.rule],
        passwordPolicy: TEST_PASSWORD_POLICY,
      });
      mailer.clear();
    }

    for (const [index, password] of PASSWORD_POLICY_BOUNDARY_PASSWORDS.entries()) {
      const email = `reset-boundary-${String(index)}@example.com`;
      await post(
        '/v1/auth/register',
        { name: `Reset Boundary ${String(index)}`, email, password: 'Abcdef1!' },
        policyEnv,
      );
      await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() }, policyEnv);
      mailer.clear();
      await post('/v1/auth/request-password-reset', { email }, policyEnv);
      const res = await post(
        '/v1/auth/reset-password',
        { token: resetTokenFromLastMessage(), newPassword: password },
        policyEnv,
      );
      expect(res.status).toBe(200);
      mailer.clear();
    }
  });

  it('rejects recovery operations when email/password is disabled', async () => {
    const disabled = { AUTH_EMAIL_PASSWORD_ENABLED: 'false' };

    const requestRes = await post(
      '/v1/auth/request-password-reset',
      { email: 'noauth-reset@example.com' },
      disabled,
    );
    const resetRes = await post(
      '/v1/auth/reset-password',
      { token: 'not-a-real-token', newPassword: 'Brand-new-horse-42' },
      disabled,
    );
    const checkRes = await post(
      '/v1/auth/check-password-reset',
      { token: 'not-a-real-token' },
      disabled,
    );

    for (const res of [requestRes, resetRes, checkRes]) {
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'email-password-disabled', status: 403 });
    }
    expect(mailer.passwordResets).toHaveLength(0);
  });

  it('never logs reset tokens, action URLs, or credentials', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    const captured = { token: '', url: '' };
    try {
      await post('/v1/auth/register', {
        name: 'Reset Log Check',
        email: 'reset-logs@example.com',
        password: 'Correct-horse-41',
      });
      await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
      await post('/v1/auth/request-password-reset', { email: 'reset-logs@example.com' });
      const last = mailer.passwordResets[mailer.passwordResets.length - 1];
      captured.token = last?.token ?? '';
      captured.url = last?.url ?? '';
      expect(captured.token.length).toBeGreaterThan(0);
      await post('/v1/auth/check-password-reset', { token: captured.token });
      await post('/v1/auth/check-password-reset', { token: 'unknown-reset-token' });
      await post('/v1/auth/reset-password', {
        token: captured.token,
        newPassword: 'Brand-new-horse-42',
      });
      await post('/v1/auth/reset-password', {
        token: 'not-a-real-token',
        newPassword: 'Brand-new-horse-42',
      });
    } finally {
      spy.mockRestore();
    }

    const transcript = seen.join('\n');
    expect(transcript).not.toContain('Correct-horse-41');
    expect(transcript).not.toContain('Brand-new-horse-42');
    expect(transcript).not.toContain(captured.token);
    expect(transcript).not.toContain(captured.url);
    expect(transcript).not.toContain('token=');
    expect(transcript).not.toContain('reset-password:');
  });
});

describe('identity observability redaction', () => {
  it('never logs passwords, tokens, action URLs or message bodies', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    const captured = { value: '' };
    try {
      await post('/v1/auth/register', {
        name: 'Log Check',
        email: 'logs@example.com',
        password: 'Correct-horse-41',
      });
      const token = await tokenFromLastMessage();
      await post('/v1/auth/login', { email: 'logs@example.com', password: 'Correct-horse-41' });
      await post('/v1/auth/verify-email', { token });
      const loginRes = await post('/v1/auth/login', {
        email: 'logs@example.com',
        password: 'Correct-horse-41',
      });
      const cookie = sessionCookieFrom(loginRes) ?? '';
      captured.value = cookie.split('=')[1] ?? '';
      await get('/v1/me', { cookie });
      await get('/v1/me');
      await postWithCookie('/v1/auth/sign-out', {}, cookie);
      await post('/v1/auth/verify-email', { token: 'not-a-real-token' });
    } finally {
      spy.mockRestore();
    }

    const transcript = seen.join('\n');
    expect(transcript).not.toContain('Correct-horse-41');
    expect(transcript).not.toContain(await tokenFromLastMessage());
    // No action URLs, tokens or query strings: request logs carry the matched
    // route pattern (`/v1/auth/verify-email`) but never `?token=...`.
    expect(transcript).not.toContain('token=');
    expect(transcript).not.toContain('?token=');
    // Session cookies/tokens never enter logs.
    expect(transcript).not.toContain('better-auth.session_token=');
    if (captured.value.length > 0) {
      expect(transcript).not.toContain(captured.value);
    }
  });
});

// Builds a genuinely expired HS256 email-verification token with the same
// contract Better Auth verifies (payload email + exp), signed with the test
// environment secret. Proves expired actions fail safely end to end.
async function expiredTokenFor(email: string): Promise<string> {
  const secret = new TextEncoder().encode(resolveAuthSecret(testEnv()));
  const encode = (value: unknown): string =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const past = Math.floor(Date.now() / 1000) - 7200;
  const payload = encode({ email: email.toLowerCase(), iat: past, exp: past + 60 });
  const signature = await crypto.subtle.sign(
    'HMAC',
    await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, [
      'sign',
    ]),
    new TextEncoder().encode(`${header}.${payload}`),
  );
  const signaturePart = Buffer.from(signature)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
  return `${header}.${payload}.${signaturePart}`;
}
