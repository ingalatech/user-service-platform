// Independently importable consumer Identity client entrypoint (spec #150,
// ADR-0013, ticket #152).
//
// The consumer team vendors these sources (no npm publication) and imports
// only this module. It depends solely on the generated OpenAPI contracts and
// `openapi-fetch`: no React, Hono, persistence or engine server types cross
// this boundary, so generated API evolution is the only coupling to the
// service repository.
export {
  createBrowserLogoutBroadcast,
  createConsumerClient,
  createMemoryLogoutBroadcast,
  ConsumerClientError,
  type ConsumerClient,
  type ConsumerClientOptions,
  type ConsumerIdentitySnapshot,
  type ConsumerLoginInput,
  type ConsumerRegisterInput,
  type LogoutBroadcast,
} from './client.js';
export { createJwksCache, type JwksCache, type JwksCacheInput } from './jwks-cache.js';
export {
  clearStoredSession,
  jwksStorageKey,
  loadStoredSession,
  saveStoredSession,
  tokenStorageKey,
  type ConsumerStorageScope,
  type KeyValueStorage,
  type StoredConsumerSession,
} from './storage.js';
export {
  ConsumerTokenError,
  verifyConsumerToken,
  type ConsumerJsonWebKey,
  type VerifiedConsumerSnapshot,
  type VerifyConsumerTokenErrorCode,
  type VerifyConsumerTokenInput,
} from './verifier.js';
