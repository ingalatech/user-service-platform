// Runtime variable names and local-only defaults. Remote values are owned by
// config/environments/.env.<environment> and compiled by release tooling.
export const NON_SECRET_VAR_NAMES = [
  'ENVIRONMENT',
  'AUTH_REGISTRATION_ENABLED',
  'AUTH_EMAIL_PASSWORD_ENABLED',
  'AUTH_REQUIRE_EMAIL_VERIFICATION',
  'AUTH_MAIL_TRANSPORT',
  'AUTH_MAIL_FROM',
  'AUTH_APP_NAME',
  'AUTH_MAIL_ALLOWLIST',
  'AUTH_VERIFY_EMAIL_ACTION_URL',
  'AUTH_RESET_PASSWORD_ACTION_URL',
  'AUTH_JWT_ISSUER',
  'AUTH_READER_STATE_AUDIENCE',
  'AUTH_READER_STATE_TTL_SECONDS',
  'AUTH_GATEWAY_ORIGINS',
  'AUTH_CONSUMER_ORIGINS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
] as const;

// Wrangler substitutes this identifier during remote bundling. The value is a
// complete non-secret profile; runtime secrets and infrastructure bindings stay
// outside the bundle.
export const COMPILED_CONFIG_DEFINE_NAME = '__USER_SERVICE_COMPILED_CONFIG__' as const;

export type NonSecretVarName = (typeof NON_SECRET_VAR_NAMES)[number];
export type NonSecretProfile = Record<NonSecretVarName, string>;
export type CanonicalEnvironment = 'local' | 'sandbox' | 'production';

const NON_SECRET_VAR_NAME_SET: ReadonlySet<string> = new Set(NON_SECRET_VAR_NAMES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonSecretProfile(value: unknown): value is NonSecretProfile {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return (
    keys.length === NON_SECRET_VAR_NAMES.length &&
    keys.every((name) => NON_SECRET_VAR_NAME_SET.has(name) && typeof value[name] === 'string')
  );
}

// This is the runtime guard for the Wrangler `define` boundary. The key list
// above is the only source of truth; an added, missing or non-string profile
// value fails before configuration can reach application code.
export function parseNonSecretProfile(value: unknown): NonSecretProfile {
  if (!isNonSecretProfile(value)) {
    throw new Error(
      'Configuration error: compiled profile keys do not match the canonical profile.',
    );
  }
  return value;
}

export const SECRET_VAR_NAMES = [
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASSWORD',
] as const;

export type SecretVarName = (typeof SECRET_VAR_NAMES)[number];

function freezeProfile(profile: NonSecretProfile): NonSecretProfile {
  return Object.freeze({ ...profile });
}

export const LOCAL_PROFILE: NonSecretProfile = freezeProfile({
  ENVIRONMENT: 'local',
  AUTH_REGISTRATION_ENABLED: 'true',
  AUTH_EMAIL_PASSWORD_ENABLED: 'true',
  AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
  AUTH_MAIL_TRANSPORT: '',
  AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
  AUTH_APP_NAME: 'User Service',
  AUTH_MAIL_ALLOWLIST: '',
  AUTH_VERIFY_EMAIL_ACTION_URL: '',
  AUTH_RESET_PASSWORD_ACTION_URL: '',
  AUTH_JWT_ISSUER: '',
  AUTH_READER_STATE_AUDIENCE: '',
  AUTH_READER_STATE_TTL_SECONDS: '',
  AUTH_GATEWAY_ORIGINS: '',
  AUTH_CONSUMER_ORIGINS: '',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
} satisfies NonSecretProfile);

// These aliases keep the local/test profile API stable. Remote release files
// provide the actual profile to the materializer instead of these defaults.
export const SANDBOX_PROFILE = LOCAL_PROFILE;
export const PRODUCTION_PROFILE = LOCAL_PROFILE;
export const ENVIRONMENT_PROFILES: Record<CanonicalEnvironment, NonSecretProfile> = {
  local: LOCAL_PROFILE,
  sandbox: LOCAL_PROFILE,
  production: LOCAL_PROFILE,
};
