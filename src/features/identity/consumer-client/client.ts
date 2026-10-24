import createClient, { type ClientOptions } from 'openapi-fetch';
import { createJwksCache } from './jwks-cache.js';
import {
  clearStoredReaderState,
  invalidateStoredReaderState,
  loadStoredReaderState,
  saveStoredReaderState,
  type ConsumerStorageScope,
  type KeyValueStorage,
} from './storage.js';
import {
  ReaderStateError,
  readReaderStateKid,
  verifyReaderState,
  verifyReaderStateForRenewal,
  type VerifiedReaderState,
} from './verifier.js';
import type { components, paths } from './generated/api.js';
export { evaluatePasswordRules as evaluatePassword } from '../password-policy-rules.js';
export type { PasswordPolicyEvaluation, PasswordPolicyRule } from '../password-policy-rules.js';

export type AuthoritativeSessionStatus = 'unknown' | 'authenticated' | 'anonymous';
export type AuthConfig = components['schemas']['AuthConfig'];
export type PasswordPolicy = AuthConfig['passwordPolicy'];

export interface ConsumerReaderState extends VerifiedReaderState {
  readonly sessionStatus: AuthoritativeSessionStatus;
}

export class ConsumerClientError extends Error {
  readonly code: string;
  readonly status?: number;
  readonly failedRules?: readonly string[];
  readonly passwordPolicy?: AuthConfig['passwordPolicy'];

  constructor(
    code: string,
    message: string,
    status?: number,
    details?: {
      readonly failedRules?: readonly string[];
      readonly passwordPolicy?: AuthConfig['passwordPolicy'];
    },
  ) {
    super(message);
    this.name = 'ConsumerClientError';
    this.code = code;
    if (status !== undefined) this.status = status;
    if (details?.failedRules !== undefined) this.failedRules = details.failedRules;
    if (details?.passwordPolicy !== undefined) this.passwordPolicy = details.passwordPolicy;
  }
}

class AuthMutationOperationFailure extends Error {
  constructor(readonly operationError: Error) {
    super('Auth mutation operation failed.');
  }
}

type ReaderStateChange = 'replacement' | 'logout';

export interface ReaderStateBroadcast {
  notify(change: ReaderStateChange, source: string, authMutationVersion?: number): void;
  observe(
    listener: (change: ReaderStateChange, source: string, authMutationVersion?: number) => void,
  ): () => void;
}

export function createMemoryReaderStateBroadcast(): ReaderStateBroadcast {
  const listeners = new Set<
    (change: ReaderStateChange, source: string, authMutationVersion?: number) => void
  >();
  return {
    notify: (change, source, authMutationVersion) => {
      for (const listener of [...listeners]) listener(change, source, authMutationVersion);
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

function authMutationLockKey(scope: ConsumerStorageScope): string {
  return `usp.auth-mutation.v1.${encodeURIComponent(scope.service ?? '')}.${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}`;
}

function authMutationVersionKey(scope: ConsumerStorageScope): string {
  return `${authMutationLockKey(scope)}.version`;
}

export function createBrowserReaderStateBroadcast(
  scope: ConsumerStorageScope,
): ReaderStateBroadcast {
  const key = broadcastKey(scope);
  const globalRecord = globalThis as Record<string, unknown>;
  const storage = browserStorage(globalRecord);
  const windowCandidate = globalRecord.window as
    { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
  return {
    notify: (change, source, authMutationVersion) => {
      try {
        storage?.setItem(
          key,
          JSON.stringify({
            change,
            source,
            authMutationVersion,
            at: Date.now(),
          }),
        );
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
            listener(
              record.change,
              record.source,
              typeof record.authMutationVersion === 'number' &&
                Number.isSafeInteger(record.authMutationVersion) &&
                record.authMutationVersion > 0
                ? record.authMutationVersion
                : undefined,
            );
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
  readonly name?: string;
  readonly email: string;
  readonly password: string;
}

export interface ConsumerClient {
  getAuthConfig(): Promise<AuthConfig>;
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
  checkPasswordReset(token: string): Promise<boolean>;
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

function browserStorage(globalRecord: Record<string, unknown>): KeyValueStorage | undefined {
  try {
    const candidate = globalRecord.localStorage;
    return isStorage(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

function supportsBrowserStorage(storage: KeyValueStorage | undefined, probeKey: string): boolean {
  if (storage === undefined) return false;
  try {
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return true;
  } catch {
    try {
      storage.removeItem(probeKey);
    } catch {
      // Storage remains unavailable; auth mutations will fail closed.
    }
    return false;
  }
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
  const source = crypto.randomUUID();
  const globalRecord = globalThis as Record<string, unknown>;
  const storageCandidate = browserStorage(globalRecord);
  const storageProbeKey = `${authMutationLockKey(scope)}.probe.${source}`;
  const authMutationVersionStorage = supportsBrowserStorage(storageCandidate, storageProbeKey)
    ? storageCandidate
    : undefined;
  const store = options.readerStateStore ?? authMutationVersionStorage ?? memoryStorage();
  const broadcast =
    options.broadcast !== undefined
      ? options.broadcast
      : (globalThis as Record<string, unknown>).window !== undefined
        ? createBrowserReaderStateBroadcast(scope)
        : null;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const retryDelayMs = options.renewalRetryDelayMs ?? 250;
  const navigatorCandidate = globalRecord.navigator as
    | {
        locks?: {
          request<T>(
            name: string,
            options: { mode: 'exclusive' },
            callback: () => Promise<T>,
          ): Promise<T>;
        };
      }
    | undefined;
  const authMutationLock = authMutationLockKey(scope);
  const authMutationVersionStorageKey = authMutationVersionKey(scope);
  const storedAuthMutationVersion = (() => {
    try {
      return Number(authMutationVersionStorage?.getItem(authMutationVersionStorageKey));
    } catch {
      return 0;
    }
  })();
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
  let latestAuthMutationVersion =
    Number.isSafeInteger(storedAuthMutationVersion) && storedAuthMutationVersion > 0
      ? storedAuthMutationVersion
      : 0;
  let sessionStatus: AuthoritativeSessionStatus = 'unknown';
  let renewal: Promise<ConsumerReaderState | null> | null = null;
  const observers = new Set<(state: ConsumerReaderState | null) => void>();

  const readAuthMutationVersion = (): number => {
    if (authMutationVersionStorage === undefined) return 0;
    try {
      const storedVersion = Number(
        authMutationVersionStorage.getItem(authMutationVersionStorageKey),
      );
      return Number.isSafeInteger(storedVersion) && storedVersion > 0 ? storedVersion : 0;
    } catch {
      throw unsupportedBrowser();
    }
  };

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
      const record = asRecord(error);
      const failedRules = Array.isArray(record?.failedRules)
        ? record.failedRules.filter((value): value is string => typeof value === 'string')
        : undefined;
      const policy = asRecord(record?.passwordPolicy);
      const passwordPolicy =
        policy !== null &&
        Object.values(policy).every((value) => typeof value === 'number' && Number.isInteger(value))
          ? (policy as AuthConfig['passwordPolicy'])
          : undefined;
      return new ConsumerClientError(
        code,
        code === 'password-policy-violation'
          ? 'La contraseña no cumple los requisitos vigentes.'
          : `The request failed: ${code}.`,
        status,
        code === 'password-policy-violation' ? { failedRules, passwordPolicy } : undefined,
      );
    }
    return new ConsumerClientError('unknown-error', `The request failed while ${action}.`, status);
  }

  function toTransportError(error: unknown, action: string): ConsumerClientError {
    if (error instanceof ConsumerClientError) return error;
    return new ConsumerClientError(
      'network-unavailable',
      `The service is unreachable while ${action}.`,
    );
  }

  const unsupportedBrowser = (): ConsumerClientError =>
    new ConsumerClientError(
      'unsupported-browser',
      'Consumer Identity requires Web Locks and usable localStorage.',
    );

  const coordinateAuthMutation = async <T>(
    operation: (authMutationVersion?: number) => Promise<T>,
  ): Promise<T> => {
    if (navigatorCandidate?.locks !== undefined && authMutationVersionStorage !== undefined) {
      try {
        return await navigatorCandidate.locks.request(
          authMutationLock,
          { mode: 'exclusive' },
          async () => {
            if (!supportsBrowserStorage(authMutationVersionStorage, storageProbeKey)) {
              throw unsupportedBrowser();
            }
            let storedVersion: number;
            try {
              storedVersion = Number(
                authMutationVersionStorage.getItem(authMutationVersionStorageKey),
              );
            } catch {
              throw unsupportedBrowser();
            }
            const authMutationVersion =
              (Number.isSafeInteger(storedVersion) && storedVersion > 0 ? storedVersion : 0) + 1;
            try {
              authMutationVersionStorage.setItem(
                authMutationVersionStorageKey,
                String(authMutationVersion),
              );
            } catch {
              throw unsupportedBrowser();
            }
            latestAuthMutationVersion = authMutationVersion;
            try {
              return await operation(authMutationVersion);
            } catch (error) {
              throw new AuthMutationOperationFailure(
                error instanceof Error ? error : new Error('Auth mutation failed.'),
              );
            }
          },
        );
      } catch (error) {
        if (error instanceof AuthMutationOperationFailure) throw error.operationError;
        throw unsupportedBrowser();
      }
    }
    if (globalRecord.window !== undefined) {
      throw unsupportedBrowser();
    }
    return operation();
  };

  const clear = (status: AuthoritativeSessionStatus): void => {
    generation += 1;
    sessionStatus = status;
    try {
      clearStoredReaderState(store, scope);
    } catch {
      throw unsupportedBrowser();
    }
  };

  const verify = async (
    readerState: string,
    allowExpired = false,
  ): Promise<VerifiedReaderState | null> => {
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
      const verifier = allowExpired ? verifyReaderStateForRenewal : verifyReaderState;
      return await verifier(readerState, jwks.cachedKeys(), {
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

  const issue = async (authMutationVersion?: number): Promise<ConsumerReaderState | null> => {
    const attemptGeneration = generation;
    const attemptAuthMutationVersion = authMutationVersion ?? readAuthMutationVersion();
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
    if (attemptAuthMutationVersion !== readAuthMutationVersion()) return null;
    try {
      saveStoredReaderState(store, scope, {
        readerState: response.data.readerState,
        expiresAt: verified.expiresAt,
      });
    } catch {
      throw unsupportedBrowser();
    }
    sessionStatus = 'authenticated';
    broadcast?.notify('replacement', source, authMutationVersion);
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
    const verified = await verify(stored.readerState, true);
    if (attemptGeneration !== generation) return null;
    if (verified?.expiresAt !== stored.expiresAt) {
      clear('unknown');
      return null;
    }
    if (verified.expiresAt <= nowSeconds()) return coalescedIssue();
    return { ...verified, sessionStatus };
  };

  broadcast?.observe((change, sender, authMutationVersion) => {
    if (sender === source) return;
    if (
      authMutationVersion !== undefined &&
      (authMutationVersion < latestAuthMutationVersion ||
        (authMutationVersion === latestAuthMutationVersion && change !== 'logout'))
    )
      return;
    if (authMutationVersion !== undefined) latestAuthMutationVersion = authMutationVersion;
    if (change === 'logout') {
      try {
        clear('anonymous');
      } catch {
        // The clear wrapper maps storage errors to unsupported-browser. A
        // storage event has no caller to reject, so contain that stable error
        // instead of leaking the browser exception through event dispatch.
        try {
          invalidateStoredReaderState(store, scope);
        } catch {
          // Storage remains unavailable; the observer still fails closed.
        }
        for (const observer of observers) observer(null);
        return;
      }
    } else {
      generation += 1;
      sessionStatus = 'unknown';
    }
    void read()
      .then((state) => {
        for (const observer of observers) observer(state);
      })
      .catch(() => {
        for (const observer of observers) observer(null);
      });
  });

  return {
    getAuthConfig: async () => {
      try {
        const response = await api.GET('/v1/auth/config');
        if (response.data !== undefined) return response.data;
        throw toClientError(response.error, response.response.status, 'loading auth config');
      } catch (error) {
        if (error instanceof ConsumerClientError) throw error;
        throw new ConsumerClientError('network-unavailable', 'The service is unreachable.');
      }
    },
    login: (input) =>
      coordinateAuthMutation(async (authMutationVersion) => {
        clear('unknown');
        const attemptGeneration = generation;
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
        if (attemptGeneration !== generation) {
          throw new ConsumerClientError(
            'unauthenticated',
            'Authentication changed while signing in.',
          );
        }
        const state = await issue(authMutationVersion);
        if (state === null || attemptGeneration !== generation)
          throw new ConsumerClientError('unauthenticated', 'Session was not active.');
        return state;
      }),
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
      for (const observer of observers) observer(null);
      await coordinateAuthMutation(async (authMutationVersion) => {
        clear('anonymous');
        for (const observer of observers) observer(null);
        broadcast?.notify('logout', source, authMutationVersion);
        let revocationError: ConsumerClientError | undefined;
        try {
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
        } catch (error) {
          revocationError =
            error instanceof ConsumerClientError
              ? error
              : new ConsumerClientError('logout-failed', 'Server sign-out failed.');
        }

        let cleanupError: ConsumerClientError | undefined;
        try {
          clear('anonymous');
        } catch (error) {
          cleanupError = error instanceof ConsumerClientError ? error : unsupportedBrowser();
        }
        for (const observer of observers) observer(null);
        broadcast?.notify('logout', source, authMutationVersion);
        if (revocationError !== undefined) throw revocationError;
        if (cleanupError !== undefined) throw cleanupError;
      });
    },
    register: async (input) => {
      try {
        const response = await api.POST('/v1/auth/register', {
          body: {
            email: input.email,
            password: input.password,
            ...(input.name === undefined ? {} : { name: input.name }),
          },
        });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'registering');
        }
        return response.data;
      } catch (error) {
        throw toTransportError(error, 'registering');
      }
    },
    verifyEmail: async (token) => {
      try {
        const response = await api.POST('/v1/auth/verify-email', { body: { token } });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'verifying email');
        }
      } catch (error) {
        throw toTransportError(error, 'verifying email');
      }
    },
    requestVerification: async (email) => {
      try {
        const response = await api.POST('/v1/auth/request-verification', { body: { email } });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'requesting verification');
        }
      } catch (error) {
        throw toTransportError(error, 'requesting verification');
      }
    },
    requestPasswordReset: async (email) => {
      try {
        const response = await api.POST('/v1/auth/request-password-reset', { body: { email } });
        if (response.data === undefined) {
          throw toClientError(
            response.error,
            response.response.status,
            'requesting password reset',
          );
        }
      } catch (error) {
        throw toTransportError(error, 'requesting password reset');
      }
    },
    checkPasswordReset: async (token) => {
      try {
        const response = await api.POST('/v1/auth/check-password-reset', { body: { token } });
        if (response.data !== undefined) return response.data.valid;
        throw toClientError(response.error, response.response.status, 'checking password reset');
      } catch (error) {
        throw toTransportError(error, 'checking password reset');
      }
    },
    resetPassword: async (token, newPassword) => {
      try {
        const response = await api.POST('/v1/auth/reset-password', {
          body: { token, newPassword },
        });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'resetting password');
        }
      } catch (error) {
        throw toTransportError(error, 'resetting password');
      }
    },
    observeReaderState: (listener) => {
      observers.add(listener);
      return () => observers.delete(listener);
    },
  };
}
