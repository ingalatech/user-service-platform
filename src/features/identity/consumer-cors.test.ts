import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import {
  CONSUMER_CORS_ALLOWED_HEADERS,
  CONSUMER_CORS_ALLOWED_METHODS,
  CONSUMER_CORS_PREFLIGHT_MAX_AGE_SECONDS,
  areRequestedHeadersAllowed,
  evaluateConsumerCorsOrigin,
  isAllowedConsumerCorsMethod,
} from './consumer-cors.js';
import { InMemoryAuthMailer } from './mailer.js';
import { resolveConsumerOrigins } from './origin-guard.js';

// Seam under test (spec #164, ADR-0013): the direct-browser transport adds
// exact credentialed CORS on the public consumer identity operations while
// cookie-auth mutations keep their Origin/Fetch Metadata authorization. These
// tests prove the HTTP contract — exact grants, preflight without a session,
// bounded cache, no wildcard/null reflection, denied origins cannot mutate —
// and the complete register -> captured verification -> login -> me ->
// token -> JWKS -> sign-out lifecycle from a configured consumer origin.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

const CONSUMER_ORIGIN = 'https://www.rugbychampagne.test';

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

interface RequestInitLike {
  readonly cookie?: string | null;
  readonly headers?: Record<string, string>;
  readonly overrides?: Partial<Env>;
}

function customHeaders(init: RequestInitLike): Record<string, string> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== undefined && init.cookie !== null && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  return headers;
}

async function post(path: string, body: unknown, init: RequestInitLike = {}): Promise<Response> {
  const headers = { 'content-type': 'application/json', ...customHeaders(init) };
  return app.request(
    path,
    { method: 'POST', headers, body: JSON.stringify(body) },
    testEnv(init.overrides),
  );
}

async function get(path: string, init: RequestInitLike = {}): Promise<Response> {
  return app.request(
    path,
    { method: 'GET', headers: customHeaders(init) },
    testEnv(init.overrides),
  );
}

async function options(
  path: string,
  headers: Record<string, string>,
  overrides?: Partial<Env>,
): Promise<Response> {
  return app.request(path, { method: 'OPTIONS', headers }, testEnv(overrides));
}

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

function verificationToken(): string {
  const last = mailer.sent[mailer.sent.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured verification message.');
  }
  const token = new URL(last.url).searchParams.get('token');
  if (token === null) {
    throw new Error('Expected a token in the captured verification action URL.');
  }
  return token;
}

async function registerVerifyLogin(email: string): Promise<string> {
  const originHeaders = { origin: CONSUMER_ORIGIN, 'sec-fetch-site': 'same-site' };
  const overrides = { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN };
  const registered = await post(
    '/v1/auth/register',
    { name: 'Consumer', email, password: 'correct-horse-41' },
    { headers: originHeaders, overrides },
  );
  expect(registered.status).toBe(201);
  // Actual verify-email from the approved consumer origin through the real
  // public verification seam (captured AuthMailer token): proves
  // consumer-origin verification and its CORS grant, not a headerless call.
  const verified = await post(
    '/v1/auth/verify-email',
    { token: verificationToken() },
    { headers: originHeaders, overrides },
  );
  expect(verified.status).toBe(200);
  expect(verified.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
  expect(verified.headers.get('access-control-allow-credentials')).toBe('true');
  expect(verified.headers.get('vary')).toContain('Origin');
  const login = await post(
    '/v1/auth/login',
    { email, password: 'correct-horse-41' },
    { headers: originHeaders, overrides: { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN } },
  );
  expect(login.status).toBe(200);
  const cookie = sessionCookieFrom(login);
  if (cookie === null) {
    throw new Error('Expected a session cookie from login.');
  }
  return cookie;
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
    db.prepare('DELETE FROM "jwks"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('consumer CORS origin resolution', () => {
  it('resolves no extra origins when the slot is unset', () => {
    expect(resolveConsumerOrigins(undefined)).toEqual([]);
    expect(resolveConsumerOrigins('   ')).toEqual([]);
  });

  it('accepts only exact absolute http(s) origins', () => {
    expect(
      resolveConsumerOrigins('https://www.rugbychampagne.test, http://localhost:4321'),
    ).toEqual(['https://www.rugbychampagne.test', 'http://localhost:4321']);
    for (const raw of ['*', 'null', 'https://*.rugbychampagne.test', 'https://x.test/path']) {
      expect(() => resolveConsumerOrigins(raw)).toThrow(/AUTH_CONSUMER_ORIGINS/);
    }
  });

  it('grants only exact membership and never reflects unconfigured origins', () => {
    expect(
      evaluateConsumerCorsOrigin({ origin: CONSUMER_ORIGIN, consumerOrigins: [CONSUMER_ORIGIN] }),
    ).toBe(CONSUMER_ORIGIN);
    for (const origin of [
      null,
      '',
      'null',
      'https://evil.test',
      'https://www.rugbychampagne.test:8443',
    ]) {
      expect(evaluateConsumerCorsOrigin({ origin, consumerOrigins: [CONSUMER_ORIGIN] })).toBeNull();
    }
  });

  it('restricts preflight methods and headers to actual needs', () => {
    for (const method of CONSUMER_CORS_ALLOWED_METHODS) {
      expect(isAllowedConsumerCorsMethod(method.toLowerCase())).toBe(true);
    }
    for (const method of ['DELETE', 'PUT', 'PATCH']) {
      expect(isAllowedConsumerCorsMethod(method)).toBe(false);
    }
    expect(areRequestedHeadersAllowed(null)).toBe(true);
    expect(areRequestedHeadersAllowed('')).toBe(true);
    for (const header of CONSUMER_CORS_ALLOWED_HEADERS) {
      expect(areRequestedHeadersAllowed(header.toUpperCase())).toBe(true);
    }
    expect(areRequestedHeadersAllowed('content-type, authorization')).toBe(true);
    expect(areRequestedHeadersAllowed('content-type, x-evil')).toBe(false);
  });
});

describe('public consumer operation CORS responses', () => {
  it('grants the exact origin with credentials and Vary on success', async () => {
    const res = await post(
      '/v1/auth/register',
      { name: 'Cors User', email: 'cors@example.com', password: 'correct-horse-41' },
      {
        headers: { origin: CONSUMER_ORIGIN, 'sec-fetch-site': 'same-site' },
        overrides: { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('vary')).toContain('Origin');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
  });

  it('grants the exact origin on errors so the browser can read the problem', async () => {
    const res = await get('/v1/me', {
      headers: { origin: CONSUMER_ORIGIN },
      overrides: { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ code: 'unauthenticated' });
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('does not grant an unconfigured origin but still varies by Origin', async () => {
    const res = await get('/v1/me', {
      headers: { origin: 'https://evil.test' },
      overrides: { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    });
    expect(res.status).toBe(401);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('preserves same-origin and headerless non-browser flows without a consumer grant', async () => {
    const headerless = await get('/v1/me');
    expect(headerless.status).toBe(401);
    expect(headerless.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('fails closed on a malformed consumer-origin configuration for browser callers', async () => {
    const res = await get('/v1/me', {
      headers: { origin: CONSUMER_ORIGIN },
      overrides: { AUTH_CONSUMER_ORIGINS: '*' },
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ code: 'internal-error' });
  });

  it('preserves private/no-store and Vary on early malformed-config token/account errors', async () => {
    const overrides = { AUTH_CONSUMER_ORIGINS: '*' };
    for (const request of [
      () => get('/v1/me', { headers: { origin: CONSUMER_ORIGIN }, overrides }),
      () =>
        post(
          '/v1/auth/token',
          {},
          { headers: { origin: CONSUMER_ORIGIN, 'sec-fetch-site': 'same-site' }, overrides },
        ),
    ]) {
      const res = await request();
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: 'internal-error' });
      // The early middleware return bypasses route-level cache handling, so
      // it must preserve the personal/token boundary itself.
      expect(res.headers.get('cache-control')).toContain('private');
      expect(res.headers.get('cache-control')).toContain('no-store');
      expect(res.headers.get('vary')).toContain('Origin');
      // Fail-closed: no CORS grant on malformed configuration.
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    }
  });
});

describe('consumer CORS preflight', () => {
  it('answers an approved preflight without a session using a bounded cache', async () => {
    const res = await options(
      '/v1/auth/login',
      {
        origin: CONSUMER_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type',
      },
      { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    );
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'content-type',
    );
    expect(res.headers.get('access-control-max-age')).toBe(
      String(CONSUMER_CORS_PREFLIGHT_MAX_AGE_SECONDS),
    );
    expect(res.headers.get('vary')).toContain('Origin');
  });

  it('rejects preflights from unapproved origins and non-consumer methods/headers', async () => {
    const denied = await options(
      '/v1/auth/login',
      { origin: 'https://evil.test', 'access-control-request-method': 'POST' },
      { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get('access-control-allow-origin')).toBeNull();

    const badMethod = await options(
      '/v1/auth/login',
      { origin: CONSUMER_ORIGIN, 'access-control-request-method': 'DELETE' },
      { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    );
    expect(badMethod.status).toBe(403);

    const badHeader = await options(
      '/v1/auth/login',
      {
        origin: CONSUMER_ORIGIN,
        'access-control-request-method': 'POST',
        'access-control-request-headers': 'content-type, x-evil',
      },
      { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
    );
    expect(badHeader.status).toBe(403);
  });
});

describe('direct-browser consumer lifecycle from a configured origin', () => {
  it('completes register -> verify -> login -> me -> token -> jwks -> sign-out with credentials', async () => {
    const cookie = await registerVerifyLogin('lifecycle@example.com');
    const overrides = { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN };
    const headers = { origin: CONSUMER_ORIGIN, 'sec-fetch-site': 'same-site' };

    const me = await get('/v1/me', { cookie, headers, overrides });
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ email: 'lifecycle@example.com', emailVerified: true });
    expect(me.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    expect(me.headers.get('cache-control')).toBe('private, no-store');

    const token = await post('/v1/auth/token', {}, { cookie, headers, overrides });
    expect(token.status).toBe(200);
    expect(token.headers.get('cache-control')).toContain('no-store');
    expect(token.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    const issued = (await token.json()) as { accessToken: string };
    expect(typeof issued.accessToken).toBe('string');

    // Renewal with the same live session succeeds before sign-out.
    const renewed = await post('/v1/auth/token', {}, { cookie, headers, overrides });
    expect(renewed.status).toBe(200);
    expect(renewed.headers.get('cache-control')).toContain('no-store');
    expect(renewed.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    const renewedBody = (await renewed.json()) as { accessToken: string };
    expect(typeof renewedBody.accessToken).toBe('string');

    const jwks = await get('/v1/auth/jwks', { headers, overrides });
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);
    expect(jwks.headers.get('cache-control')).toMatch(/public, max-age=/);

    const signOut = await post('/v1/auth/sign-out', {}, { cookie, headers, overrides });
    expect(signOut.status).toBe(200);
    expect(signOut.headers.get('access-control-allow-origin')).toBe(CONSUMER_ORIGIN);

    const after = await post('/v1/auth/token', {}, { cookie, headers, overrides });
    expect(after.status).toBe(401);
  });

  it('rejects cookie mutations from an unconfigured origin even when the endpoint is CORS-enabled', async () => {
    const res = await post(
      '/v1/auth/register',
      { name: 'Hostile', email: 'hostile@example.com', password: 'correct-horse-41' },
      {
        headers: { origin: 'https://evil.test', 'sec-fetch-site': 'cross-site' },
        overrides: { AUTH_CONSUMER_ORIGINS: CONSUMER_ORIGIN },
      },
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'forbidden' });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});
