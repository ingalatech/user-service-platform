import type { ConsumerJsonWebKey, ConsumerJwksResponse, ReaderStateResponse } from './contract.js';
import { callIdentityEngine, readIdentityEngineFailure } from './engine-result.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { extractReaderStateExpiry } from './reader-state.js';

export type ReaderStateIssueResult =
  | { readonly kind: 'issued'; readonly value: ReaderStateResponse }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'internal-error' };

export type ReaderStateJwksResult =
  | { readonly kind: 'published'; readonly value: ConsumerJwksResponse }
  | { readonly kind: 'internal-error' };

export interface ReaderStateOperations {
  issue(headers: Headers, requestId?: string): Promise<ReaderStateIssueResult>;
  publishJwks(headers: Headers): Promise<ReaderStateJwksResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

function projectPublicJwks(value: unknown): ConsumerJwksResponse | null {
  const entries = asRecord(value)?.keys;
  if (!Array.isArray(entries)) return null;
  const keys: ConsumerJsonWebKey[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    if (
      record === null ||
      typeof record.kid !== 'string' ||
      typeof record.kty !== 'string' ||
      typeof record.alg !== 'string'
    ) {
      return null;
    }
    const key: ConsumerJsonWebKey = {
      kid: record.kid,
      kty: record.kty,
      alg: record.alg,
    };
    for (const field of ['use', 'crv', 'x', 'y', 'n', 'e'] as const) {
      const fieldValue = record[field];
      if (fieldValue === undefined) continue;
      if (typeof fieldValue !== 'string') return null;
      key[field] = fieldValue;
    }
    keys.push(key);
  }
  return { keys };
}

// Reader State owns its fail-closed issuer configuration, authoritative
// session-to-token flow, expiry projection and public-key allowlist. The router
// remains responsible only for origin guards, HTTP status, cache headers and
// Problem Details rendering.
export function createReaderStateOperations(runtime: IdentityRuntime): ReaderStateOperations {
  return {
    async issue(headers, requestId) {
      let readerStateAuth: ReturnType<typeof runtime.readerState>;
      try {
        // Resolve Reader State configuration before session state, matching the
        // previous route's fail-closed error ordering.
        readerStateAuth = runtime.readerState();
      } catch {
        return { kind: 'internal-error' };
      }

      const session = await runtime.resolveSessionContext(headers, requestId);
      if (session === null) return { kind: 'unauthenticated' };
      const result = await callIdentityEngine(() =>
        readerStateAuth.api.getToken({ headers, asResponse: true }),
      );
      if (!(result instanceof Response)) {
        return result.status >= 500 ? { kind: 'internal-error' } : { kind: 'unauthenticated' };
      }
      if (!result.ok) {
        const engineFailure = await readIdentityEngineFailure(result);
        return engineFailure.status >= 500
          ? { kind: 'internal-error' }
          : { kind: 'unauthenticated' };
      }
      const token = asRecord(await result.json().catch(() => null))?.token;
      if (typeof token !== 'string' || token.length === 0) return { kind: 'internal-error' };
      const expiresAt = extractReaderStateExpiry(token);
      if (expiresAt === null) return { kind: 'internal-error' };
      return { kind: 'issued', value: { readerState: token, expiresAt } };
    },

    async publishJwks(headers) {
      let readerStateAuth: ReturnType<typeof runtime.readerState>;
      try {
        readerStateAuth = runtime.readerState();
      } catch {
        return { kind: 'internal-error' };
      }
      const result = await callIdentityEngine(() =>
        readerStateAuth.api.getJwks({ headers, asResponse: true }),
      );
      if (!(result instanceof Response) || !result.ok) return { kind: 'internal-error' };
      const value = projectPublicJwks(await result.json().catch(() => null));
      return value === null ? { kind: 'internal-error' } : { kind: 'published', value };
    },
  };
}
