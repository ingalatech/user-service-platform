// Independently importable Reader State client. It depends only on generated
// HTTP contracts and openapi-fetch, never server internals.
export {
  createBrowserReaderStateBroadcast,
  createConsumerClient,
  createMemoryReaderStateBroadcast,
  ConsumerClientError,
  type AuthoritativeSessionStatus,
  type ConsumerClient,
  type AuthConfig,
  type PasswordPolicy,
  type PasswordPolicyEvaluation,
  type PasswordPolicyRule,
  evaluatePassword,
  type ConsumerClientOptions,
  type ConsumerLoginInput,
  type ConsumerReaderState,
  type ConsumerRegisterInput,
  type ReaderStateBroadcast,
} from './client.js';
export { createJwksCache, type JwksCache, type JwksCacheInput } from './jwks-cache.js';
export {
  clearStoredReaderState,
  invalidateStoredReaderState,
  jwksStorageKey,
  loadStoredReaderState,
  readerStateStorageKey,
  readerStateInvalidationKey,
  saveStoredReaderState,
  type ConsumerStorageScope,
  type KeyValueStorage,
  type StoredReaderState,
} from './storage.js';
export {
  ReaderStateError,
  readReaderStateKid,
  verifyReaderState,
  type ConsumerJsonWebKey,
  type VerifiedReaderState,
  type VerifyReaderStateErrorCode,
  type VerifyReaderStateInput,
} from './verifier.js';
