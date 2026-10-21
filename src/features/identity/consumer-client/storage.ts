// Versioned per-tab token/key cache for the framework-independent consumer
// client (spec #150, ADR-0013, ticket #152).
//
// The browser keeps the access token and the public-key cache in tab-scoped
// `sessionStorage` so full document navigations and reloads within the tab
// reuse a still-valid token without an identity request. Keys are versioned
// (`usp.consumer.v1`) and namespaced by service/issuer/audience so separate
// deployments never share credentials and a future format change cannot
// resurrect stale entries. The authoritative renewal session stays HttpOnly
// and is never stored here.
//
// Browser-storage/XSS trade-off: script-readable bearer storage is explicit.
// The short token lifetime, secure contexts and the consumer's normal
// script/CSP controls bound the exposure; the renewal credential never enters
// this store.
const STORAGE_VERSION = 'usp.consumer.v1';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface ConsumerStorageScope {
  readonly service?: string;
  readonly issuer: string;
  readonly audience: string;
}

export interface StoredConsumerSession {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly user: {
    readonly id: string;
    readonly email: string;
    readonly emailVerified: boolean;
  };
}

function scopeSuffix(scope: ConsumerStorageScope): string {
  const service = scope.service === undefined ? '' : `${encodeURIComponent(scope.service)}.`;
  return `${service}${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}`;
}

export function tokenStorageKey(scope: ConsumerStorageScope): string {
  return `${STORAGE_VERSION}.token.${scopeSuffix(scope)}`;
}

export function jwksStorageKey(scope: ConsumerStorageScope): string {
  return `${STORAGE_VERSION}.jwks.${scopeSuffix(scope)}`;
}

function isStoredSession(value: unknown): value is StoredConsumerSession {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.accessToken !== 'string' || record.accessToken.length === 0) {
    return false;
  }
  if (typeof record.expiresAt !== 'number' || !Number.isInteger(record.expiresAt)) {
    return false;
  }
  const user = record.user;
  if (typeof user !== 'object' || user === null) {
    return false;
  }
  const userRecord = user as Record<string, unknown>;
  return (
    typeof userRecord.id === 'string' &&
    userRecord.id.length > 0 &&
    typeof userRecord.email === 'string' &&
    userRecord.email.length > 0 &&
    typeof userRecord.emailVerified === 'boolean'
  );
}

// Parses a stored entry (`parseDontValidate`: returns the refined value
// instead of check-and-forget). Malformed entries are absent, never trusted.
export function loadStoredSession(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
): StoredConsumerSession | null {
  const raw = storage.getItem(tokenStorageKey(scope));
  if (raw === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStoredSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveStoredSession(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
  session: StoredConsumerSession,
): void {
  storage.setItem(tokenStorageKey(scope), JSON.stringify(session));
}

export function clearStoredSession(storage: KeyValueStorage, scope: ConsumerStorageScope): void {
  storage.removeItem(tokenStorageKey(scope));
}
