import { describe, expect, it } from 'vitest';
import {
  clearStoredReaderState,
  invalidateStoredReaderState,
  jwksStorageKey,
  loadStoredReaderState,
  readerStateInvalidationKey,
  readerStateStorageKey,
  saveStoredReaderState,
  type KeyValueStorage,
} from './storage.js';

function memoryStorage(): KeyValueStorage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

const scope = {
  service: 'https://users.example',
  issuer: 'https://issuer.example',
  audience: 'reader-state',
};

describe('Reader State storage', () => {
  it('uses separate versioned deployment-scoped state and JWKS keys', () => {
    expect(readerStateStorageKey(scope)).toMatch(/^usp\.reader-state\.v1\./);
    expect(readerStateStorageKey(scope)).not.toBe(jwksStorageKey(scope));
    expect(readerStateStorageKey({ ...scope, service: 'https://other.example' })).not.toBe(
      readerStateStorageKey(scope),
    );
  });

  it('stores only compact Reader State and its verified expiry', () => {
    const storage = memoryStorage();
    saveStoredReaderState(storage, scope, { readerState: 'signed.state.value', expiresAt: 123 });
    expect(loadStoredReaderState(storage, scope)).toEqual({
      readerState: 'signed.state.value',
      expiresAt: 123,
    });
    expect(storage.getItem(readerStateStorageKey(scope))).not.toContain('email');
  });

  it('treats malformed state as absent and clears logout state', () => {
    const storage = memoryStorage();
    storage.setItem(readerStateStorageKey(scope), '{bad');
    expect(loadStoredReaderState(storage, scope)).toBeNull();
    saveStoredReaderState(storage, scope, { readerState: 'signed.state.value', expiresAt: 123 });
    clearStoredReaderState(storage, scope);
    expect(loadStoredReaderState(storage, scope)).toBeNull();
  });

  it('treats a durable invalidation marker as absent state', () => {
    const storage = memoryStorage();
    saveStoredReaderState(storage, scope, { readerState: 'signed.state.value', expiresAt: 123 });

    invalidateStoredReaderState(storage, scope);

    expect(storage.getItem(readerStateInvalidationKey(scope))).toBe('1');
    expect(loadStoredReaderState(storage, scope)).toBeNull();
  });
});
