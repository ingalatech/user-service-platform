import { describe, expect, it, vi } from 'vitest';
import {
  assertValidNonSecretConfig,
  readEffectiveEnvironment,
  resolveEffectiveConfig,
  type EffectiveConfig,
} from './config.js';
import {
  ENVIRONMENT_PROFILES,
  COMPILED_CONFIG_DEFINE_NAME,
  LOCAL_PROFILE,
  NON_SECRET_VAR_NAMES,
  parseNonSecretProfile,
  PRODUCTION_PROFILE,
  SANDBOX_PROFILE,
  SECRET_VAR_NAMES,
  type NonSecretProfile,
} from './profiles.js';

// Seam under test (ticket #57, spec #8): the environment configuration
// boundary. Versioned non-secret profiles plus same-name runtime overrides
// resolve to one validated effective configuration. No runtime, database or
// auth engine is involved.
describe('environment profiles', () => {
  it('covers exactly the canonical local, sandbox and production environments', () => {
    expect(Object.keys(ENVIRONMENT_PROFILES).sort()).toEqual(['local', 'production', 'sandbox']);
  });

  it('gives every profile a complete value for each canonical runtime variable name', () => {
    for (const profile of [LOCAL_PROFILE, SANDBOX_PROFILE, PRODUCTION_PROFILE]) {
      expect(Object.keys(profile).sort()).toEqual([...NON_SECRET_VAR_NAMES].sort());
      for (const name of NON_SECRET_VAR_NAMES) {
        expect(typeof profile[name]).toBe('string');
      }
    }
  });

  it('uses the local deployment defaults for the local profile', () => {
    expect(LOCAL_PROFILE).toMatchObject({
      ENVIRONMENT: 'local',
      AUTH_REGISTRATION_ENABLED: 'true',
      AUTH_EMAIL_PASSWORD_ENABLED: 'true',
      AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    });
  });

  it('does not compile remote values into profiles', () => {
    expect(SANDBOX_PROFILE).toBe(LOCAL_PROFILE);
    expect(PRODUCTION_PROFILE).toBe(LOCAL_PROFILE);
  });

  it('freezes versioned profiles so runtime code cannot mutate them', () => {
    for (const profile of [LOCAL_PROFILE, SANDBOX_PROFILE, PRODUCTION_PROFILE]) {
      expect(Object.isFrozen(profile)).toBe(true);
    }
  });

  it('never carries known secret inputs in versioned profiles', () => {
    for (const profile of [LOCAL_PROFILE, SANDBOX_PROFILE, PRODUCTION_PROFILE]) {
      for (const secret of SECRET_VAR_NAMES) {
        expect(profile).not.toHaveProperty(secret);
      }
      // Allow-list assertion: every profile key is a known non-secret
      // variable name, so a secret-bearing key cannot slip in unnoticed.
      for (const key of Object.keys(profile)) {
        expect(NON_SECRET_VAR_NAMES as readonly string[]).toContain(key);
      }
    }
  });

  it('rejects a compiled profile whose keys diverge from the canonical source', () => {
    const missing = Object.fromEntries(
      Object.entries(LOCAL_PROFILE).filter(([name]) => name !== 'AUTH_APP_NAME'),
    );
    expect(() => parseNonSecretProfile(missing)).toThrow(/compiled profile keys/);
    expect(() =>
      parseNonSecretProfile({ ...LOCAL_PROFILE, UNEXPECTED_BINDING: 'ignored' }),
    ).toThrow(/compiled profile keys/);
  });
});

describe('resolveEffectiveConfig', () => {
  it('reads the profile from Wrangler define substitution when present', () => {
    const compiledProfile = {
      ...LOCAL_PROFILE,
      ENVIRONMENT: 'production',
      AUTH_APP_NAME: 'Bundled User Service',
    } satisfies NonSecretProfile;
    vi.stubGlobal(COMPILED_CONFIG_DEFINE_NAME, compiledProfile);

    try {
      const effective = resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_APP_NAME: 'Local Override' },
      });
      expect(effective.config).toEqual(compiledProfile);
      expect(effective.environment).toBe('production');
      expect(readEffectiveEnvironment({ ENVIRONMENT: 'local' })).toBe('production');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the compiled profile and ignores same-name runtime bindings', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const compiledProfile = {
      ...LOCAL_PROFILE,
      ENVIRONMENT: 'sandbox',
      AUTH_APP_NAME: 'Compiled User Service',
      AUTH_MAIL_TRANSPORT: 'smtp',
    } satisfies NonSecretProfile;

    try {
      const effective = resolveEffectiveConfig({
        environment: 'sandbox',
        compiledProfile,
        runtime: {
          ENVIRONMENT: 'sandbox',
          AUTH_APP_NAME: 'Dashboard Override',
          AUTH_MAIL_TRANSPORT: 'inmemory',
          SMTP_PASSWORD: 'secret-marker',
        },
      });

      expect(effective.config).toEqual(compiledProfile);
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          event: 'config.runtime-binding-ignored',
          bindings: ['ENVIRONMENT', 'AUTH_MAIL_TRANSPORT', 'AUTH_APP_NAME'],
        }),
      );
      expect(warn.mock.calls.join(' ')).not.toContain('secret-marker');

      resolveEffectiveConfig({
        compiledProfile,
        runtime: {
          ENVIRONMENT: 'sandbox',
          AUTH_APP_NAME: 'Dashboard Override',
          AUTH_MAIL_TRANSPORT: 'inmemory',
        },
      });
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('selects the local profile when no environment is provided', () => {
    const effective: EffectiveConfig = resolveEffectiveConfig({ runtime: {} });
    expect(effective.environment).toBe('local');
    expect(effective.config).toEqual(LOCAL_PROFILE);
  });

  it('keeps remote configuration values unset until runtime vars arrive', () => {
    const sandbox = resolveEffectiveConfig({ environment: 'sandbox', runtime: {} });
    const production = resolveEffectiveConfig({ environment: 'production', runtime: {} });
    expect(sandbox.config.AUTH_MAIL_TRANSPORT).toBe('');
    expect(production.config.AUTH_MAIL_TRANSPORT).toBe('');
  });

  it('lets same-name runtime values override profile values', () => {
    const effective = resolveEffectiveConfig({
      environment: 'local',
      runtime: { AUTH_REGISTRATION_ENABLED: 'false', AUTH_APP_NAME: 'Local Suite' },
    });
    expect(effective.config.AUTH_REGISTRATION_ENABLED).toBe('false');
    expect(effective.config.AUTH_APP_NAME).toBe('Local Suite');
    expect(effective.config.AUTH_EMAIL_PASSWORD_ENABLED).toBe(
      LOCAL_PROFILE.AUTH_EMAIL_PASSWORD_ENABLED,
    );
  });

  it('ignores undefined runtime values so they never blank profile defaults', () => {
    const effective = resolveEffectiveConfig({
      environment: 'local',
      runtime: { AUTH_APP_NAME: undefined },
    });
    expect(effective.config.AUTH_APP_NAME).toBe(LOCAL_PROFILE.AUTH_APP_NAME);
  });

  it('never lets runtime secrets enter the merged non-secret configuration', () => {
    const effective = resolveEffectiveConfig({
      environment: 'local',
      runtime: {
        BETTER_AUTH_SECRET: 'super-secret-value',
        RESEND_API_KEY: 're_secret_value',
        SMTP_USER: 'mailer@example.com',
        SMTP_PASSWORD: 'smtp_secret_value',
        AUTH_APP_NAME: 'Local Suite',
      },
    });
    expect(JSON.stringify(effective.config)).not.toContain('super-secret-value');
    expect(JSON.stringify(effective.config)).not.toContain('re_secret_value');
    expect(JSON.stringify(effective.config)).not.toContain('smtp_secret_value');
    expect(effective.config).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(effective.config).not.toHaveProperty('RESEND_API_KEY');
    expect(effective.config).not.toHaveProperty('SMTP_USER');
    expect(effective.config).not.toHaveProperty('SMTP_PASSWORD');
    expect(effective.config.AUTH_APP_NAME).toBe('Local Suite');
  });

  it('maps the legacy staging name onto the sandbox profile without adding staging config', () => {
    const effective = resolveEffectiveConfig({ environment: 'staging', runtime: {} });
    expect(effective.environment).toBe('sandbox');
    expect(effective.config.ENVIRONMENT).toBe('sandbox');
    expect(Object.keys(ENVIRONMENT_PROFILES)).not.toContain('staging');
  });

  it('keeps the isolated test context on the local profile shape', () => {
    const effective = resolveEffectiveConfig({
      environment: 'test',
      runtime: { AUTH_REGISTRATION_ENABLED: 'true' },
    });
    expect(effective.environment).toBe('test');
    expect(effective.config.AUTH_REGISTRATION_ENABLED).toBe('true');
  });

  it('rejects unknown environments with a redacted error', () => {
    expect(() => resolveEffectiveConfig({ environment: 'qa', runtime: {} })).toThrow(
      /local.*sandbox.*production/,
    );
  });

  it('rejects malformed boolean overrides instead of silently changing policy', () => {
    expect(() =>
      resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_REQUIRE_EMAIL_VERIFICATION: 'treu' },
      }),
    ).toThrow(/AUTH_REQUIRE_EMAIL_VERIFICATION/);
  });

  it('rejects unknown mail transports', () => {
    expect(() =>
      resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_MAIL_TRANSPORT: 'sendmail' },
      }),
    ).toThrow(/AUTH_MAIL_TRANSPORT/);
  });

  it('accepts the SMTP transport and its TLS mode values', () => {
    expect(
      resolveEffectiveConfig({
        environment: 'local',
        runtime: {
          AUTH_MAIL_TRANSPORT: 'smtp',
          SMTP_HOST: 'smtp.example.com',
          SMTP_PORT: '587',
          SMTP_SECURE: 'false',
        },
      }).config.AUTH_MAIL_TRANSPORT,
    ).toBe('smtp');
    expect(
      resolveEffectiveConfig({
        environment: 'local',
        runtime: { AUTH_MAIL_TRANSPORT: 'smtp', SMTP_SECURE: 'true' },
      }).config.SMTP_SECURE,
    ).toBe('true');
  });

  it('rejects malformed SMTP TLS modes instead of silently changing transport security', () => {
    expect(() =>
      resolveEffectiveConfig({
        environment: 'local',
        runtime: { SMTP_SECURE: 'starttls' },
      }),
    ).toThrow(/SMTP_SECURE/);
  });

  it('never echoes runtime values in validation errors', () => {
    let message = '';
    try {
      resolveEffectiveConfig({
        environment: 'local',
        runtime: {
          AUTH_REQUIRE_EMAIL_VERIFICATION: 'treu-super-secret-marker',
          RESEND_API_KEY: 're_secret_marker',
        },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('treu-super-secret-marker');
    expect(message).not.toContain('re_secret_marker');
  });
});

describe('assertValidNonSecretConfig', () => {
  it('accepts the existing isolated test environment inputs', () => {
    expect(() => {
      assertValidNonSecretConfig({
        ENVIRONMENT: 'test',
        AUTH_REGISTRATION_ENABLED: 'true',
        AUTH_EMAIL_PASSWORD_ENABLED: 'true',
        AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
      });
    }).not.toThrow();
  });

  it('rejects malformed values at the application boundary', () => {
    expect(() => {
      assertValidNonSecretConfig({
        ENVIRONMENT: 'local',
        AUTH_REGISTRATION_ENABLED: 'yes',
      });
    }).toThrow(/AUTH_REGISTRATION_ENABLED/);
  });
});
