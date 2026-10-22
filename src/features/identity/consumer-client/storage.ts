const STORAGE_VERSION = 'usp.reader-state.v1';

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

export interface StoredReaderState {
  readonly readerState: string;
  readonly expiresAt: number;
}

function scopeSuffix(scope: ConsumerStorageScope): string {
  const service = scope.service === undefined ? '' : `${encodeURIComponent(scope.service)}.`;
  return `${service}${encodeURIComponent(scope.issuer)}.${encodeURIComponent(scope.audience)}`;
}

export function readerStateStorageKey(scope: ConsumerStorageScope): string {
  return `${STORAGE_VERSION}.state.${scopeSuffix(scope)}`;
}

export function readerStateInvalidationKey(scope: ConsumerStorageScope): string {
  return `${STORAGE_VERSION}.invalidated.${scopeSuffix(scope)}`;
}

export function jwksStorageKey(scope: ConsumerStorageScope): string {
  return `${STORAGE_VERSION}.jwks.${scopeSuffix(scope)}`;
}

function parseStoredReaderState(value: unknown): StoredReaderState | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.readerState !== 'string' || record.readerState.length === 0) return null;
  if (typeof record.expiresAt !== 'number' || !Number.isInteger(record.expiresAt)) return null;
  return { readerState: record.readerState, expiresAt: record.expiresAt };
}

export function loadStoredReaderState(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
): StoredReaderState | null {
  if (storage.getItem(readerStateInvalidationKey(scope)) !== null) return null;
  const raw = storage.getItem(readerStateStorageKey(scope));
  if (raw === null) return null;
  try {
    return parseStoredReaderState(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function saveStoredReaderState(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
  state: StoredReaderState,
): void {
  storage.setItem(readerStateStorageKey(scope), JSON.stringify(state));
  storage.removeItem(readerStateInvalidationKey(scope));
}

export function clearStoredReaderState(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
): void {
  storage.removeItem(readerStateStorageKey(scope));
}

export function invalidateStoredReaderState(
  storage: KeyValueStorage,
  scope: ConsumerStorageScope,
): void {
  storage.setItem(readerStateInvalidationKey(scope), '1');
}
