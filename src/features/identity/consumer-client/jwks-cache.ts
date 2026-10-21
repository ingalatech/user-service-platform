import { jwksStorageKey, type ConsumerStorageScope, type KeyValueStorage } from './storage.js';
import type { ConsumerJsonWebKey } from './verifier.js';

// Independent public-key cache for the consumer client (spec #150, ADR-0013,
// ticket #152). JWKS fetching is bounded and shared: repeated lookups reuse
// cached keys, an unknown kid triggers at most one refresh per cooldown
// interval, and stale entries refetch after the bounded public cache
// lifetime. Key verification never becomes a per-page identity call.
export interface JwksCacheInput {
  readonly fetchJwks: () => Promise<{ keys: ConsumerJsonWebKey[] }>;
  readonly storage?: KeyValueStorage;
  readonly scope?: ConsumerStorageScope;
  // Bounded public cache lifetime in seconds (matches the service
  // `Cache-Control: public, max-age=300` on GET /v1/auth/jwks).
  readonly maxAgeSeconds?: number;
  // Cooldown between unknown-kid refreshes so repeated misses cannot cause a
  // fetch per lookup.
  readonly minRefreshIntervalSeconds?: number;
  // Isolated clock for tests; defaults to the real clock.
  readonly nowSeconds?: () => number;
}

export interface JwksCache {
  getKey(kid: string): Promise<ConsumerJsonWebKey | null>;
  cachedKeys(): readonly ConsumerJsonWebKey[];
}

interface PersistedJwks {
  readonly fetchedAtSeconds: number;
  readonly keys: ConsumerJsonWebKey[];
  readonly lastRefreshAttemptSeconds?: number;
  readonly refreshUnavailable?: boolean;
}

function isPersistedJwks(value: unknown): value is PersistedJwks {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.fetchedAtSeconds !== 'number' || !Number.isInteger(record.fetchedAtSeconds)) {
    return false;
  }
  if (!Array.isArray(record.keys)) {
    return false;
  }
  return record.keys.every((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const candidate = entry as Record<string, unknown>;
    return (
      typeof candidate.kid === 'string' &&
      candidate.kid.length > 0 &&
      typeof candidate.kty === 'string' &&
      typeof candidate.alg === 'string'
    );
  });
}

export function createJwksCache(input: JwksCacheInput): JwksCache {
  const maxAgeSeconds = input.maxAgeSeconds ?? 300;
  const minRefreshIntervalSeconds = input.minRefreshIntervalSeconds ?? 60;
  const nowSeconds = input.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  let keys: ConsumerJsonWebKey[] | null = null;
  let fetchedAtSeconds: number | null = null;
  let lastRefreshAttemptSeconds: number | null = null;
  let refreshUnavailable = false;
  let fetchInFlight: Promise<void> | null = null;

  const readPersisted = (): void => {
    if (keys !== null || input.storage === undefined || input.scope === undefined) {
      return;
    }
    const raw = input.storage.getItem(jwksStorageKey(input.scope));
    if (raw === null) {
      return;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isPersistedJwks(parsed)) {
        keys = [...parsed.keys];
        fetchedAtSeconds = parsed.fetchedAtSeconds;
        lastRefreshAttemptSeconds =
          typeof parsed.lastRefreshAttemptSeconds === 'number' &&
          Number.isInteger(parsed.lastRefreshAttemptSeconds)
            ? parsed.lastRefreshAttemptSeconds
            : null;
        refreshUnavailable = parsed.refreshUnavailable === true;
      }
    } catch {
      // Malformed persisted entries are absent, never trusted.
    }
  };

  const persist = (atSeconds: number, next: ConsumerJsonWebKey[]): void => {
    if (input.storage === undefined || input.scope === undefined) {
      return;
    }
    input.storage.setItem(
      jwksStorageKey(input.scope),
      JSON.stringify({
        fetchedAtSeconds: atSeconds,
        keys: next,
        ...(lastRefreshAttemptSeconds === null ? {} : { lastRefreshAttemptSeconds }),
        refreshUnavailable,
      } satisfies PersistedJwks),
    );
  };

  const performFetch = async (markRefreshAttempt: boolean): Promise<void> => {
    const atSeconds = nowSeconds();
    if (markRefreshAttempt) {
      lastRefreshAttemptSeconds = atSeconds;
    }
    try {
      const fresh = await input.fetchJwks();
      keys = [...fresh.keys];
      fetchedAtSeconds = atSeconds;
      refreshUnavailable = false;
      persist(atSeconds, keys);
    } catch {
      // A missing key during an outage is unavailable, not invalid. Retain
      // known keys and the cooldown across full document navigations.
      refreshUnavailable = true;
      lastRefreshAttemptSeconds = atSeconds;
      persist(fetchedAtSeconds ?? 0, keys ?? []);
    }
  };

  const fetchAndStore = (markRefreshAttempt: boolean): Promise<void> => {
    fetchInFlight ??= performFetch(markRefreshAttempt).finally(() => {
      fetchInFlight = null;
    });
    return fetchInFlight;
  };

  const isStale = (atSeconds: number): boolean =>
    fetchedAtSeconds === null || atSeconds - fetchedAtSeconds >= maxAgeSeconds;

  return {
    cachedKeys: () => {
      readPersisted();
      return keys === null ? [] : [...keys];
    },
    getKey: async (kid: string) => {
      readPersisted();
      if (
        (keys === null || isStale(nowSeconds())) &&
        (lastRefreshAttemptSeconds === null ||
          nowSeconds() - lastRefreshAttemptSeconds >= minRefreshIntervalSeconds)
      ) {
        await fetchAndStore(false);
      }
      const found = keys?.find((entry) => entry.kid === kid) ?? null;
      if (found !== null) {
        return found;
      }
      // Bounded unknown-kid refresh: at most one fetch per cooldown interval,
      // distinct from per-page identity resolution.
      const atSeconds = nowSeconds();
      if (
        lastRefreshAttemptSeconds === null ||
        atSeconds - lastRefreshAttemptSeconds >= minRefreshIntervalSeconds
      ) {
        await fetchAndStore(true);
        const refreshed = keys?.find((entry) => entry.kid === kid) ?? null;
        if (refreshed !== null) return refreshed;
      }
      if (refreshUnavailable) throw new Error('Verification keys are unavailable.');
      return null;
    },
  };
}
