import { describe, expect, it } from 'vitest';
import { createJwksCache } from './jwks-cache.js';
import type { KeyValueStorage } from './storage.js';
import type { ConsumerJsonWebKey } from './verifier.js';

// Seam under test (spec #150, ADR-0013, ticket #152): the independent public
// key cache. These tests prove JWKS fetching is bounded and shared —
// repeated lookups reuse cached keys and an unknown kid triggers at most one
// refresh per interval — so key verification never becomes a per-page
// identity call.
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

const SCOPE = { issuer: 'https://auth.test', audience: 'test-audience' };

function jwk(kid: string): ConsumerJsonWebKey {
  return { kid, kty: 'OKP', alg: 'EdDSA', crv: 'Ed25519', x: 'public-x' };
}

describe('consumer JWKS cache', () => {
  it('shares a cold fetch between concurrent verifications', async () => {
    let fetches = 0;
    const cache = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
    });
    await Promise.all([cache.getKey('key-1'), cache.getKey('key-1'), cache.getKey('key-1')]);
    expect(fetches).toBe(1);
  });
  it('fetches once and reuses cached keys for known kids', async () => {
    let fetches = 0;
    const cache = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
      storage: memoryStorage(),
      scope: SCOPE,
    });

    expect(await cache.getKey('key-1')).toEqual(jwk('key-1'));
    expect(await cache.getKey('key-1')).toEqual(jwk('key-1'));
    expect(fetches).toBe(1);
  });

  it('refreshes once for an unknown kid and then finds the rotated key', async () => {
    let fetches = 0;
    const cache = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({
          keys: fetches === 1 ? [jwk('key-1')] : [jwk('key-1'), jwk('key-2')],
        });
      },
      storage: memoryStorage(),
      scope: SCOPE,
    });

    expect(await cache.getKey('key-1')).toEqual(jwk('key-1'));
    expect(await cache.getKey('key-2')).toEqual(jwk('key-2'));
    expect(fetches).toBe(2);
  });

  it('bounds unknown-kid refresh so repeated misses do not fetch per lookup', async () => {
    let fetches = 0;
    let now = 1_700_000_000;
    const cache = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
      storage: memoryStorage(),
      scope: SCOPE,
      nowSeconds: () => now,
    });

    expect(await cache.getKey('missing')).toBeNull();
    expect(await cache.getKey('missing')).toBeNull();
    expect(fetches).toBe(2);

    // After the cooldown a later lookup may refresh once more, still bounded.
    now += 61;
    expect(await cache.getKey('missing')).toBeNull();
    expect(fetches).toBe(3);
  });

  it('shares persisted keys across instances without refetching', async () => {
    const storage = memoryStorage();
    let fetches = 0;
    const first = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
      storage,
      scope: SCOPE,
    });
    expect(await first.getKey('key-1')).toEqual(jwk('key-1'));
    expect(fetches).toBe(1);

    const second = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
      storage,
      scope: SCOPE,
    });
    expect(await second.getKey('key-1')).toEqual(jwk('key-1'));
    expect(fetches).toBe(1);
  });

  it('ignores malformed persisted entries and refetches', async () => {
    const storage = memoryStorage();
    storage.setItem('usp.consumer.v1.jwks.https%3A%2F%2Fauth.test.test-audience', 'not-json{{{');
    let fetches = 0;
    const cache = createJwksCache({
      fetchJwks: () => {
        fetches += 1;
        return Promise.resolve({ keys: [jwk('key-1')] });
      },
      storage,
      scope: SCOPE,
    });

    expect(await cache.getKey('key-1')).toEqual(jwk('key-1'));
    expect(fetches).toBe(1);
  });
});
