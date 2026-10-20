// Runtime variable names and local-only defaults. Remote values are owned by
// config/environments/.env.<environment> and materialized by release tooling.
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
  'AUTH_JWT_AUDIENCE',
  'AUTH_JWT_TTL_SECONDS',
  'AUTH_GATEWAY_ORIGINS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
] as const;

export type NonSecretVarName = (typeof NON_SECRET_VAR_NAMES)[number];
export type NonSecretProfile = Record<NonSecretVarName, string>;
export type CanonicalEnvironment = 'local' | 'sandbox' | 'production';

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
  AUTH_JWT_AUDIENCE: '',
  AUTH_JWT_TTL_SECONDS: '',
  AUTH_GATEWAY_ORIGINS: '',
  SMTP_HOST: '',
  SMTP_PORT: '',
  SMTP_SECURE: '',
} satisfies NonSecretProfile);

// Remote profiles are aliases only for the runtime type boundary. They are
// never used to supply remote values; release files provide every value.
export const SANDBOX_PROFILE = LOCAL_PROFILE;
export const PRODUCTION_PROFILE = LOCAL_PROFILE;
export const ENVIRONMENT_PROFILES: Record<CanonicalEnvironment, NonSecretProfile> = {
  local: LOCAL_PROFILE,
  sandbox: LOCAL_PROFILE,
  production: LOCAL_PROFILE,
};
