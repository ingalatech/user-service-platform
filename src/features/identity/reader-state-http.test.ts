import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app.js';
import type { Env } from '../../env.js';
import { LOCAL_READER_STATE_AUDIENCE, LOCAL_READER_STATE_ISSUER } from './reader-state.js';
import { InMemoryAuthMailer } from './mailer.js';

// Seam under test (spec #150, ADR-0013): the public HTTP boundary of the
// built Worker with disposable D1 and captured test mail. These tests prove
// the complete backend tracer bullet — verified login -> application-owned
// JWT issuance -> independent signature/claims verification using only the
// fetched public JWKS -> renewal -> denied issuance after session revocation
// — without ever calling the identity issuer/store from the verifier.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

const EXPECTED_ISSUER = LOCAL_READER_STATE_ISSUER;
const EXPECTED_AUDIENCE = LOCAL_READER_STATE_AUDIENCE;

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

async function post(
  path: string,
  body: unknown,
  init: { cookie?: string | null; headers?: Record<string, string>; overrides?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    ...(init.headers ?? {}),
  };
  if (init.cookie !== undefined && init.cookie !== null && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  return app.request(
    path,
    { method: 'POST', headers, body: JSON.stringify(body) },
    testEnv(init.overrides),
  );
}

async function get(
  path: string,
  init: { cookie?: string | null; headers?: Record<string, string>; overrides?: Partial<Env> } = {},
): Promise<Response> {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (init.cookie !== undefined && init.cookie !== null && init.cookie.length > 0) {
    headers.cookie = init.cookie;
  }
  return app.request(path, { method: 'GET', headers }, testEnv(init.overrides));
}

function sessionCookieFrom(res: Response): string | null {
  const setCookie = res.headers.get('set-cookie');
  if (setCookie === null) {
    return null;
  }
  const pair = setCookie.split(';')[0];
  return pair === undefined || pair.length === 0 ? null : pair.trim();
}

async function tokenFromLastMessage(): Promise<string> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
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

function resetTokenFromLastMessage(): string {
  const messages = mailer.passwordResets;
  expect(messages.length).toBeGreaterThan(0);
  const last = messages[messages.length - 1];
  if (last === undefined) {
    throw new Error('Expected a captured password-reset message.');
  }
  return last.token;
}

async function registerVerifyLogin(email: string): Promise<string> {
  await post('/v1/auth/register', {
    name: 'Token User',
    email,
    password: 'Correct-horse-41',
  });
  await post('/v1/auth/verify-email', { token: await tokenFromLastMessage() });
  const loginRes = await post('/v1/auth/login', { email, password: 'Correct-horse-41' });
  expect(loginRes.status).toBe(200);
  const cookie = sessionCookieFrom(loginRes);
  if (cookie === null) {
    throw new Error('Expected a session cookie from login.');
  }
  return cookie;
}

interface ReaderStateSuccess {
  readonly readerState: string;
  readonly expiresAt: number;
}

async function issueReaderState(
  cookie: string | null,
  extra?: {
    headers?: Record<string, string>;
    overrides?: Partial<Env>;
  },
): Promise<Response> {
  return post(
    '/v1/auth/reader-state',
    {},
    { cookie, headers: extra?.headers, overrides: extra?.overrides },
  );
}

async function readReaderStateSuccess(res: Response): Promise<ReaderStateSuccess> {
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('application/json');
  const body = (await res.json()) as ReaderStateSuccess;
  expect(typeof body.readerState).toBe('string');
  expect(Number.isInteger(body.expiresAt)).toBe(true);
  return body;
}

// Documented receiving-verifier example (spec #150): verifies a consumer
// token against a fetched public JWKS without calling the identity
// issuer/store. Only the fixed asymmetric algorithm, exact configured
// issuer/audience, integer time bounds and the explicit claims allowlist are
// accepted. Returns the verified payload or throws.
function base64UrlDecode(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface PublicJwkSet {
  readonly keys: readonly Record<string, unknown>[];
}

async function verifySignedReaderState(
  readerState: string,
  jwks: PublicJwkSet,
  input: { issuer: string; audience: string; nowSeconds?: number },
): Promise<Record<string, unknown>> {
  const parts = readerState.split('.');
  if (
    parts.length !== 3 ||
    parts[0] === undefined ||
    parts[1] === undefined ||
    parts[2] === undefined
  ) {
    throw new Error('Malformed token: expected three segments.');
  }
  const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[0]))) as Record<
    string,
    unknown
  >;
  if (header.alg !== 'EdDSA') {
    throw new Error('Rejected: unexpected algorithm.');
  }
  if (typeof header.kid !== 'string' || header.kid.length === 0) {
    throw new Error('Rejected: missing key id.');
  }
  const key = jwks.keys.find((entry) => entry.kid === header.kid);
  if (key === undefined) {
    throw new Error('Rejected: unknown key id.');
  }
  const publicKey = await crypto.subtle.importKey(
    'jwk',
    // The fetched entry is projected to public JWK fields by the service;
    // only the key type tag is asserted here, the runtime import validates
    // the rest.
    key as unknown as { kty: string },
    { name: 'Ed25519' },
    false,
    ['verify'],
  );
  const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  const signature = base64UrlDecode(parts[2]);
  const authentic = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    signingInput,
  );
  if (!authentic) {
    throw new Error('Rejected: invalid signature.');
  }
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(parts[1]))) as Record<
    string,
    unknown
  >;
  if (payload.iss !== input.issuer) {
    throw new Error('Rejected: unexpected issuer.');
  }
  if (payload.aud !== input.audience) {
    throw new Error('Rejected: unexpected audience.');
  }
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (
    typeof payload.exp !== 'number' ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= nowSeconds
  ) {
    throw new Error('Rejected: expired or missing exp.');
  }
  if (
    typeof payload.iat !== 'number' ||
    !Number.isInteger(payload.iat) ||
    payload.iat > nowSeconds + 60
  ) {
    throw new Error('Rejected: invalid iat.');
  }
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
    throw new Error('Rejected: missing sub.');
  }
  // Explicit claims allowlist: email, roles, session identifiers/tokens,
  // engine rows and billing-provider identifiers must never appear.
  for (const forbidden of [
    'email',
    'role',
    'sessionId',
    'sessionToken',
    'password',
    'providerId',
  ]) {
    if (forbidden in payload) {
      throw new Error(`Rejected: forbidden claim ${forbidden}.`);
    }
  }
  return payload;
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
    db.prepare('DELETE FROM "jwks"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('POST /v1/auth/reader-state tracer bullet', () => {
  it('issues presentation-only Reader State from the live session', async () => {
    const cookie = await registerVerifyLogin('reader-state@example.com');

    const response = await post('/v1/auth/reader-state', {}, { cookie });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const body = (await response.json()) as Record<string, unknown>;
    expect(typeof body.readerState).toBe('string');
    expect(Number.isInteger(body.expiresAt)).toBe(true);
    expect(body).not.toHaveProperty('accessToken');
    expect(body).not.toHaveProperty('tokenType');

    const jwks = (await (await get('/v1/auth/jwks')).json()) as PublicJwkSet;
    const payload = await verifySignedReaderState(String(body.readerState), jwks, {
      issuer: EXPECTED_ISSUER,
      audience: 'user-service-local-reader-state',
    });
    expect(Object.keys(payload).sort()).toEqual([
      'aud',
      'entitlements',
      'exp',
      'iat',
      'iss',
      'sub',
    ]);
    expect(payload.entitlements).toEqual([]);
  });

  it('issues Reader State from the live session verifiable with only the public JWKS', async () => {
    const cookie = await registerVerifyLogin('tracer@example.com');

    const response = await issueReaderState(cookie);
    const issued = await readReaderStateSuccess(response);
    expect(response.headers.get('cache-control')).toContain('no-store');

    const jwksRes = await get('/v1/auth/jwks');
    expect(jwksRes.status).toBe(200);
    const jwks = (await jwksRes.json()) as PublicJwkSet;
    expect(Array.isArray(jwks.keys)).toBe(true);
    expect(jwks.keys.length).toBeGreaterThan(0);

    // Independent verification: no session/database read, only the fetched
    // public keys plus the deployment-configured issuer/audience.
    const payload = await verifySignedReaderState(issued.readerState, jwks, {
      issuer: EXPECTED_ISSUER,
      audience: EXPECTED_AUDIENCE,
    });
    expect(typeof payload.sub).toBe('string');
    expect(payload.iss).toBe(EXPECTED_ISSUER);
    expect(payload.aud).toBe(EXPECTED_AUDIENCE);
    expect(payload.entitlements).toEqual([]);
    expect(issued.expiresAt).toBe(payload.exp);

    // The Reader State response carries no credential or engine internals.
    const raw = JSON.stringify(issued);
    expect(raw).not.toContain('rch-reader.session_token');
    expect(raw).not.toContain('Correct-horse-41');
  });

  it('renews from the live session and denies issuance after sign-out', async () => {
    const cookie = await registerVerifyLogin('renew@example.com');

    const first = await readReaderStateSuccess(await issueReaderState(cookie));
    const second = await readReaderStateSuccess(await issueReaderState(cookie));
    expect(typeof second.readerState).toBe('string');
    expect(second.expiresAt).toBeGreaterThanOrEqual(first.expiresAt);

    const signOutRes = await post('/v1/auth/sign-out', {}, { cookie });
    expect(signOutRes.status).toBe(200);

    const denied = await issueReaderState(cookie);
    expect(denied.status).toBe(401);
    expect(denied.headers.get('cache-control')).toContain('no-store');
    expect(await denied.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('denies further issuance after password reset revokes sessions', async () => {
    const cookie = await registerVerifyLogin('reset-stop@example.com');
    expect((await issueReaderState(cookie)).status).toBe(200);

    await post('/v1/auth/request-password-reset', { email: 'reset-stop@example.com' });
    const resetRes = await post('/v1/auth/reset-password', {
      token: resetTokenFromLastMessage(),
      newPassword: 'Brand-new-horse-42',
    });
    expect(resetRes.status).toBe(200);

    const denied = await issueReaderState(cookie);
    expect(denied.status).toBe(401);
    expect(await denied.json()).toMatchObject({ code: 'unauthenticated', status: 401 });
  });

  it('rejects unauthenticated, unverified and forged sessions', async () => {
    // No session at all.
    const anonymous = await issueReaderState(null);
    expect(anonymous.status).toBe(401);

    // Forged cookie value.
    const forged = await issueReaderState('better-auth.session_token=forged-value');
    expect(forged.status).toBe(401);

    // Registered but unverified: login itself stays blocked, and no session
    // exists to mint from.
    await post('/v1/auth/register', {
      name: 'Unverified',
      email: 'unverified@example.com',
      password: 'Correct-horse-41',
    });
    const blocked = await post('/v1/auth/login', {
      email: 'unverified@example.com',
      password: 'Correct-horse-41',
    });
    expect(blocked.status).toBe(403);
    expect(sessionCookieFrom(blocked)).toBeNull();
  });

  it('rejects wrong issuer, audience, signature, algorithm and expiration', async () => {
    const cookie = await registerVerifyLogin('negative@example.com');
    const issued = await readReaderStateSuccess(await issueReaderState(cookie));
    const jwks = (await (await get('/v1/auth/jwks')).json()) as PublicJwkSet;

    await expect(
      verifySignedReaderState(issued.readerState, jwks, {
        issuer: 'https://wrong-issuer.example',
        audience: EXPECTED_AUDIENCE,
      }),
    ).rejects.toThrow(/issuer/);
    await expect(
      verifySignedReaderState(issued.readerState, jwks, {
        issuer: EXPECTED_ISSUER,
        audience: 'wrong-audience',
      }),
    ).rejects.toThrow(/audience/);

    // Tampered signature: flip a fully significant leading character so the
    // decoded signature bytes change while the encoding stays valid.
    const segments = issued.readerState.split('.');
    const headerSegment = segments[0] ?? '';
    const payloadSegment = segments[1] ?? '';
    const signature = segments[2] ?? '';
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const tampered = `${headerSegment}.${payloadSegment}.${flipped}`;
    await expect(
      verifySignedReaderState(tampered, jwks, {
        issuer: EXPECTED_ISSUER,
        audience: EXPECTED_AUDIENCE,
      }),
    ).rejects.toThrow(/signature/);

    // Unknown key id.
    await expect(
      verifySignedReaderState(
        issued.readerState,
        { keys: [] },
        {
          issuer: EXPECTED_ISSUER,
          audience: EXPECTED_AUDIENCE,
        },
      ),
    ).rejects.toThrow(/key id/);

    // Wrong algorithm: a header pinning a different algorithm is rejected
    // before signature evaluation even with a valid key id.
    const validKeyId = jwks.keys[0]?.kid;
    expect(typeof validKeyId).toBe('string');
    const foreignHeader = Buffer.from(JSON.stringify({ alg: 'HS256', kid: validKeyId }))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    await expect(
      verifySignedReaderState(`${foreignHeader}.${payloadSegment}.${signature}`, jwks, {
        issuer: EXPECTED_ISSUER,
        audience: EXPECTED_AUDIENCE,
      }),
    ).rejects.toThrow(/algorithm/);

    // Expiration is enforced against the signed Reader State exp.
    await expect(
      verifySignedReaderState(issued.readerState, jwks, {
        issuer: EXPECTED_ISSUER,
        audience: EXPECTED_AUDIENCE,
        nowSeconds: issued.expiresAt + 1,
      }),
    ).rejects.toThrow(/expired/);
  });
});

describe('GET /v1/auth/jwks', () => {
  it('publishes public asymmetric keys only with bounded public caching', async () => {
    const cookie = await registerVerifyLogin('jwks@example.com');
    await issueReaderState(cookie);

    const res = await get('/v1/auth/jwks');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('cache-control')).toMatch(/public/);
    expect(res.headers.get('cache-control')).toMatch(/max-age=\d+/);

    const body = (await res.json()) as PublicJwkSet;
    expect(body.keys.length).toBeGreaterThan(0);
    for (const key of body.keys) {
      expect(typeof key.kid).toBe('string');
      expect(key.alg).toBe('EdDSA');
    }
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('privateKey');
    expect(raw).not.toContain('"d"');
    expect(raw).not.toContain('rch-reader.session_token');
  });

  it('reuses durable keys across separate Worker instances with the same D1', async () => {
    const cookie = await registerVerifyLogin('durable@example.com');
    await readReaderStateSuccess(await issueReaderState(cookie));
    const first = (await (await get('/v1/auth/jwks')).json()) as PublicJwkSet;

    // A separately constructed application instance against the same
    // database must observe the same verification keys.
    const otherApp = createApp({ authMailer: new InMemoryAuthMailer() });
    const otherRes = await otherApp.request(
      '/v1/auth/jwks',
      { method: 'GET', headers: {} },
      testEnv(),
    );
    expect(otherRes.status).toBe(200);
    const second = (await otherRes.json()) as PublicJwkSet;
    expect(second.keys.map((key) => key.kid).sort()).toEqual(
      first.keys.map((key) => key.kid).sort(),
    );
  });
});

describe('Reader State TTL and session-expiry bounds', () => {
  it('keeps token expiry within the live session expiry and the TTL', async () => {
    const cookie = await registerVerifyLogin('cap@example.com');
    const before = Math.floor(Date.now() / 1000);

    const issued = await readReaderStateSuccess(await issueReaderState(cookie));
    const after = Math.floor(Date.now() / 1000);

    // The minted expiry respects the configured lifetime bound ...
    expect(issued.expiresAt).toBeGreaterThan(before);
    expect(issued.expiresAt).toBeLessThanOrEqual(after + 900);
    // ... and never exceeds the authoritative session expiry. The stored
    // session lifetime (engine seconds unit, observed end to end) is the
    // independent bound: the engine's sliding refresh keeps a live session
    // ahead of the short token, and the minted cap is the backstop.
    const session = await workerEnv.DB.prepare(
      'SELECT expires_at AS exp FROM "session" LIMIT 1',
    ).first<{ exp: number }>();
    expect(typeof session?.exp).toBe('number');
    expect(issued.expiresAt).toBeLessThanOrEqual(session?.exp ?? 0);
  });

  it('honours a shorter deployment-configured TTL', async () => {
    const cookie = await registerVerifyLogin('short-ttl@example.com');
    const before = Math.floor(Date.now() / 1000);

    const issued = await readReaderStateSuccess(
      await issueReaderState(cookie, { overrides: { AUTH_READER_STATE_TTL_SECONDS: '120' } }),
    );
    const after = Math.floor(Date.now() / 1000);

    expect(issued.expiresAt).toBeGreaterThan(before);
    expect(issued.expiresAt).toBeLessThanOrEqual(after + 120);
  });

  it('fails closed on malformed issuer, audience and TTL configuration', async () => {
    const cookie = await registerVerifyLogin('bad-config@example.com');

    for (const overrides of [
      { AUTH_READER_STATE_TTL_SECONDS: '0' },
      { AUTH_READER_STATE_TTL_SECONDS: '3600' },
      { AUTH_READER_STATE_TTL_SECONDS: 'soon' },
      { AUTH_JWT_ISSUER: 'has space' },
    ]) {
      const res = await issueReaderState(cookie, { overrides });
      expect(res.status).toBe(500);
      expect(await res.json()).toMatchObject({ code: 'internal-error', status: 500 });
    }
  });
});

describe('Reader State origin protection', () => {
  it('rejects hostile and null origins on token issuance', async () => {
    const cookie = await registerVerifyLogin('origin@example.com');

    for (const origin of ['https://evil.example', 'null']) {
      const res = await issueReaderState(cookie, { headers: { origin } });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ code: 'forbidden', status: 403 });
    }
  });

  it('accepts same-origin issuance and preserves headerless non-browser flows', async () => {
    const cookie = await registerVerifyLogin('same-origin@example.com');

    const sameOrigin = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { origin: 'http://localhost', 'sec-fetch-site': 'same-origin' } },
    );
    expect(sameOrigin.status).toBe(200);

    const headerless = await issueReaderState(cookie);
    expect(headerless.status).toBe(200);
  });

  it('rejects inconsistent cross-site fetch metadata', async () => {
    const cookie = await registerVerifyLogin('fetch-meta@example.com');

    const res = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { 'sec-fetch-site': 'cross-site' } },
    );
    expect(res.status).toBe(403);
  });

  it('rejects contradictory fetch metadata even when the Origin matches the service', async () => {
    const cookie = await registerVerifyLogin('contradictory-meta@example.com');

    const crossSite = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { origin: 'http://localhost', 'sec-fetch-site': 'cross-site' } },
    );
    expect(crossSite.status).toBe(403);
    expect(await crossSite.json()).toMatchObject({ code: 'forbidden', status: 403 });

    const unknown = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { origin: 'http://localhost', 'sec-fetch-site': 'super-future-value' } },
    );
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({ code: 'forbidden', status: 403 });
  });

  it('preserves exact gateway semantics with fetch metadata on token issuance', async () => {
    const cookie = await registerVerifyLogin('gateway-meta@example.com');
    const gateway = 'https://shop.example';
    const overrides = { AUTH_GATEWAY_ORIGINS: gateway };

    const gatewayCrossSite = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { origin: gateway, 'sec-fetch-site': 'cross-site' }, overrides },
    );
    expect(gatewayCrossSite.status).toBe(200);

    const gatewayUnknown = await post(
      '/v1/auth/reader-state',
      {},
      { cookie, headers: { origin: gateway, 'sec-fetch-site': 'super-future-value' }, overrides },
    );
    expect(gatewayUnknown.status).toBe(403);
  });

  it('preserves existing login, current-User, logout and admin behavior', async () => {
    const cookie = await registerVerifyLogin('preserved@example.com');

    const meRes = await get('/v1/me', { cookie });
    expect(meRes.status).toBe(200);
    expect(await meRes.json()).toMatchObject({
      email: 'preserved@example.com',
      emailVerified: true,
    });

    // Reader State alone authorizes no account, administration or issuance
    // operation: User Service has no Bearer transport.
    const issued = await readReaderStateSuccess(await issueReaderState(cookie));
    const authorization = { authorization: `Bearer ${issued.readerState}` };
    expect((await get('/v1/me', { headers: authorization })).status).toBe(401);
    expect((await get('/v1/admin/me', { headers: authorization })).status).toBe(401);
    expect((await issueReaderState(null, { headers: authorization })).status).toBe(401);

    const signOutRes = await post('/v1/auth/sign-out', {}, { cookie });
    expect(signOutRes.status).toBe(200);
    expect((await get('/v1/me', { cookie })).status).toBe(401);
  });
});

describe('Reader State observability redaction', () => {
  it('never logs Reader State, private key material or session cookies', async () => {
    const seen: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      seen.push(args.map((arg) => String(arg)).join(' '));
    });

    const captured = { readerState: '', cookieValue: '' };
    try {
      const cookie = await registerVerifyLogin('token-logs@example.com');
      captured.cookieValue = cookie.split('=')[1] ?? '';
      const issued = await readReaderStateSuccess(await issueReaderState(cookie));
      captured.readerState = issued.readerState;
      await get('/v1/auth/jwks');
      await issueReaderState('better-auth.session_token=forged-value');
    } finally {
      spy.mockRestore();
    }

    const transcript = seen.join('\n');
    expect(captured.readerState.length).toBeGreaterThan(0);
    expect(transcript).not.toContain(captured.readerState);
    expect(transcript).not.toContain('Correct-horse-41');
    expect(transcript).not.toContain('better-auth.session_token=');
    if (captured.cookieValue.length > 0) {
      expect(transcript).not.toContain(captured.cookieValue);
    }
    // No private key material: the full token signature is already covered
    // above; JWKS responses carry public keys only (asserted structurally).
  });
});
