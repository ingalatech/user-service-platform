import { createJwksCache } from '../jwks-cache.js';
import {
  readTokenKid,
  verifyConsumerToken,
  type ConsumerJsonWebKey,
  type VerifiedConsumerSnapshot,
} from '../verifier.js';

// Backend bearer verification with cached public keys (spec #150, ADR-0013,
// ticket #152). Receiving APIs verify the consumer JWT independently with the
// published JWKS: no session/database lookup per verification, no trust in
// decoded payloads or browser results. Browser snapshots are UI hints only;
// this verifier output is the authorization input.
//
// Key rollover: an unknown kid triggers one bounded JWKS refresh through the
// shared cache; retained keys stay published through every outstanding token
// lifetime plus clock tolerance, so verification never becomes an identity
// call per request.
export interface BackendVerifierOptions {
  // Service origin serving GET /v1/auth/jwks, for example
  // `https://users.example.com`.
  readonly serviceBaseUrl: string;
  readonly issuer: string;
  readonly audience: string;
  readonly fetchImpl?: typeof fetch;
  readonly jwksMaxAgeSeconds?: number;
  readonly clockToleranceSeconds?: number;
  readonly nowSeconds?: () => number;
}

export interface BackendVerifier {
  verify(authorization: string): Promise<VerifiedConsumerSnapshot>;
}

function readBearer(authorization: string): string | null {
  const match = /^Bearer (.+)$/.exec(authorization.trim());
  const token = match?.[1];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

export function createBackendVerifier(options: BackendVerifierOptions): BackendVerifier {
  const fetchImpl = options.fetchImpl ?? fetch;
  const clockToleranceSeconds = options.clockToleranceSeconds ?? 60;
  const nowSeconds = options.nowSeconds ?? (() => Math.floor(Date.now() / 1000));
  // The cache owns bounded fetching: one cold fetch, then at most one refresh
  // per unknown kid per cooldown interval.
  const jwks = createJwksCache({
    fetchJwks: async () => {
      const response = await fetchImpl(
        `${options.serviceBaseUrl.replace(/\/$/, '')}/v1/auth/jwks`,
        { headers: { accept: 'application/json' } },
      );
      if (!response.ok) {
        throw new Error(`Verification keys unavailable: ${String(response.status)}`);
      }
      const body = (await response.json()) as { keys?: ConsumerJsonWebKey[] };
      if (!Array.isArray(body.keys)) {
        throw new Error('Verification keys unavailable: malformed document.');
      }
      return { keys: body.keys };
    },
    maxAgeSeconds: options.jwksMaxAgeSeconds ?? 300,
    nowSeconds,
  });

  return {
    // Verifies a bearer token against cached public keys only. The identity
    // issuer/store is never consulted here.
    verify: async (authorization: string) => {
      const token = readBearer(authorization);
      if (token === null) {
        throw new Error('Missing bearer token.');
      }
      const kid = readTokenKid(token);
      if (kid !== null) {
        await jwks.getKey(kid).catch(() => null);
      } else if (jwks.cachedKeys().length === 0) {
        await jwks.getKey('__warmup__').catch(() => null);
      }
      return verifyConsumerToken(token, jwks.cachedKeys(), {
        issuer: options.issuer,
        audience: options.audience,
        nowSeconds: nowSeconds(),
        clockToleranceSeconds,
      });
    },
  };
}
