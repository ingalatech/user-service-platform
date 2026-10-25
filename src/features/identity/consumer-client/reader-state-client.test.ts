import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../../app.js';
import type { Env } from '../../../env.js';
import { InMemoryAuthMailer } from '../mailer.js';
import {
  createBrowserReaderStateBroadcast,
  createConsumerClientForTests as createConsumerClient,
  createMemoryReaderStateBroadcast,
} from './client.js';
import { readerStateStorageKey, type KeyValueStorage } from './storage.js';

const workerEnv = env;
const migrations = env.TEST_MIGRATIONS as D1Migration[];
const mailer = new InMemoryAuthMailer();
let verificationMessageCount = 0;
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

async function verificationToken(): Promise<string> {
  const expectedCount = verificationMessageCount + 1;
  for (let attempt = 0; attempt < 20 && mailer.sent.length < expectedCount; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  verificationMessageCount = expectedCount;
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
    workerEnv.DB.prepare('DELETE FROM "email_verification_token"'),
    workerEnv.DB.prepare('DELETE FROM "jwks"'),
    workerEnv.DB.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
  verificationMessageCount = 0;
});

describe('Reader State consumer client', () => {
  it('keeps manual replacement outside browser auth-mutation revision ordering', () => {
    const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
    const values = new Map<string, string>();
    const storage: KeyValueStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
        for (const listener of listeners) listener({ key, newValue: value });
      },
      removeItem: (key) => values.delete(key),
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.add(listener);
        },
        removeEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.delete(listener);
        },
      },
    });

    try {
      const received: (number | undefined)[] = [];
      const sender = createBrowserReaderStateBroadcast(scope);
      const receiver = createBrowserReaderStateBroadcast(scope);
      receiver.observe((_change, _source, authMutationVersion) => {
        received.push(authMutationVersion);
      });
      const versionKey = `usp.auth-mutation.v1.${encodeURIComponent(scope.service)}.${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}.version`;
      storage.setItem(versionKey, '7');

      sender.notify('replacement', 'manual-refresh');

      expect(received).toEqual([undefined]);
    } finally {
      if (originalStorage === undefined)
        delete (globalThis as Record<string, unknown>).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else Object.defineProperty(globalThis, 'window', originalWindow);
    }
  });

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

    await first.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await first.verifyEmail(await verificationToken());
    const authenticated = await first.login({
      email: 'ada@example.com',
      password: 'Correct-horse-41',
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
    let nowSeconds = Math.floor(Date.now() / 1000);
    const fetchImpl: typeof fetch = async (input) => {
      const response = await network.fetchImpl(input);
      if (
        input instanceof Request &&
        new URL(input.url).pathname === '/v1/auth/reader-state' &&
        response.ok
      ) {
        nowSeconds = Math.floor(Date.now() / 1000);
      }
      return response;
    };
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast: null,
      fetchImpl,
      nowSeconds: () => nowSeconds,
    });
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await client.verifyEmail(await verificationToken());
    await client.login({ email: 'ada@example.com', password: 'Correct-horse-41' });

    network.reset();
    expect((await client.refreshReaderState()).sessionStatus).toBe('authenticated');
    expect(network.count('/v1/auth/reader-state')).toBe(1);

    const key = readerStateStorageKey(scope);
    const stored = JSON.parse(localStore.getItem(key) ?? '{}') as Record<string, unknown>;
    expect(typeof stored.expiresAt).toBe('number');
    nowSeconds = stored.expiresAt as number;
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

  it('discards malformed or altered storage without credentialed renewal', async () => {
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
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await client.verifyEmail(await verificationToken());
    await client.login({ email: 'ada@example.com', password: 'Correct-horse-41' });

    const key = readerStateStorageKey(scope);
    const original = localStore.getItem(key);
    expect(original).not.toBeNull();
    const stored = JSON.parse(original ?? '{}') as Record<string, unknown>;
    localStore.setItem(key, JSON.stringify({ ...stored, expiresAt: 1 }));
    network.reset();
    await expect(client.getSnapshot()).resolves.toBeNull();
    expect(network.count('/v1/auth/reader-state')).toBe(0);

    localStore.setItem(key, JSON.stringify({ readerState: 'not-a-reader-state', expiresAt: 1 }));
    network.reset();
    await expect(client.getSnapshot()).resolves.toBeNull();
    expect(network.count('/v1/auth/reader-state')).toBe(0);
  });

  it('maps rejected transport for every account operation to a stable client error', async () => {
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      broadcast: null,
      fetchImpl: () => Promise.reject(new Error('socket detail must not escape')),
    });
    const operations = [
      () => client.register({ name: 'Ada', email: 'ada@example.com', password: 'password-41' }),
      () => client.verifyEmail('verification-token'),
      () => client.requestVerification('ada@example.com'),
      () => client.requestPasswordReset('ada@example.com'),
      () => client.checkPasswordReset('reset-token'),
      () => client.resetPassword('reset-token', 'new-password-41'),
    ];

    for (const operation of operations) {
      await expect(operation()).rejects.toMatchObject({
        name: 'ConsumerClientError',
        code: 'network-unavailable',
      });
    }
  });

  it('projects the reset-action check response to a boolean', async () => {
    const requests: string[] = [];
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      broadcast: null,
      fetchImpl: async (input) => {
        const request = input as Request;
        requests.push(await request.text());
        return Response.json({ valid: true }, { status: 200 });
      },
    });

    await expect(client.checkPasswordReset('reset-token')).resolves.toBe(true);
    expect(requests).toEqual([JSON.stringify({ token: 'reset-token' })]);
  });

  it('maps storage failures after construction to unsupported-browser', async () => {
    const network = transport();
    let failSave = false;
    let failClear = false;
    const values = new Map<string, string>();
    const localStore: KeyValueStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        if (failSave) throw new Error('storage denied');
        values.set(key, value);
      },
      removeItem: (key) => {
        if (failClear) throw new Error('storage denied');
        values.delete(key);
      },
    };
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast: null,
      fetchImpl: network.fetchImpl,
    });
    await client.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await client.verifyEmail(await verificationToken());
    await client.login({ email: 'ada@example.com', password: 'Correct-horse-41' });

    failSave = true;
    await expect(client.refreshReaderState()).rejects.toMatchObject({
      code: 'unsupported-browser',
    });
    failSave = false;
    failClear = true;
    await expect(client.logout()).rejects.toMatchObject({ code: 'unsupported-browser' });
  });

  it('keeps failed server revocation visible when final storage cleanup fails', async () => {
    const localStore = memoryStorage();
    const network = transport();
    let failClear = false;
    const storage: KeyValueStorage = {
      getItem: (key) => localStore.getItem(key),
      setItem: (key, value) => {
        localStore.setItem(key, value);
      },
      removeItem: (key) => {
        if (failClear) throw new Error('storage denied');
        localStore.removeItem(key);
      },
    };
    let signOutStatus = 500;
    const client = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: storage,
      broadcast: null,
      fetchImpl: (input) => {
        if (new URL((input as Request).url).pathname === '/v1/auth/sign-out') {
          failClear = true;
          return Promise.resolve(new Response(null, { status: signOutStatus }));
        }
        return network.fetchImpl(input);
      },
    });

    await expect(client.logout()).rejects.toMatchObject({ code: 'logout-failed' });

    failClear = false;
    signOutStatus = 204;
    await expect(client.logout()).rejects.toMatchObject({ code: 'unsupported-browser' });
  });

  it('does not throw raw storage errors from a cross-tab logout event', () => {
    const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
    const values = new Map<string, string>();
    const browserStorage: KeyValueStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
        for (const listener of listeners) listener({ key, newValue: value });
      },
      removeItem: () => {
        throw new Error('storage denied');
      },
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: browserStorage,
    });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.add(listener);
        },
        removeEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.delete(listener);
        },
      },
    });

    try {
      const observed: (string | null)[] = [];
      const receiver = createConsumerClient({
        baseUrl: scope.service,
        issuer: scope.issuer,
        audience: scope.audience,
        readerStateStore: browserStorage,
        broadcast: createBrowserReaderStateBroadcast(scope),
        fetchImpl: () => Promise.reject(new Error('event must not fetch')),
      });
      receiver.observeReaderState((state) => {
        observed.push(state?.subject ?? null);
      });
      const sender = createBrowserReaderStateBroadcast(scope);

      expect(() => {
        sender.notify('logout', 'other-tab', 1);
      }).not.toThrow();
      expect(observed).toEqual([null]);
    } finally {
      if (originalStorage === undefined)
        delete (globalThis as Record<string, unknown>).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else Object.defineProperty(globalThis, 'window', originalWindow);
    }
  });

  it('does not restore valid state after a cross-tab logout removal failure', async () => {
    const network = transport();
    const values = new Map<string, string>();
    const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
    let failStateRemoval = false;
    const storage: KeyValueStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
        for (const listener of listeners) listener({ key, newValue: value });
      },
      removeItem: (key) => {
        if (failStateRemoval && key === readerStateStorageKey(scope))
          throw new Error('storage denied');
        values.delete(key);
      },
    };
    const originalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: storage });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        addEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.add(listener);
        },
        removeEventListener: (
          type: string,
          listener: (event: { key: string | null; newValue: string | null }) => void,
        ) => {
          if (type === 'storage') listeners.delete(listener);
        },
      },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request: async <T>(_name: string, _options: unknown, callback: () => Promise<T>) =>
            callback(),
        },
      },
    });

    try {
      const setup = createConsumerClient({
        baseUrl: scope.service,
        issuer: scope.issuer,
        audience: scope.audience,
        readerStateStore: storage,
        broadcast: null,
        fetchImpl: network.fetchImpl,
      });
      await setup.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
      await setup.verifyEmail(await verificationToken());
      const authenticated = await setup.login({
        email: 'ada@example.com',
        password: 'Correct-horse-41',
      });
      expect(values.get(readerStateStorageKey(scope))).not.toBeNull();
      failStateRemoval = true;

      const receiver = createConsumerClient({
        baseUrl: scope.service,
        issuer: scope.issuer,
        audience: scope.audience,
        readerStateStore: storage,
        broadcast: createBrowserReaderStateBroadcast(scope),
        fetchImpl: () => Promise.reject(new Error('event must not fetch')),
      });
      const observed: (string | null)[] = [];
      receiver.observeReaderState((state) => observed.push(state?.subject ?? null));
      const sender = createBrowserReaderStateBroadcast(scope);

      sender.notify('logout', 'other-tab', 1);

      expect(observed).toEqual([null]);
      expect(values.get(readerStateStorageKey(scope))).not.toBeNull();
      await expect(receiver.getSnapshot()).resolves.toBeNull();
      const reloaded = createConsumerClient({
        baseUrl: scope.service,
        issuer: scope.issuer,
        audience: scope.audience,
        readerStateStore: storage,
        broadcast: null,
        fetchImpl: () => Promise.reject(new Error('reload must not fetch')),
      });
      await expect(reloaded.getSnapshot()).resolves.toBeNull();
      expect(authenticated.subject).toBeTypeOf('string');
    } finally {
      if (originalStorage === undefined)
        delete (globalThis as Record<string, unknown>).localStorage;
      else Object.defineProperty(globalThis, 'localStorage', originalStorage);
      if (originalWindow === undefined) delete (globalThis as Record<string, unknown>).window;
      else Object.defineProperty(globalThis, 'window', originalWindow);
      if (originalNavigator === undefined) delete (globalThis as Record<string, unknown>).navigator;
      else Object.defineProperty(globalThis, 'navigator', originalNavigator);
    }
  });

  it('lets a newer cross-tab replacement supersede delayed login and refresh work', async () => {
    const network = transport();
    const localStore = memoryStorage();
    const broadcast = createMemoryReaderStateBroadcast();
    const setup = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: network.fetchImpl,
    });
    await setup.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await setup.verifyEmail(await verificationToken());
    await setup.register({
      name: 'Grace',
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });
    await setup.verifyEmail(await verificationToken());

    let releaseLogin: () => void = () => undefined;
    let loginReady: () => void = () => undefined;
    const loginBlocked = new Promise<void>((resolve) => {
      releaseLogin = resolve;
    });
    const loginResponseReady = new Promise<void>((resolve) => {
      loginReady = resolve;
    });
    const delayedLoginFetch: typeof fetch = async (input) => {
      const response = await network.fetchImpl(input);
      if (input instanceof Request && new URL(input.url).pathname === '/v1/auth/login') {
        loginReady();
        await loginBlocked;
      }
      return response;
    };
    const delayedLoginClient = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: delayedLoginFetch,
    });
    const replacementClient = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: network.fetchImpl,
    });

    const delayedLogin = delayedLoginClient.login({
      email: 'ada@example.com',
      password: 'Correct-horse-41',
    });
    await loginResponseReady;
    const replacement = await replacementClient.login({
      email: 'grace@example.com',
      password: 'Correct-horse-42',
    });
    const issuesAfterReplacement = network.count('/v1/auth/reader-state');
    releaseLogin();
    await expect(delayedLogin).rejects.toMatchObject({ code: 'unauthenticated' });
    expect(network.count('/v1/auth/reader-state')).toBe(issuesAfterReplacement);
    await expect(replacementClient.getSnapshot()).resolves.toMatchObject({
      subject: replacement.subject,
    });

    let releaseRefresh: () => void = () => undefined;
    let refreshReady: () => void = () => undefined;
    const refreshBlocked = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const refreshResponseReady = new Promise<void>((resolve) => {
      refreshReady = resolve;
    });
    const delayedRefreshFetch: typeof fetch = async (input) => {
      const response = await network.fetchImpl(input);
      if (input instanceof Request && new URL(input.url).pathname === '/v1/auth/reader-state') {
        refreshReady();
        await refreshBlocked;
      }
      return response;
    };
    const delayedRefreshClient = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: delayedRefreshFetch,
    });
    const delayedRefresh = delayedRefreshClient.refreshReaderState();
    await refreshResponseReady;
    const latest = await replacementClient.login({
      email: 'ada@example.com',
      password: 'Correct-horse-41',
    });
    releaseRefresh();
    await expect(delayedRefresh).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(replacementClient.getSnapshot()).resolves.toMatchObject({
      subject: latest.subject,
    });
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
    await first.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await first.verifyEmail(await verificationToken());
    await first.login({ email: 'ada@example.com', password: 'Correct-horse-41' });

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

  it('clears a refresh started after the logout marker before delayed server sign-out', async () => {
    const network = transport();
    const localStore = memoryStorage();
    const broadcast = createMemoryReaderStateBroadcast();
    let releaseSignOut: () => void = () => undefined;
    let signOutReady: () => void = () => undefined;
    const signOutBlocked = new Promise<void>((resolve) => {
      releaseSignOut = resolve;
    });
    const signOutRequestReady = new Promise<void>((resolve) => {
      signOutReady = resolve;
    });
    const delayedSignOutFetch: typeof fetch = async (input) => {
      if (input instanceof Request && new URL(input.url).pathname === '/v1/auth/sign-out') {
        signOutReady();
        await signOutBlocked;
      }
      return network.fetchImpl(input);
    };
    const first = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: delayedSignOutFetch,
    });
    const second = createConsumerClient({
      baseUrl: scope.service,
      issuer: scope.issuer,
      audience: scope.audience,
      readerStateStore: localStore,
      broadcast,
      fetchImpl: network.fetchImpl,
    });
    await first.register({ name: 'Ada', email: 'ada@example.com', password: 'Correct-horse-41' });
    await first.verifyEmail(await verificationToken());
    await first.login({ email: 'ada@example.com', password: 'Correct-horse-41' });

    let logoutMarkerObserved: () => void = () => undefined;
    const logoutMarker = new Promise<void>((resolve) => {
      logoutMarkerObserved = resolve;
    });
    second.observeReaderState((state) => {
      if (state === null) logoutMarkerObserved();
    });
    const logout = first.logout();
    await signOutRequestReady;
    await logoutMarker;
    await expect(second.refreshReaderState()).resolves.toMatchObject({
      sessionStatus: 'authenticated',
    });

    releaseSignOut();
    await expect(logout).resolves.toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(localStore.getItem(readerStateStorageKey(scope))).toBeNull();
    await expect(second.getSnapshot()).resolves.toBeNull();
  });
});
