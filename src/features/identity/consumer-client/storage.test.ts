import { describe, expect, it } from 'vitest';
import {
  clearStoredSession,
  jwksStorageKey,
  loadStoredSession,
  saveStoredSession,
  tokenStorageKey,
  type KeyValueStorage,
} from './storage.js';

// Seam under test (spec #150, ADR-0013, ticket #152): the versioned per-tab
// token/key cache namespaced by service/issuer/audience. These tests prove
// the storage boundary that lets full document navigations and reloads reuse
// a still-valid token without an identity request, while keeping separate
// users and deployments isolated.
function memoryStorage(): KeyValueStorage & { readonly backing: Map<string, string> } {
  const backing = new Map<string, string>();
  return {
    backing,
    getItem: (key: string) => backing.get(key) ?? null,
    setItem: (key: string, value: string) => {
      backing.set(key, value);
    },
    removeItem: (key: string) => {
      backing.delete(key);
    },
  };
}

const scopeA = { issuer: 'https://auth.example', audience: 'editorial-web' };
const scopeB = { issuer: 'https://auth.other', audience: 'editorial-web' };

describe('consumer token storage', () => {
  it('namespaces token and JWKS keys by versioned service/issuer/audience', () => {
    const tokenKey = tokenStorageKey(scopeA);
    const jwksKey = jwksStorageKey(scopeA);

    expect(tokenKey).not.toBe(jwksKey);
    expect(tokenKey).toContain('https%3A%2F%2Fauth.example');
    expect(tokenKey).toContain('editorial-web');
    expect(jwksKey).toContain('https%3A%2F%2Fauth.example');
    expect(jwksKey).toContain('editorial-web');
    // Versioned so a future format change cannot resurrect stale entries.
    expect(tokenKey).toMatch(/^usp\.consumer\.v1\./);
    expect(jwksKey).toMatch(/^usp\.consumer\.v1\./);
  });

  it('round-trips a stored session through the same scope', () => {
    const storage = memoryStorage();
    saveStoredSession(storage, scopeA, {
      accessToken: 'token-a',
      expiresAt: 1_700_000_000,
      user: { id: 'user-1', email: 'ada@example.com', emailVerified: true },
    });

    expect(loadStoredSession(storage, scopeA)).toEqual({
      accessToken: 'token-a',
      expiresAt: 1_700_000_000,
      user: { id: 'user-1', email: 'ada@example.com', emailVerified: true },
    });
  });

  it('isolates separate deployments and never leaks across scopes', () => {
    const storage = memoryStorage();
    saveStoredSession(storage, scopeA, {
      accessToken: 'token-a',
      expiresAt: 1_700_000_000,
      user: { id: 'user-1', email: 'ada@example.com', emailVerified: true },
    });

    expect(loadStoredSession(storage, scopeB)).toBeNull();
    expect(tokenStorageKey({ ...scopeA, service: 'https://service-a.example' })).not.toBe(
      tokenStorageKey({ ...scopeA, service: 'https://service-b.example' }),
    );
  });

  it('replaces previous state on a later login for another user', () => {
    const storage = memoryStorage();
    saveStoredSession(storage, scopeA, {
      accessToken: 'token-old',
      expiresAt: 1_700_000_000,
      user: { id: 'user-old', email: 'old@example.com', emailVerified: true },
    });
    saveStoredSession(storage, scopeA, {
      accessToken: 'token-new',
      expiresAt: 1_700_000_100,
      user: { id: 'user-new', email: 'new@example.com', emailVerified: true },
    });

    expect(loadStoredSession(storage, scopeA)?.accessToken).toBe('token-new');
    expect(loadStoredSession(storage, scopeA)?.user.id).toBe('user-new');
  });

  it('clears local state on logout so stale storage cannot resurrect the prior user', () => {
    const storage = memoryStorage();
    saveStoredSession(storage, scopeA, {
      accessToken: 'token-a',
      expiresAt: 1_700_000_000,
      user: { id: 'user-1', email: 'ada@example.com', emailVerified: true },
    });
    clearStoredSession(storage, scopeA);

    expect(loadStoredSession(storage, scopeA)).toBeNull();
  });

  it('treats malformed entries as absent rather than trusting them', () => {
    const storage = memoryStorage();
    storage.setItem(tokenStorageKey(scopeA), 'not-json{{{');

    expect(loadStoredSession(storage, scopeA)).toBeNull();
  });
});
