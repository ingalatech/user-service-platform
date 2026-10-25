// Supported framework-independent Reader State client. Storage mutations,
// JWKS cache construction, broadcast adapters and signature-verifier internals
// remain private to this feature. The storage-key helper and storage adapter
// type are retained only because the vendored RCH client test reads persisted
// state directly; production callers should observe state through ConsumerClient.
export {
  createConsumerClient,
  ConsumerClientError,
  evaluatePassword,
  type AuthoritativeSessionStatus,
  type AuthConfig,
  type ConsumerClient,
  type ConsumerClientOptions,
  type ConsumerLoginInput,
  type ConsumerReaderState,
  type ConsumerRegisterInput,
  type PasswordPolicy,
  type PasswordPolicyEvaluation,
  type PasswordPolicyRule,
} from './client.js';

// Compatibility needed by the vendored RCH client test; remove only after a
// separate RCH change moves that assertion behind its private storage seam.
export {
  readerStateStorageKey,
  type ConsumerStorageScope,
  type KeyValueStorage,
} from './storage.js';
