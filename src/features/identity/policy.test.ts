import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTH_POLICY, resolveAuthPolicy } from './policy.js';

// Seam under test: the pure application-owned AuthPolicy resolution
// (ADR-0005). No runtime, database or auth engine is involved.
describe('resolveAuthPolicy', () => {
  it('falls back to the verified-email deployment defaults', () => {
    expect(resolveAuthPolicy({})).toEqual(DEFAULT_AUTH_POLICY);
    expect(DEFAULT_AUTH_POLICY).toMatchObject({
      registrationEnabled: true,
      emailPasswordEnabled: true,
      requireEmailVerification: true,
    });
  });

  it('honours explicit deployment flags', () => {
    expect(
      resolveAuthPolicy({
        AUTH_REGISTRATION_ENABLED: 'false',
        AUTH_EMAIL_PASSWORD_ENABLED: 'false',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
        AUTH_EMAIL_VERIFICATION_TTL_SECONDS: '7200',
      }),
    ).toEqual({
      registrationEnabled: false,
      emailPasswordEnabled: false,
      requireEmailVerification: false,
      emailVerificationTTLSeconds: 7200,
      passwordPolicy: DEFAULT_AUTH_POLICY.passwordPolicy,
    });
  });

  it('accepts explicit true/false values case-insensitively', () => {
    expect(
      resolveAuthPolicy({
        AUTH_REGISTRATION_ENABLED: 'TRUE',
        AUTH_EMAIL_PASSWORD_ENABLED: ' False ',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'True',
      }),
    ).toEqual({
      registrationEnabled: true,
      emailPasswordEnabled: false,
      requireEmailVerification: true,
      emailVerificationTTLSeconds: 3600,
      passwordPolicy: DEFAULT_AUTH_POLICY.passwordPolicy,
    });
  });

  it('rejects malformed values instead of silently disabling verification', () => {
    expect(() => resolveAuthPolicy({ AUTH_REQUIRE_EMAIL_VERIFICATION: 'treu' })).toThrow();
    expect(() => resolveAuthPolicy({ AUTH_REGISTRATION_ENABLED: 'yes' })).toThrow();
    expect(() => resolveAuthPolicy({ AUTH_EMAIL_PASSWORD_ENABLED: '' })).toThrow();
    expect(() => resolveAuthPolicy({ AUTH_REQUIRE_EMAIL_VERIFICATION: '2' })).toThrow();
    expect(() => resolveAuthPolicy({ AUTH_EMAIL_VERIFICATION_TTL_SECONDS: '0' })).toThrow();
  });
});
