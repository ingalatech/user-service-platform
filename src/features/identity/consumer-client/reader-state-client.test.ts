import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import type { Env } from '../../../env.js';
import { InMemoryAuthMailer } from '../mailer.js';
import { createConsumerClient, createMemoryReaderStateBroadcast } from './client.js';
import { readerStateStorageKey, type KeyValueStorage } from './storage.js';

const workerEnv = env;
const migrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });
const scope = {
  service: 'http://localhost',
  issuer: 'https://local.user-service.internal',
  audience: 'user-service-local-reader-state',
};

function testEnv(): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  };
}

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function verificationToken(): string {
  const message = mailer.sent.at(-1);
  if (message === undefined) throw new Error('Expected a verification message.');
  const token = new URL(message.url).searchParams.get('token');
  if (token === null) throw new Error('Expected a verification token.');
  return token;
}

function transport() {
  const counts = new Map<string, number>();
  const cookies = new Map<string, string>();
  const authorizationHeaders: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    const request = input as Request;
    const path = new URL(request.url).pathname;
    counts.set(path, (counts.get(path) ?? 0) + 1);
    const headers = new Headers(request.headers);
    const authorization = headers.get('authorization');
    if (authorization !== null) authorizationHeaders.push(authorization);
    if (cookies.size > 0) {
      headers.set('cookie', [...cookies].map(([name, value]) => `${name}=${value}`).join('; '));
    }
    const body = request.method === 'GET' ? undefined : await request.text();
    const response = await app.request(
      request.url,
      { method: request.method, headers, body },
      testEnv(),
    );
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const separator = pair?.indexOf('=') ?? -1;
      if (pair !== undefined && separator > 0) {
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        if (value === '') cookies.delete(name);
        else cookies.set(name, value);
      }
    }
    return response;
  };
  return {
    fetchImpl,
    count: (path: string) => counts.get(path) ?? 0,
    reset: () => {
      counts.clear();
    },
    authorizationHeaders,
  };
}

beforeAll(async () => applyD1Migrations(workerEnv.DB, migrations));

beforeEach(async () => {
  await workerEnv.DB.batch([
    workerEnv.DB.prepare('DELETE FROM "session"'),
    workerEnv.DB.prepare('DELETE FROM "account"'),
    workerEnv.DB.prepare('DELETE FROM "verification"'),
    workerEnv.DB.prepare('DELETE FROM "jwks"'),
    workerEnv.DB.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('Reader State consumer client', () => {
  it('restores verified presentation in a second controller without probing Identity', async () => {
    const network = transport();
    const localStore = memoryStorage();
    const first = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast: null,
      fetchImpl: network.fetchImpl,
    });

    await first.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await first.verifyEmail(verificationToken());
    const authenticated = await first.login({
      email: 'ada@example.com',
      password: 'correct-horse-41',
    });
    expect(authenticated.sessionStatus).toBe('authenticated');
    expect(authenticated.entitlements).toEqual([]);
    const persisted = JSON.parse(
      localStore.getItem(readerStateStorageKey(scope)) ?? '{}',
    ) as Record<string, unknown>;
    expect(typeof persisted.readerState).toBe('string');
    expect(persisted.expiresAt).toBe(authenticated.expiresAt);

    const second = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast: null,
      fetchImpl: network.fetchImpl,
    });
    network.reset();
    const restored = await second.getSnapshot();
    expect(restored).toMatchObject({
      subject: authenticated.subject,
      entitlements: [],
      sessionStatus: 'unknown',
    });
    expect(network.count('/v1/me')).toBe(0);
    expect(network.count('/v1/auth/reader-state')).toBe(0);
    expect(network.count('/v1/auth/jwks')).toBe(0);
    expect(network.authorizationHeaders).toEqual([]);
  });

  it('manually refreshes and lazily coalesces expired Reader State', async () => {
    const network = transport();
    const localStore = memoryStorage();
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast: null,
      fetchImpl: network.fetchImpl,
    });
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await client.verifyEmail(verificationToken());
    await client.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    network.reset();
    expect((await client.refreshReaderState()).sessionStatus).toBe('authenticated');
    expect(network.count('/v1/auth/reader-state')).toBe(1);

    const key = readerStateStorageKey(scope);
    const stored = JSON.parse(localStore.getItem(key) ?? '{}') as Record<string, unknown>;
    localStore.setItem(key, JSON.stringify({ ...stored, expiresAt: 1 }));
    network.reset();
    const results = await Promise.all([
      client.getSnapshot(),
      client.getSnapshot(),
      client.getSnapshot(),
    ]);
    expect(results.every((result) => result?.sessionStatus === 'authenticated')).toBe(true);
    expect(network.count('/v1/auth/reader-state')).toBe(1);
    expect(network.authorizationHeaders).toEqual([]);
  });

  it('synchronizes replacement and logout without allowing stale refresh resurrection', async () => {
    const network = transport();
    const localStore = memoryStorage();
    const broadcast = createMemoryReaderStateBroadcast();
    const first = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: network.fetchImpl,
    });
    const second = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: network.fetchImpl,
    });
    await first.register({ name: 'Ada', email: 'ada@example.com', password: 'correct-horse-41' });
    await first.verifyEmail(verificationToken());
    await first.login({ email: 'ada@example.com', password: 'correct-horse-41' });

    const observed: (string | null)[] = [];
    second.observeReaderState((state) => observed.push(state?.subject ?? null));
    await first.refreshReaderState();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(observed.at(-1)).toBe((await first.getSnapshot())?.subject);
    expect(second.getSessionStatus()).toBe('unknown');

    let release: () => void = () => undefined;
    let responseReady: () => void = () => undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      responseReady = resolve;
    });
    let hold = true;
    const delayedFetch: typeof fetch = async (input) => {
      const response = await network.fetchImpl(input);
      if (
        hold &&
        input instanceof Request &&
        new URL(input.url).pathname === '/v1/auth/reader-state'
      ) {
        hold = false;
        responseReady();
        await blocked;
      }
      return response;
    };
    const delayed = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: delayedFetch,
    });
    const pending = delayed.refreshReaderState();
    await ready;
    await first.logout();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(localStore.getItem(readerStateStorageKey(scope))).toBeNull();
    expect(await second.getSnapshot()).toBeNull();
  });
});
