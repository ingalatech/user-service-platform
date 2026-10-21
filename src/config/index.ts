import {
  assertValidNonSecretConfig,
  readEffectiveEnvironment,
  resolveEffectiveConfig,
} from './config.js';

// Public interface of the environment configuration boundary (spec #8,
// ticket #57). Feature slices and the application composition root import
// only this module; profile literals stay immutable and secret inputs never
// enter the merged non-secret configuration.
export { assertValidNonSecretConfig, readEffectiveEnvironment, resolveEffectiveConfig };
export type {
  EffectiveConfig,
  ResolvedEnvironment,
  ResolveEffectiveConfigInput,
} from './config.js';
export {
  COMPILED_CONFIG_DEFINE_NAME,
  ENVIRONMENT_PROFILES,
  LOCAL_PROFILE,
  NON_SECRET_VAR_NAMES,
  PRODUCTION_PROFILE,
  SANDBOX_PROFILE,
  SECRET_VAR_NAMES,
} from './profiles.js';
export type {
  CanonicalEnvironment,
  NonSecretProfile,
  NonSecretVarName,
  SecretVarName,
} from './profiles.js';
