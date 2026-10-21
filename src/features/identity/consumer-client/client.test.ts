import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import type { Env } from '../../../env.js';
import { InMemoryAuthMailer } from '../mailer.js';
import { createMemoryLogoutBroadcast } from './client.js';
import { createConsumerClient, ConsumerClientError } from './client.js';
import {
  loadStoredSession,
  jwksStorageKey,
  tokenStorageKey,
  type KeyValueStorage,
} from './storage.js';

// Seam under test (spec #150, ADR-0013, ticket #152): the shipped consumer
// client against the real application HTTP boundary with disposable D1 and
// captured test mail. A counting cookie-jar transport observes every request
// so these tests prove valid-token reuse performs zero identity/token
// calls, concurrent expiry coalesces into one renewal, and revocation,
// outage and logout behave as specified. No mocked identity API: the only
// stubs are transport-level outage/5xx simulations for paths no live server
// can produce on demand.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

function testEnv(): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
}

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

function memoryStorage(): KeyValueStorage {
  const backing = new Map<string, string>();
  return {
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

interface Jar {
  readonly fetchImpl: typeof fetch;
  count(path: string): number;
  resetCounts(): void;
  clearCookie(): void;
}

function createJar(overrides?: { failPaths?: Record<string, number>; throwPaths?: string[] }): Jar {
  const counts = new Map<string, number>();
  const jar = new Map<string, string>();
  const failPaths = overrides?.failPaths ?? {};
  const throwPaths = new Set(overrides?.throwPaths ?? []);
  const fetchImpl = (async (input: unknown, init?: RequestInit): Promise<Response> => {
    // openapi-fetch builds a Request object and calls fetch(request); plain
    // calls use fetch(url, init). Both shapes converge here so the jar sees
    // the real method, headers and body either way.
    const outgoing =
      typeof input === 'string'
        ? new Request(input, {
            method: init?.method ?? 'GET',
            headers: init?.headers,
            body: init?.body ?? undefined,
          })
        : (input as Request);
    const { pathname } = new URL(outgoing.url, 'http://localhost');
    counts.set(pathname, (counts.get(pathname) ?? 0) + 1);
    if (throwPaths.has(pathname)) {
      throw new TypeError('fetch failed');
    }
    const failed = failPaths[pathname];
    if (failed !== undefined) {
      return new Response(JSON.stringify({ code: 'internal-error', status: 500 }), {
        status: failed,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    const headers = new Headers(outgoing.headers);
    if (jar.size > 0 && !headers.has('cookie')) {
      headers.set(
        'cookie',
        [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; '),
      );
    }
    // Rebuild explicitly: cloning a consumed Request object inside workerd
    // drops the body, so the text is forwarded as the init payload.
    const bodyText =
      outgoing.method === 'GET' || outgoing.method === 'HEAD' ? undefined : await outgoing.text();
    const res = await app.request(
      outgoing.url,
      { method: outgoing.method, headers, body: bodyText },
      testEnv(),
    );
    for (const setCookie of res.headers.getSetCookie()) {
      const pair = setCookie.split(';')[0]?.trim() ?? '';
      const equals = pair.indexOf('=');
      if (equals > 0) {
        const name = pair.slice(0, equals);
        const value = pair.slice(equals + 1);
        if (value.length === 0) {
          jar.delete(name);
        } else {
          jar.set(name, value);
        }
      }
    }
    return res;
  }) as typeof fetch;
  return {
    fetchImpl,
    count: (path: string) => counts.get(path) ?? 0,
    resetCounts: () => {
      counts.clear();
    },
    clearCookie: () => {
      jar.clear();
    },
  };
}

const SCOPE = {
  service: 'http://localhost',
  issuer: 'https://local.user-service.internal',
  audience: 'user-service-local',
};

function verificationToken(): string {
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

describe('consumer client anonymous behaviour', () => {
  it('makes no identity request on an anonymous page without local credentials', async () => {
    const jar = createJar();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: memoryStorage(),
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    expect(await client.getSnapshot()).toBeNull();
    expect(jar.count('/v1/me')).toBe(0);
    expect(jar.count('/v1/auth/token')).toBe(0);
    expect(jar.count('/v1/auth/jwks')).toBe(0);
  });
});

describe('consumer client login and reuse', () => {
  it('registers, verifies and logs in through typed APIs with a shared snapshot', async () => {
    const jar = createJar();
    const store = memoryStorage();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    const snapshot = await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    expect(snapshot.email).toBe('ada@example.com');
    expect(snapshot.emailVerified).toBe(true);
    expect(snapshot.id.length).toBeGreaterThan(0);
    expect(Number.isInteger(snapshot.expiresAt)).toBe(true);
    expect(loadStoredSession(store, SCOPE)?.accessToken.length).toBeGreaterThan(0);
  });

  it('reuses a valid token across navigations with zero identity/token calls', async () => {
    const jar = createJar();
    const store = memoryStorage();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    const first = await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    jar.resetCounts();
    // Repeated navigations/reloads with an unexpired stored token.
    for (let page = 0; page < 3; page += 1) {
      const snapshot = await client.getSnapshot();
      expect(snapshot).toEqual(first);
    }
    expect(jar.count('/v1/me')).toBe(0);
    expect(jar.count('/v1/auth/token')).toBe(0);
  });

  it('reuses cached verification keys across client instances without refetching', async () => {
    const jar = createJar();
    const store = memoryStorage();
    const loginClient = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    await loginClient.register({
      name: 'Ada',
      email: 'ada@example.com',
      password: 'correct-horse-41',
    });
    await loginClient.verifyEmail(verificationToken());
    const first = await loginClient.login({
      email: 'ada@example.com',
      password: 'correct-horse-41',
    });

    // A fresh instance in another document shares only the tab store: the
    // persisted token and keys verify locally with zero requests.
    const second = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });
    jar.resetCounts();
    expect(await second.getSnapshot()).toEqual(first);
    expect(jar.count('/v1/me')).toBe(0);
    expect(jar.count('/v1/auth/token')).toBe(0);
    expect(jar.count('/v1/auth/jwks')).toBe(0);
  });

  it('keeps separate users and deployments isolated', async () => {
    const jar = createJar();
    const store = memoryStorage();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    // A later login for another user replaces previous state.
    await client.register({ name: 'Bea', email: 'bea@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    const second = await client.login({ email: 'bea@example.com', password: 'correct-horse-41' });
    expect(second.email).toBe('bea@example.com');
    expect(loadStoredSession(store, SCOPE)?.user.email).toBe('bea@example.com');

    // An unrelated deployment scope shares nothing.
    const foreign = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: 'https://other.example',
      audience: 'other-audience',
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });
    jar.resetCounts();
    expect(await foreign.getSnapshot()).toBeNull();
    expect(jar.count('/v1/me')).toBe(0);
    expect(jar.count('/v1/auth/token')).toBe(0);
  });
});

describe('consumer client renewal', () => {
  async function loggedIn(): Promise<{ jar: Jar; store: KeyValueStorage }> {
    const jar = createJar();
    const store = memoryStorage();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });
    return { jar, store };
  }

  function expireStored(store: KeyValueStorage): void {
    const key = tokenStorageKey(SCOPE);
    const raw = store.getItem(key);
    if (raw === null) {
      throw new Error('Expected a stored session to expire.');
    }
    const parsed = JSON.parse(raw) as { expiresAt: number };
    expect(parsed.expiresAt).toBeGreaterThan(1);
    store.setItem(key, JSON.stringify({ ...(JSON.parse(raw) as object), expiresAt: 1 }));
  }

  it('coalesces simultaneous consumers into one lazy renewal after expiry', async () => {
    const { jar, store } = await loggedIn();
    expireStored(store);
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    jar.resetCounts();
    const snapshots = await Promise.all([
      client.getSnapshot(),
      client.getSnapshot(),
      client.getSnapshot(),
      client.getSnapshot(),
      client.getSnapshot(),
    ]);
    for (const snapshot of snapshots) {
      expect(snapshot?.email).toBe('ada@example.com');
    }
    expect(jar.count('/v1/auth/token')).toBe(1);
    expect(jar.count('/v1/me')).toBe(0);
  });

  it('clears expired authentication on 401 after the renewal session is lost', async () => {
    const { jar, store } = await loggedIn();
    expireStored(store);
    // Lose the renewal session server-side without touching local state.
    jar.clearCookie();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });

    jar.resetCounts();
    expect(await client.getSnapshot()).toBeNull();
    expect(jar.count('/v1/auth/token')).toBe(1);
    expect(loadStoredSession(store, SCOPE)).toBeNull();
  });

  it('preserves a newer login when an older renewal is denied late', async () => {
    const { jar, store } = await loggedIn();
    expireStored(store);
    jar.clearCookie();
    let release: () => void = () => undefined;
    let received: () => void = () => undefined;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const responseReady = new Promise<void>((done) => {
      received = done;
    });
    let hold = true;
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await jar.fetchImpl(input, init);
      if (hold && input instanceof Request && new URL(input.url).pathname === '/v1/auth/token') {
        hold = false;
        expect(response.status).toBe(401);
        received();
        await blocked;
      }
      return response;
    };
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      ...SCOPE,
      sessionStore: store,
      broadcast: null,
      fetchImpl,
    });
    const pending = client.getSnapshot();
    await responseReady;
    await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });
    release();
    expect(await pending).toBeNull();
    expect((await client.getSnapshot())?.email).toBe('ada@example.com');
    expect(loadStoredSession(store, SCOPE)?.user.email).toBe('ada@example.com');
  });

  it('does not restore credentials when logout wins over an in-flight renewal', async () => {
    const { jar, store } = await loggedIn();
    expireStored(store);
    let release: () => void = () => undefined;
    let received: () => void = () => undefined;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const responseReady = new Promise<void>((done) => {
      received = done;
    });
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await jar.fetchImpl(input, init);
      if (input instanceof Request && new URL(input.url).pathname === '/v1/auth/token') {
        received();
        await blocked;
      }
      return response;
    };
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      ...SCOPE,
      sessionStore: store,
      broadcast: null,
      fetchImpl,
    });
    const pending = client.getSnapshot();
    await responseReady;
    await client.logout();
    release();
    expect(await pending).toBeNull();
    expect(loadStoredSession(store, SCOPE)).toBeNull();
  });

  it('keeps credentials unavailable during a key-rollover outage', async () => {
    const { jar, store } = await loggedIn();
    const key = jwksStorageKey(SCOPE);
    const cached = JSON.parse(store.getItem(key) ?? '{}') as {
      fetchedAtSeconds: number;
      keys: { kid: string }[];
    };
    store.setItem(
      key,
      JSON.stringify({
        ...cached,
        keys: cached.keys.map((entry) => ({ ...entry, kid: 'previous-signing-key' })),
      }),
    );
    let keyRequests = 0;
    const fetchImpl: typeof fetch = (input, init) => {
      if (input instanceof Request && new URL(input.url).pathname === '/v1/auth/jwks') {
        keyRequests += 1;
        return Promise.resolve(
          new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }),
        );
      }
      return jar.fetchImpl(input, init);
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const client = createConsumerClient({
        baseUrl: 'http://localhost',
        ...SCOPE,
        sessionStore: store,
        broadcast: null,
        fetchImpl,
      });
      await expect(client.getSnapshot()).rejects.toMatchObject({ code: 'service-unavailable' });
      expect(loadStoredSession(store, SCOPE)?.user.email).toBe('ada@example.com');
    }
    expect(keyRequests).toBe(1);
  });

  it('reports service failure as unavailable without extending validity', async () => {
    const { store } = await loggedIn();
    expireStored(store);
    const failing = createJar({ failPaths: { '/v1/auth/token': 500 } });
    // Carry the live session cookie across transports is unnecessary here:
    // the failure happens before session evaluation matters.
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: failing.fetchImpl,
    });

    const failure = await client.getSnapshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConsumerClientError);
    expect((failure as ConsumerClientError).code).toBe('service-unavailable');
    // Validity is not extended by the outage: the stored expiry stays past.
    expect(loadStoredSession(store, SCOPE)?.expiresAt).toBe(1);
  });

  it('reports network failure as unavailable, not anonymous', async () => {
    const { store } = await loggedIn();
    expireStored(store);
    const offline = createJar({ throwPaths: ['/v1/auth/token'] });
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: offline.fetchImpl,
      renewalRetryDelayMs: 0,
    });

    const failure = await client.getSnapshot().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConsumerClientError);
    expect((failure as ConsumerClientError).code).toBe('network-unavailable');
  });
});

describe('consumer client logout', () => {
  it('clears local state, revokes the session and notifies same-origin tabs', async () => {
    const jar = createJar();
    const broadcast = createMemoryLogoutBroadcast();
    const storeA = memoryStorage();
    const storeB = memoryStorage();
    const scope = { ...SCOPE };
    const make = (store: KeyValueStorage) =>
      createConsumerClient({
        baseUrl: 'http://localhost',
        issuer: scope.issuer,
        audience: scope.audience,
        sessionStore: store,
        broadcast,
        fetchImpl: jar.fetchImpl,
      });
    const clientA = make(storeA);
    const clientB = make(storeB);

    await clientA.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await clientA.verifyEmail(verificationToken());
    await clientA.login({ email: 'ada@example.com', password: 'correct-horse-41' });
    // A second tab bootstraps from its own login; both hold credentials.
    await clientB.login({ email: 'ada@example.com', password: 'correct-horse-41' });
    expect(loadStoredSession(storeB, scope)).not.toBeNull();

    await clientA.logout();

    expect(loadStoredSession(storeA, scope)).toBeNull();
    // Credential-free propagation cleared the other tab without sharing tokens.
    expect(loadStoredSession(storeB, scope)).toBeNull();
    jar.resetCounts();
    expect(await clientB.getSnapshot()).toBeNull();
    expect(jar.count('/v1/me')).toBe(0);
    expect(jar.count('/v1/auth/token')).toBe(0);
  });

  it('surfaces a failed server logout instead of presenting successful revocation', async () => {
    const jar = createJar();
    const store = memoryStorage();
    const client = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: jar.fetchImpl,
    });
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    const failing = createJar({ failPaths: { '/v1/auth/sign-out': 500 } });
    const doomed = createConsumerClient({
      baseUrl: 'http://localhost',
      issuer: SCOPE.issuer,
      audience: SCOPE.audience,
      sessionStore: store,
      broadcast: null,
      fetchImpl: failing.fetchImpl,
    });
    const failure = await doomed.logout().then(
      () => null,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(ConsumerClientError);
    expect((failure as ConsumerClientError).code).toBe('logout-failed');
    expect(loadStoredSession(store, SCOPE)).toBeNull();
  });
});
