import type { Env } from '../../env.js';
import type { PasswordPolicy } from './password-policy.js';

// Application-owned authentication policy (ADR-0005). Deployment-level
// configuration that controls supported authentication behaviour without
// exposing Better Auth configuration to feature code. The identity
// infrastructure layer translates this policy into Better Auth options per
// request; business feature slices never see either representation.
export interface AuthPolicy {
  // Whether public email/password registration accepts new accounts.
  readonly registrationEnabled: boolean;
  // Whether email/password authentication is available at all.
  readonly emailPasswordEnabled: boolean;
  // Whether an email/password session requires a verified email address.
  // The initial deployment requires verification (GLOSSARY.md).
  readonly requireEmailVerification: boolean;
  // Lifetime of Better Auth verification tokens, in seconds.
  readonly emailVerificationTTLSeconds: number;
  readonly passwordPolicy: PasswordPolicy;
}

// Deployment defaults for the initial single-client release: open
// registration with email/password, gated on verified email.
export const DEFAULT_AUTH_POLICY: AuthPolicy = {
  registrationEnabled: true,
  emailPasswordEnabled: true,
  requireEmailVerification: true,
  emailVerificationTTLSeconds: 3600,
  passwordPolicy: {
    minLength: 8,
    maxLength: 128,
    minUppercase: 1,
    minLowercase: 1,
    minDigits: 1,
    minSymbols: 0,
  },
};

function parseFlag(value: string | undefined, fallback: boolean, name: string): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(`Invalid boolean for ${name}: expected "true" or "false".`);
}

function parsePositiveInteger(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid positive integer for ${name}.`);
  }
  return parsed;
}

// Resolves the effective policy from Worker environment vars. Absent values
// fall back to the deployment defaults; only the explicit strings "true" /
// "false" (case-insensitive) are accepted. Malformed values reject
// configuration by throwing so a typo such as
// AUTH_REQUIRE_EMAIL_VERIFICATION=treu can never silently disable the
// verification gate (fail closed via the application 500 boundary).
export function resolveAuthPolicy(
  env: Pick<
    Env,
    | 'AUTH_REGISTRATION_ENABLED'
    | 'AUTH_EMAIL_PASSWORD_ENABLED'
    | 'AUTH_REQUIRE_EMAIL_VERIFICATION'
    | 'AUTH_EMAIL_VERIFICATION_TTL_SECONDS'
    | 'AUTH_PASSWORD_MIN_LENGTH'
    | 'AUTH_PASSWORD_MAX_LENGTH'
    | 'AUTH_PASSWORD_MIN_UPPERCASE'
    | 'AUTH_PASSWORD_MIN_LOWERCASE'
    | 'AUTH_PASSWORD_MIN_DIGITS'
    | 'AUTH_PASSWORD_MIN_SYMBOLS'
  >,
): AuthPolicy {
  const number = (
    name:
      | 'AUTH_PASSWORD_MIN_LENGTH'
      | 'AUTH_PASSWORD_MAX_LENGTH'
      | 'AUTH_PASSWORD_MIN_UPPERCASE'
      | 'AUTH_PASSWORD_MIN_LOWERCASE'
      | 'AUTH_PASSWORD_MIN_DIGITS'
      | 'AUTH_PASSWORD_MIN_SYMBOLS',
    fallback: number,
  ): number => {
    const value = env[name];
    return value === undefined ? fallback : Number(value);
  };
  return {
    registrationEnabled: parseFlag(
      env.AUTH_REGISTRATION_ENABLED,
      DEFAULT_AUTH_POLICY.registrationEnabled,
      'AUTH_REGISTRATION_ENABLED',
    ),
    emailPasswordEnabled: parseFlag(
      env.AUTH_EMAIL_PASSWORD_ENABLED,
      DEFAULT_AUTH_POLICY.emailPasswordEnabled,
      'AUTH_EMAIL_PASSWORD_ENABLED',
    ),
    requireEmailVerification: parseFlag(
      env.AUTH_REQUIRE_EMAIL_VERIFICATION,
      DEFAULT_AUTH_POLICY.requireEmailVerification,
      'AUTH_REQUIRE_EMAIL_VERIFICATION',
    ),
    emailVerificationTTLSeconds: parsePositiveInteger(
      env.AUTH_EMAIL_VERIFICATION_TTL_SECONDS,
      DEFAULT_AUTH_POLICY.emailVerificationTTLSeconds,
      'AUTH_EMAIL_VERIFICATION_TTL_SECONDS',
    ),
    passwordPolicy: {
      minLength: number('AUTH_PASSWORD_MIN_LENGTH', DEFAULT_AUTH_POLICY.passwordPolicy.minLength),
      maxLength: number('AUTH_PASSWORD_MAX_LENGTH', DEFAULT_AUTH_POLICY.passwordPolicy.maxLength),
      minUppercase: number(
        'AUTH_PASSWORD_MIN_UPPERCASE',
        DEFAULT_AUTH_POLICY.passwordPolicy.minUppercase,
      ),
      minLowercase: number(
        'AUTH_PASSWORD_MIN_LOWERCASE',
        DEFAULT_AUTH_POLICY.passwordPolicy.minLowercase,
      ),
      minDigits: number('AUTH_PASSWORD_MIN_DIGITS', DEFAULT_AUTH_POLICY.passwordPolicy.minDigits),
      minSymbols: number(
        'AUTH_PASSWORD_MIN_SYMBOLS',
        DEFAULT_AUTH_POLICY.passwordPolicy.minSymbols,
      ),
    },
  };
}
