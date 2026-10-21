import createClient, { type ClientOptions } from 'openapi-fetch';
import { createJwksCache, type JwksCache } from './jwks-cache.js';
import {
  clearStoredSession,
  loadStoredSession,
  saveStoredSession,
  type ConsumerStorageScope,
  type KeyValueStorage,
} from './storage.js';
import { ConsumerTokenError, readTokenKid, verifyConsumerToken } from './verifier.js';
import type { paths } from './generated/api.js';

// Framework-independent consumer Identity client (spec #150, ADR-0013,
// ticket #152). It logs in through existing Identity, obtains a JWT, preserves
// it across separate full document navigations and shares it among page
// components. This module depends only on the generated OpenAPI contracts and
// `openapi-fetch`; it never imports React, Hono, persistence or engine server
// types, so the consumer team can vendor these sources without the service
// repository.
//
// Browser-storage/XSS trade-off: the access token lives in tab-scoped
// sessionStorage (survives navigation and reload within the tab) and is
// readable by page scripts. This is explicit: keep the token lifetime short,
// serve only over secure contexts and apply the consumer's normal script/CSP
// controls. The authoritative renewal session stays HttpOnly and is never
// exposed to JavaScript or copied into the token. Require a secure context
// wherever this client runs.
//
// Transport: the supported browser path is a same-origin API gateway owned by
// the consumer team (see docs/operations/consumer-client.md). Pass that
// gateway origin (or the service origin for direct same-origin use) as
// `baseUrl`. Cookies ride automatically (`credentials: 'include'`); direct
// unrelated-origin browser calls, cross-site cookies, blanket CORS and SSO
// are outside this increment.
export interface ConsumerIdentitySnapshot {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  // Token expiry as integer Unix seconds. Local UI state only: receiving
  // APIs authorize independently and never trust this snapshot.
  readonly expiresAt: number;
}

export class ConsumerClientError extends Error {
  // Stable machine code: the server RFC 9457 problem `code` when the failure
  // came from the service, otherwise one of `service-unavailable`,
  // `network-unavailable`, `invalid-token` or `logout-failed`.
  readonly code: string;
  readonly status?: number;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'ConsumerClientError';
    this.code = code;
    if (status !== undefined) {
      this.status = status;
    }
  }
}

// Credential-free cross-tab logout notification. The token itself is never
// distributed: logout writes only a timestamp marker that active same-origin
// tabs observe and answer by clearing their own tab-scoped state.
export interface LogoutBroadcast {
  notifyLogout(): void;
  observeLogout(onLogout: () => void): () => void;
}

export function createMemoryLogoutBroadcast(): LogoutBroadcast {
  const listeners = new Set<() => void>();
  return {
    notifyLogout: () => {
      for (const listener of [...listeners]) {
        listener();
      }
    },
    observeLogout: (onLogout: () => void) => {
      listeners.add(onLogout);
      return () => {
        listeners.delete(onLogout);
      };
    },
  };
}

function logoutBroadcastKey(scope: ConsumerStorageScope): string {
  return `usp.consumer.v1.logout.${encodeURIComponent(scope.service ?? '')}.${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}`;
}

// Same-origin-tab logout propagation backed by localStorage + storage events.
// The stored value is a timestamp marker only — never a credential. Outside a
// browser (no localStorage/window) observation is a no-op and notification
// persists the marker only when localStorage exists.
export function createBrowserLogoutBroadcast(scope: ConsumerStorageScope): LogoutBroadcast {
  const key = logoutBroadcastKey(scope);
  const globalRecord = globalThis as Record<string, unknown>;
  const localStorageCandidate = globalRecord.localStorage as KeyValueStorage | undefined;
  const windowCandidate = globalRecord.window as
    { addEventListener?: unknown; removeEventListener?: unknown } | undefined;
  return {
    notifyLogout: () => {
      try {
        localStorageCandidate?.setItem(key, String(Date.now()));
      } catch {
        // Logout notification is best-effort; local state is already cleared.
      }
    },
    observeLogout: (onLogout: () => void) => {
      if (typeof windowCandidate?.addEventListener !== 'function') {
        return () => undefined;
      }
      const addListener = windowCandidate.addEventListener as (
        type: string,
        listener: (event: { key: string | null }) => void,
      ) => void;
      const removeListener =
        typeof windowCandidate.removeEventListener === 'function'
          ? (windowCandidate.removeEventListener as (
              type: string,
              listener: (event: { key: string | null }) => void,
            ) => void)
          : null;
      const handler = (event: { key: string | null }): void => {
        if (event.key === key) {
          onLogout();
        }
      };
      addListener.call(windowCandidate, 'storage', handler);
      return () => {
        removeListener?.call(windowCandidate, 'storage', handler);
      };
    },
  };
}

export interface ConsumerClientOptions {
  // Same-origin gateway base, for example `https://shop.example` or `''`
  // for relative same-origin requests.
  readonly baseUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly sessionStore?: KeyValueStorage;
  // Cross-tab logout propagation. Defaults to the browser broadcast when a
  // browser is detected, otherwise disabled. Pass `null` to disable
  // explicitly (isolated tests, non-browser runtimes).
  readonly broadcast?: LogoutBroadcast | null;
  readonly fetchImpl?: typeof fetch;
  // Isolated clock for tests; defaults to the real clock.
  readonly nowSeconds?: () => number;
  // Delay between the two bounded renewal attempts on network failure.
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
  login(input: ConsumerLoginInput): Promise<ConsumerIdentitySnapshot>;
  // Returns the locally verified snapshot without `/me`, token, renewal or
  // provider requests while the stored token is valid. Anonymous pages
  // without local credentials make no request at all. An expired token
  // triggers one lazy coalesced renewal; 401 clears and resolves anonymous,
  // while service/network failure throws `service-unavailable` or
  // `network-unavailable` without extending validity.
  getSnapshot(): Promise<ConsumerIdentitySnapshot | null>;
  // Explicit single bootstrap for a fresh tab that holds a session cookie but
  // no tab state (at most one token issue plus one identity read). Absence of
  // a token never authorizes probing on every anonymous page.
  recoverSession(): Promise<ConsumerIdentitySnapshot | null>;
  // Clears local state, revokes the renewal session server-side and notifies
  // same-origin tabs with a credential-free marker. A failed server revocation
  // throws `logout-failed` while local state stays cleared.
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
  observeLogout(listener: () => void): () => void;
}

function isKeyValueStorage(value: unknown): value is KeyValueStorage {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.getItem === 'function' &&
    typeof record.setItem === 'function' &&
    typeof record.removeItem === 'function'
  );
}

function defaultSessionStore(): KeyValueStorage {
  const candidate = (globalThis as Record<string, unknown>).sessionStorage;
  if (isKeyValueStorage(candidate)) {
    return candidate;
  }
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

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

export function createConsumerClient(options: ConsumerClientOptions): ConsumerClient {
  const scope: ConsumerStorageScope = {
    service: options.baseUrl.replace(/\/$/, ''),
    issuer: options.issuer,
    audience: options.audience,
  };
  const store = options.sessionStore ?? defaultSessionStore();
  const globalRecord = globalThis as Record<string, unknown>;
  const broadcast =
    options.broadcast !== undefined
      ? options.broadcast
      : globalRecord.localStorage !== undefined || globalRecord.window !== undefined
        ? createBrowserLogoutBroadcast(scope)
        : null;
  if (globalRecord.isSecureContext === false) {
    throw new ConsumerClientError(
      'insecure-context',
      'Consumer Identity requires a secure context.',
    );
  }
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  const retryDelayMs = options.renewalRetryDelayMs ?? 250;

  const clientOptions: ClientOptions = { baseUrl: options.baseUrl };
  if (options.fetchImpl !== undefined) {
    clientOptions.fetch = options.fetchImpl;
  }
  const api = createClient<paths>(clientOptions);

  const jwks: JwksCache = createJwksCache({
    fetchJwks: async () => {
      try {
        const fetched = await api.GET('/v1/auth/jwks');
        if (fetched.data === undefined) {
          throw toClientError(fetched.error, fetched.response.status, 'verification keys');
        }
        return { keys: fetched.data.keys };
      } catch (error) {
        if (error instanceof ConsumerClientError) {
          throw error;
        }
        throw new ConsumerClientError(
          'network-unavailable',
          'The verification service is unreachable.',
        );
      }
    },
    scope,
    // The public-key cache persists alongside the token in the versioned
    // tab-scoped store, so separate documents in the same tab verify without
    // refetching keys.
    storage: store,
    nowSeconds,
  });

  const toClientError = (error: unknown, status: number, action: string): ConsumerClientError => {
    const code = asRecord(error)?.code;
    if (typeof code === 'string' && code.length > 0) {
      return new ConsumerClientError(code, `The request failed: ${code}.`, status);
    }
    if (status >= 500) {
      return new ConsumerClientError(
        'service-unavailable',
        `The service is unavailable while ${action}.`,
        status,
      );
    }
    return new ConsumerClientError('unknown-error', `The request failed while ${action}.`, status);
  };

  const toTransportError = (error: unknown, action: string): ConsumerClientError => {
    if (error instanceof ConsumerClientError) {
      return error;
    }
    return new ConsumerClientError(
      'network-unavailable',
      `The service is unreachable while ${action}.`,
    );
  };

  // Verifies a token against the cached JWKS. Returns the snapshot, or null
  // when persisted credentials must be discarded. Throws only when key
  // material itself is unavailable (service/network failure).
  const verifyStored = async (
    token: string,
    atSeconds: number,
  ): Promise<
    | { readonly valid: true; readonly subject: string; readonly expiresAt: number }
    | { readonly valid: false }
  > => {
    const kid = readTokenKid(token);
    if (kid === null) return { valid: false };
    let known;
    try {
      known = await jwks.getKey(kid);
    } catch {
      throw new ConsumerClientError(
        'service-unavailable',
        'The verification keys are unavailable.',
      );
    }
    if (known === null) return { valid: false };
    try {
      const verified = await verifyConsumerToken(token, jwks.cachedKeys(), {
        issuer: scope.issuer,
        audience: scope.audience,
        nowSeconds: atSeconds,
        clockToleranceSeconds: 0,
      });
      return { valid: true, subject: verified.subject, expiresAt: verified.expiresAt };
    } catch (error) {
      if (error instanceof ConsumerTokenError) {
        return { valid: false };
      }
      throw error;
    }
  };

  let generation = 0;
  const discard = (): void => {
    generation += 1;
    clearStoredSession(store, scope);
  };

  let renewal: Promise<ConsumerIdentitySnapshot | null> | null = null;

  const renew = async (): Promise<ConsumerIdentitySnapshot | null> => {
    const attemptGeneration = generation;
    const stored = loadStoredSession(store, scope);
    if (stored === null) {
      return null;
    }
    let issued: { accessToken: string; expiresAt: number };
    try {
      const response = await api.POST('/v1/auth/token', {
        credentials: 'include',
      } as Record<string, unknown>);
      if (response.data === undefined) {
        if (response.response.status === 401) {
          if (attemptGeneration === generation) discard();
          return null;
        }
        throw toClientError(response.error, response.response.status, 'renewing the session');
      }
      issued = {
        accessToken: response.data.accessToken,
        expiresAt: response.data.expiresAt,
      };
    } catch (error) {
      if (error instanceof ConsumerClientError) {
        const status = error.status ?? 0;
        if (status >= 500 || error.code === 'service-unavailable') {
          throw new ConsumerClientError(
            'service-unavailable',
            'The service is unavailable while renewing the session.',
            error.status,
          );
        }
        throw error;
      }
      // One bounded retry on network failure, then unavailable — never an
      // extended or anonymous session.
      await sleep(retryDelayMs);
      try {
        const retry = await api.POST('/v1/auth/token', {
          credentials: 'include',
        } as Record<string, unknown>);
        if (retry.data === undefined) {
          if (retry.response.status === 401) {
            if (attemptGeneration === generation) discard();
            return null;
          }
          throw toClientError(retry.error, retry.response.status, 'renewing the session');
        }
        issued = {
          accessToken: retry.data.accessToken,
          expiresAt: retry.data.expiresAt,
        };
      } catch (retryError) {
        if (retryError instanceof ConsumerClientError) {
          throw retryError;
        }
        throw new ConsumerClientError(
          'network-unavailable',
          'The service is unreachable while renewing the session.',
        );
      }
    }
    if (attemptGeneration !== generation) return null;
    const checked = await verifyStored(issued.accessToken, nowSeconds());
    if (attemptGeneration !== generation) return null;
    if (!checked.valid || checked.subject !== stored.user.id) {
      discard();
      throw new ConsumerClientError('invalid-token', 'The renewed token failed verification.');
    }
    const snapshot: ConsumerIdentitySnapshot = {
      id: stored.user.id,
      email: stored.user.email,
      emailVerified: stored.user.emailVerified,
      expiresAt: checked.expiresAt,
    };
    saveStoredSession(store, scope, {
      accessToken: issued.accessToken,
      expiresAt: checked.expiresAt,
      user: { id: snapshot.id, email: snapshot.email, emailVerified: snapshot.emailVerified },
    });
    return snapshot;
  };

  const coalescedRenew = (): Promise<ConsumerIdentitySnapshot | null> => {
    renewal ??= renew().finally(() => {
      renewal = null;
    });
    return renewal;
  };

  const client: ConsumerClient = {
    login: async (input: ConsumerLoginInput) => {
      discard();
      const attemptGeneration = generation;
      let user: { id: string; email: string; emailVerified: boolean };
      try {
        const response = await api.POST('/v1/auth/login', {
          body: { email: input.email, password: input.password },
          credentials: 'include',
        });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'signing in');
        }
        user = {
          id: response.data.id,
          email: response.data.email,
          emailVerified: response.data.emailVerified,
        };
      } catch (error) {
        throw toTransportError(error, 'signing in');
      }
      let issued: { accessToken: string };
      try {
        const tokenResponse = await api.POST('/v1/auth/token', {
          credentials: 'include',
        } as Record<string, unknown>);
        if (tokenResponse.data === undefined) {
          throw toClientError(
            tokenResponse.error,
            tokenResponse.response.status,
            'issuing a token',
          );
        }
        issued = { accessToken: tokenResponse.data.accessToken };
      } catch (error) {
        throw toTransportError(error, 'issuing a token');
      }
      const checked = await verifyStored(issued.accessToken, nowSeconds());
      if (attemptGeneration !== generation) {
        throw new ConsumerClientError('invalid-token', 'Authentication changed while signing in.');
      }
      if (!checked.valid) {
        discard();
        throw new ConsumerClientError('invalid-token', 'The issued token failed verification.');
      }
      if (checked.subject !== user.id) {
        discard();
        throw new ConsumerClientError('invalid-token', 'The issued token failed verification.');
      }
      const snapshot: ConsumerIdentitySnapshot = {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        expiresAt: checked.expiresAt,
      };
      // A later login for another user replaces previous state.
      saveStoredSession(store, scope, {
        accessToken: issued.accessToken,
        expiresAt: checked.expiresAt,
        user: { id: user.id, email: user.email, emailVerified: user.emailVerified },
      });
      return snapshot;
    },

    getSnapshot: async () => {
      const attemptGeneration = generation;
      const stored = loadStoredSession(store, scope);
      if (stored === null) {
        return null;
      }
      if (stored.expiresAt > nowSeconds()) {
        const checked = await verifyStored(stored.accessToken, nowSeconds());
        if (attemptGeneration !== generation) return null;
        if (!checked.valid || checked.subject !== stored.user.id) {
          discard();
          return null;
        }
        return {
          id: stored.user.id,
          email: stored.user.email,
          emailVerified: stored.user.emailVerified,
          expiresAt: checked.expiresAt,
        };
      }
      return coalescedRenew();
    },

    recoverSession: async () => {
      const attemptGeneration = generation;
      const stored = loadStoredSession(store, scope);
      if (stored !== null && stored.expiresAt > nowSeconds()) {
        const checked = await verifyStored(stored.accessToken, nowSeconds());
        if (attemptGeneration !== generation) return null;
        if (checked.valid && checked.subject === stored.user.id) {
          return {
            id: stored.user.id,
            email: stored.user.email,
            emailVerified: stored.user.emailVerified,
            expiresAt: checked.expiresAt,
          };
        }
      }
      // One explicit bootstrap: a single token issue plus a single identity
      // read through the live renewal session.
      let issued: { accessToken: string };
      try {
        const tokenResponse = await api.POST('/v1/auth/token', {
          credentials: 'include',
        } as Record<string, unknown>);
        if (tokenResponse.data === undefined) {
          if (tokenResponse.response.status === 401) {
            if (attemptGeneration === generation) discard();
            return null;
          }
          throw toClientError(
            tokenResponse.error,
            tokenResponse.response.status,
            'recovering the session',
          );
        }
        issued = { accessToken: tokenResponse.data.accessToken };
      } catch (error) {
        throw toTransportError(error, 'recovering the session');
      }
      const checked = await verifyStored(issued.accessToken, nowSeconds());
      if (attemptGeneration !== generation) return null;
      if (!checked.valid) {
        discard();
        throw new ConsumerClientError('invalid-token', 'The recovered token failed verification.');
      }
      let user: { id: string; email: string; emailVerified: boolean };
      try {
        const meResponse = await api.GET('/v1/me', { credentials: 'include' });
        if (meResponse.data === undefined) {
          if (meResponse.response.status === 401) {
            if (attemptGeneration === generation) discard();
            return null;
          }
          throw toClientError(
            meResponse.error,
            meResponse.response.status,
            'recovering the session',
          );
        }
        user = {
          id: meResponse.data.id,
          email: meResponse.data.email,
          emailVerified: meResponse.data.emailVerified,
        };
      } catch (error) {
        throw toTransportError(error, 'recovering the session');
      }
      if (attemptGeneration !== generation) return null;
      if (checked.subject !== user.id) {
        discard();
        throw new ConsumerClientError('invalid-token', 'The recovered token failed verification.');
      }
      const snapshot: ConsumerIdentitySnapshot = {
        id: user.id,
        email: user.email,
        emailVerified: user.emailVerified,
        expiresAt: checked.expiresAt,
      };
      saveStoredSession(store, scope, {
        accessToken: issued.accessToken,
        expiresAt: checked.expiresAt,
        user: { id: user.id, email: user.email, emailVerified: user.emailVerified },
      });
      return snapshot;
    },

    logout: async () => {
      discard();
      try {
        broadcast?.notifyLogout();
      } catch {
        // Notification is best-effort; local state is already cleared.
      }
      try {
        const response = await api.POST('/v1/auth/sign-out', {
          credentials: 'include',
        } as Record<string, unknown>);
        if (!response.response.ok) {
          throw new ConsumerClientError(
            'logout-failed',
            'Sign-out did not complete server-side; local state was cleared.',
            response.response.status,
          );
        }
      } catch (error) {
        if (error instanceof ConsumerClientError) {
          throw error;
        }
        throw new ConsumerClientError(
          'logout-failed',
          'Sign-out did not complete server-side; local state was cleared.',
        );
      }
    },

    register: async (input: ConsumerRegisterInput) => {
      try {
        const response = await api.POST('/v1/auth/register', {
          body: { name: input.name, email: input.email, password: input.password },
        });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'registering');
        }
        return {
          id: response.data.id,
          email: response.data.email,
          emailVerified: response.data.emailVerified,
        };
      } catch (error) {
        throw toTransportError(error, 'registering');
      }
    },

    verifyEmail: async (token: string) => {
      try {
        const response = await api.POST('/v1/auth/verify-email', { body: { token } });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'verifying the email');
        }
      } catch (error) {
        throw toTransportError(error, 'verifying the email');
      }
    },

    requestVerification: async (email: string) => {
      try {
        const response = await api.POST('/v1/auth/request-verification', { body: { email } });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'requesting verification');
        }
      } catch (error) {
        throw toTransportError(error, 'requesting verification');
      }
    },

    requestPasswordReset: async (email: string) => {
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

    resetPassword: async (token: string, newPassword: string) => {
      try {
        const response = await api.POST('/v1/auth/reset-password', {
          body: { token, newPassword },
        });
        if (response.data === undefined) {
          throw toClientError(response.error, response.response.status, 'resetting the password');
        }
      } catch (error) {
        throw toTransportError(error, 'resetting the password');
      }
    },

    observeLogout: (listener: () => void) => {
      if (broadcast === null) {
        return () => undefined;
      }
      return broadcast.observeLogout(() => {
        discard();
        listener();
      });
    },
  };

  // Active same-origin tabs clear their own tab-scoped state when another tab
  // logs out. Stale storage can never resurrect the prior user after logout.
  if (broadcast !== null) {
    broadcast.observeLogout(() => {
      discard();
    });
  }

  return client;
}
