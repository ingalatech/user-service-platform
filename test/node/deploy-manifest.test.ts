import { describe, expect, it } from 'vitest';
import { LOCAL_PROFILE, type NonSecretProfile } from '../../src/config/index.js';
import {
  buildVersionManifest,
  parseVersionManifest,
  requiredSecretNamesForTransport,
} from '../../scripts/deploy/manifest.js';

const SMTP_PROFILE: NonSecretProfile = {
  ...LOCAL_PROFILE,
  ENVIRONMENT: 'sandbox',
  AUTH_MAIL_TRANSPORT: 'smtp',
};

describe('version manifests', () => {
  it('round-trips the compiled profile fingerprint and mail transport annotations', () => {
    const manifest = buildVersionManifest(SMTP_PROFILE);

    expect(JSON.stringify(manifest)).not.toMatch(
      /BETTER_AUTH_SECRET|RESEND_API_KEY|SMTP_USER|SMTP_PASSWORD|secret-marker/,
    );
    expect(manifest.fingerprint).toBe(
      'ebfb1b4ac3edb106f757cbf82ae59f9889811f6ae40a2f9da9afd8dd481fdd7f',
    );
    expect(
      parseVersionManifest({
        'workers/message': `${manifest.message} commit=abc`,
        'workers/tag': manifest.tag,
      }),
    ).toEqual({
      fingerprint: manifest.fingerprint,
      mailTransport: 'smtp',
    });
  });

  it('rejects a tampered message or tag', () => {
    const manifest = buildVersionManifest(SMTP_PROFILE);

    expect(() =>
      parseVersionManifest({
        'workers/message': manifest.message.replace(manifest.fingerprint, '0'.repeat(64)),
        'workers/tag': manifest.tag,
      }),
    ).toThrow(/manifest/);
    expect(() =>
      parseVersionManifest({
        'workers/message': manifest.message,
        'workers/tag': `${manifest.tag}-tampered`,
      }),
    ).toThrow(/manifest/);
  });

  it('rejects an exact-version view without a manifest', () => {
    expect(() => parseVersionManifest({ 'workers/message': 'commit=abc' })).toThrow(/manifest/);
  });

  it('changes the fingerprint when the compiled mail transport changes', () => {
    expect(
      buildVersionManifest({ ...SMTP_PROFILE, AUTH_MAIL_TRANSPORT: 'resend' }).fingerprint,
    ).not.toBe(buildVersionManifest(SMTP_PROFILE).fingerprint);
  });
});

describe('conditional promotion secret bindings', () => {
  it('requires only the always-on and SMTP bindings for smtp', () => {
    expect(requiredSecretNamesForTransport('smtp')).toEqual([
      'BETTER_AUTH_SECRET',
      'SMTP_USER',
      'SMTP_PASSWORD',
    ]);
  });

  it('requires only the always-on and Resend bindings for resend', () => {
    expect(requiredSecretNamesForTransport('resend')).toEqual([
      'BETTER_AUTH_SECRET',
      'RESEND_API_KEY',
    ]);
  });

  it('fails closed for remote inmemory and empty transports', () => {
    expect(() => requiredSecretNamesForTransport('inmemory')).toThrow(/mail transport/);
    expect(() => requiredSecretNamesForTransport('')).toThrow(/mail transport/);
  });
});
