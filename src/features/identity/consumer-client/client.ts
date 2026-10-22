import createClient, { type ClientOptions } from 'openapi-fetch';
import { createJwksCache } from './jwks-cache.js';
import {
  clearStoredReaderState,
  loadStoredReaderState,
  saveStoredReaderState,
  type ConsumerStorageScope,
  type KeyValueStorage,
} from './storage.js';
import {
  ReaderStateError,
  readReaderStateKid,
  verifyReaderState,
  type VerifiedReaderState,
} from './verifier.js';
import type { paths } from './generated/api.js';

export type AuthoritativeSessionStatus = 'unknown' | 'authenticated' | 'anonymous';

export interface ConsumerReaderState extends VerifiedReaderState {
  readonly sessionStatus: AuthoritativeSessionStatus;
}

export class ConsumerClientError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ConsumerClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

type ReaderStateChange = 'replacement' | 'logout';

export interface ReaderStateBroadcast {
  notify(change: ReaderStateChange, source: string): void;
  observe(listener: (change: ReaderStateChange, source: string) => void): () => void;
}

export function createMemoryReaderStateBroadcast(): ReaderStateBroadcast {
  const listeners = new Set<(change: ReaderStateChange, source: string) => void>();
  return {
    notify: (change, source) => {
      for (const listener of [...listeners]) listener(change, source);
    },
    observe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function broadcastKey(scope: ConsumerStorageScope): string {
  return `usp.reader-state.v1.change.${encodeURIComponent(scope.service ?? '')}.${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}`;
}

export function createBrowserReaderStateBroadcast(
  scope: ConsumerStorageScope,
): ReaderStateBroadcast {
  const key = broadcastKey(scope);
  const globalRecord = globalThis as Record<string, unknown>;
  const storage = globalRecord.localStorage as KeyValueStorage | undefined;
  const windowCandidate = globalRecord.window as
    { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
  return {
    notify: (change, source) => {
      try {
        storage?.setItem(key, JSON.stringify({ change, source, at: Date.now() }));
      } catch {
        // Cross-tab notification is best effort; shared state is already updated.
      }
    },
    observe: (listener) => {
      if (typeof windowCandidate?.addEventListener !== 'function') return () => undefined;
      const handler = (event: { key: string | null; newValue?: string | null }): void => {
        if (event.key !== key || event.newValue === null || event.newValue === undefined) return;
        try {
          const record = JSON.parse(event.newValue) as Record<string, unknown>;
          if (
            (record.change === 'replacement' || record.change === 'logout') &&
            typeof record.source === 'string'
          ) {
            listener(record.change, record.source);
          }
        } catch {
          // Malformed credential-free markers are ignored.
        }
      };
      const add = windowCandidate.addEventListener as (
        type: string,
        listener: (event: { key: string | null; newValue?: string | null }) => void,
      ) => void;
      add.call(windowCandidate, 'storage', handler);
      return () => {
        if (typeof windowCandidate.removeEventListener === 'function') {
          const remove = windowCandidate.removeEventListener as typeof add;
          remove.call(windowCandidate, 'storage', handler);
        }
      };
    },
  };
}

export interface ConsumerClientOptions {
  readonly baseUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly readerStateStore?: KeyValueStorage;
  readonly broadcast?: ReaderStateBroadcast | null;
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
  readonly renewalRetryDelayMs?: number;
}

export interface ConsumerLoginInput {
  readonly email: string;
  readonly password: string;
}

export interface ConsumerRegisterInput {
  readonly name: string;
  readonly email: string;
  readonly password: string;
}

export interface ConsumerClient {
  login(input: ConsumerLoginInput): Promise<ConsumerReaderState>;
  getSnapshot(): Promise<ConsumerReaderState | null>;
  refreshReaderState(): Promise<ConsumerReaderState>;
  getSessionStatus(): AuthoritativeSessionStatus;
  logout(): Promise<void>;
  register(input: ConsumerRegisterInput): Promise<{
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
  }>;
  verifyEmail(token: string): Promise<void>;
  requestVerification(email: string): Promise<void>;
  requestPasswordReset(email: string): Promise<void>;
  resetPassword(token: string, newPassword: string): Promise<void>;
  observeReaderState(listener: (state: ConsumerReaderState | null) => void): () => void;
}

function isStorage(value: unknown): value is KeyValueStorage {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.getItem === 'function' &&
    typeof record.setItem === 'function' &&
    typeof record.removeItem === 'function'
  );
}

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

function defaultReaderStateStore(): KeyValueStorage {
  const candidate = (globalThis as Record<string, unknown>).localStorage;
  return isStorage(candidate) ? candidate : memoryStorage();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

const sleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export function createConsumerClient(options: ConsumerClientOptions): ConsumerClient {
  if ((globalThis as Record<string, unknown>).isSecureContext === false) {
    throw new ConsumerClientError(
      'insecure-context',
      'Consumer Identity requires a secure context.',
    );
  }
  const scope: ConsumerStorageScope = {
    service: options.baseUrl.replace(/\/$/, ''),
    issuer: options.issuer,
    audience: options.audience,
  };
  const store = options.readerStateStore ?? defaultReaderStateStore();
  const source = crypto.randomUUID();
  const broadcast =
    options.broadcast !== undefined
      ? options.broadcast
      : (globalThis as Record<string, unknown>).window !== undefined
        ? createBrowserReaderStateBroadcast(scope)
        : null;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const retryDelayMs = options.renewalRetryDelayMs ?? 250;
  const clientOptions: ClientOptions = { baseUrl: options.baseUrl };
  if (options.fetchImpl !== undefined) clientOptions.fetch = options.fetchImpl;
  const api = createClient<paths>(clientOptions);
  const jwks = createJwksCache({
    scope,
    storage: store,
    nowSeconds,
    fetchJwks: async () => {
      try {
        const response = await api.GET('/v1/auth/jwks');
        if (response.data === undefined) {
          throw toClientError(
            response.error,
            response.response.status,
            'loading verification keys',
          );
        }
        return { keys: response.data.keys };
      } catch (error) {
        if (error instanceof ConsumerClientError) throw error;
        throw new ConsumerClientError('network-unavailable', 'Verification keys are unreachable.');
      }
    },
  });

  let generation = 0;
  let sessionStatus: AuthoritativeSessionStatus = 'unknown';
  let renewal: Promise<ConsumerReaderState | null> | null = null;
  const observers = new Set<(state: ConsumerReaderState | null) => void>();

  function toClientError(error: unknown, status: number, action: string): ConsumerClientError {
    if (status >= 500) {
      return new ConsumerClientError(
        'service-unavailable',
        `The service is unavailable while ${action}.`,
        status,
      );
    }
    const code = asRecord(error)?.code;
    if (typeof code === 'string' && code !== '') {
      return new ConsumerClientError(code, `The request failed: ${code}.`, status);
    }
    return new ConsumerClientError('unknown-error', `The request failed while ${action}.`, status);
  }

  const clear = (status: AuthoritativeSessionStatus): void => {
    generation += 1;
    sessionStatus = status;
    clearStoredReaderState(store, scope);
  };

  const verify = async (readerState: string): Promise<VerifiedReaderState | null> => {
    const kid = readReaderStateKid(readerState);
    if (kid === null) return null;
    let key;
    try {
      key = await jwks.getKey(kid);
    } catch {
      throw new ConsumerClientError('service-unavailable', 'Verification keys are unavailable.');
    }
    if (key === null) return null;
    try {
      return await verifyReaderState(readerState, jwks.cachedKeys(), {
        issuer: scope.issuer,
        audience: scope.audience,
        nowSeconds: nowSeconds(),
        clockToleranceSeconds: 0,
      });
    } catch (error) {
      if (error instanceof ReaderStateError) return null;
      throw error;
    }
  };

  const issue = async (): Promise<ConsumerReaderState | null> => {
    const attemptGeneration = generation;
    const request = async () =>
      api.POST('/v1/auth/reader-state', { credentials: 'include' } as Record<string, unknown>);
    let response;
    try {
      response = await request();
    } catch {
      await sleep(retryDelayMs);
      try {
        response = await request();
      } catch {
        throw new ConsumerClientError(
          'network-unavailable',
          'Reader State service is unreachable.',
        );
      }
    }
    if (response.data === undefined) {
      if (response.response.status === 401) {
        if (attemptGeneration === generation) clear('anonymous');
        return null;
      }
      throw toClientError(response.error, response.response.status, 'refreshing Reader State');
    }
    const verified = await verify(response.data.readerState);
    if (attemptGeneration !== generation) return null;
    if (verified?.expiresAt !== response.data.expiresAt) {
      clear('unknown');
      throw new ConsumerClientError(
        'invalid-reader-state',
        'Issued Reader State failed verification.',
      );
    }
    saveStoredReaderState(store, scope, {
      readerState: response.data.readerState,
      expiresAt: verified.expiresAt,
    });
    sessionStatus = 'authenticated';
    broadcast?.notify('replacement', source);
    const state = { ...verified, sessionStatus } as const;
    for (const observer of observers) observer(state);
    return state;
  };

  const coalescedIssue = (): Promise<ConsumerReaderState | null> => {
    renewal ??= issue().finally(() => {
      renewal = null;
    });
    return renewal;
  };

  const read = async (): Promise<ConsumerReaderState | null> => {
    const attemptGeneration = generation;
    const stored = loadStoredReaderState(store, scope);
    if (stored === null) return null;
    if (stored.expiresAt <= nowSeconds()) return coalescedIssue();
    const verified = await verify(stored.readerState);
    if (attemptGeneration !== generation) return null;
    if (verified?.expiresAt !== stored.expiresAt) {
      clear('unknown');
      return null;
    }
    return { ...verified, sessionStatus };
  };

  broadcast?.observe((change, sender) => {
    if (sender === source) return;
    generation += 1;
    sessionStatus = 'unknown';
    if (change === 'logout') clearStoredReaderState(store, scope);
    void read()
      .then((state) => {
        for (const observer of observers) observer(state);
      })
      .catch(() => {
        for (const observer of observers) observer(null);
      });
  });

  return {
    login: async (input) => {
      clear('unknown');
      let response;
      try {
        response = await api.POST('/v1/auth/login', {
          body: input,
          credentials: 'include',
        });
      } catch {
        throw new ConsumerClientError('network-unavailable', 'Identity service is unreachable.');
      }
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'signing in');
      }
      const state = await coalescedIssue();
      if (state === null)
        throw new ConsumerClientError('unauthenticated', 'Session was not active.');
      return state;
    },
    getSnapshot: read,
    refreshReaderState: async () => {
      const state = await coalescedIssue();
      if (state === null)
        throw new ConsumerClientError('unauthenticated', 'Session was not active.');
      return state;
    },
    getSessionStatus: () => sessionStatus,
    logout: async () => {
      clear('anonymous');
      broadcast?.notify('logout', source);
      for (const observer of observers) observer(null);
      try {
        const response = await api.POST('/v1/auth/sign-out', {
          credentials: 'include',
        } as Record<string, unknown>);
        if (!response.response.ok) {
          throw new ConsumerClientError(
            'logout-failed',
            'Server sign-out failed.',
            response.response.status,
          );
        }
      } catch (error) {
        if (error instanceof ConsumerClientError) throw error;
        throw new ConsumerClientError('logout-failed', 'Server sign-out failed.');
      }
    },
    register: async (input) => {
      const response = await api.POST('/v1/auth/register', { body: input });
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'registering');
      }
      return response.data;
    },
    verifyEmail: async (token) => {
      const response = await api.POST('/v1/auth/verify-email', { body: { token } });
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'verifying email');
      }
    },
    requestVerification: async (email) => {
      const response = await api.POST('/v1/auth/request-verification', { body: { email } });
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'requesting verification');
      }
    },
    requestPasswordReset: async (email) => {
      const response = await api.POST('/v1/auth/request-password-reset', { body: { email } });
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'requesting password reset');
      }
    },
    resetPassword: async (token, newPassword) => {
      const response = await api.POST('/v1/auth/reset-password', { body: { token, newPassword } });
      if (response.data === undefined) {
        throw toClientError(response.error, response.response.status, 'resetting password');
      }
    },
    observeReaderState: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
}
