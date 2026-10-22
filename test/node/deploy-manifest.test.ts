import { describe, expect, it } from 'vitest';
import { LOCAL_PROFILE, type NonSecretProfile } from '../../src/config/index.js';
import {
  buildVersionManifest,
  parseVersionManifest,
  requiredSecretNamesForTransport,
  versionLabel,
} from '../../scripts/deploy/manifest.js';

const SMTP_PROFILE: NonSecretProfile = {
  ...LOCAL_PROFILE,
  ENVIRONMENT: 'sandbox',
  AUTH_MAIL_TRANSPORT: 'smtp',
};
const PROVENANCE = {
  branch: 'Feature/Release Candidate',
  commit: '0123456789abcdef0123456789abcdef01234567',
  tag: '0123456-20261022T120000Z-feature-release-candidate',
} as const;

describe('version manifests', () => {
  it('round-trips the compiled profile fingerprint and mail transport annotations', () => {
    const manifest = buildVersionManifest(SMTP_PROFILE, PROVENANCE);

    expect(JSON.stringify(manifest)).not.toMatch(
      /BETTER_AUTH_SECRET|RESEND_API_KEY|SMTP_USER|SMTP_PASSWORD|secret-marker/,
    );
    expect(manifest.fingerprint).toBe(
      '09fe3a570902ebf81c2a134788ea25c557690be9dc6580188ddbf6363076e47a',
    );
    expect(
      parseVersionManifest({
        'workers/message': manifest.message,
        'workers/tag': manifest.tag,
      }),
    ).toEqual({
      branch: PROVENANCE.branch,
      commit: PROVENANCE.commit,
      fingerprint: manifest.fingerprint,
      mailTransport: 'smtp',
    });
  });

  it('rejects a tampered message but does not couple the tag to the fingerprint', () => {
    const manifest = buildVersionManifest(SMTP_PROFILE, PROVENANCE);

    expect(() =>
      parseVersionManifest({
        'workers/message': manifest.message.replace(PROVENANCE.commit, 'g'.repeat(40)),
        'workers/tag': manifest.tag,
      }),
    ).toThrow(/manifest/);
    expect(
      parseVersionManifest({
        'workers/message': manifest.message,
        'workers/tag': 'human-readable-candidate',
      }).commit,
    ).toBe(PROVENANCE.commit);
    expect(() =>
      parseVersionManifest({ 'workers/message': manifest.message, 'workers/tag': '' }),
    ).toThrow(/manifest/);
  });

  it('rejects an exact-version view without a manifest', () => {
    expect(() => parseVersionManifest({ 'workers/message': 'commit=abc' })).toThrow(/manifest/);
  });

  it('changes the fingerprint when the compiled mail transport changes', () => {
    expect(
      buildVersionManifest({ ...SMTP_PROFILE, AUTH_MAIL_TRANSPORT: 'resend' }, PROVENANCE)
        .fingerprint,
    ).not.toBe(buildVersionManifest(SMTP_PROFILE, PROVENANCE).fingerprint);
  });

  it('uses the frontend-compatible human version label', () => {
    expect(
      versionLabel(
        'Feature/Release Candidate',
        PROVENANCE.commit,
        new Date('2026-10-22T12:00:00.123Z'),
      ),
    ).toBe('0123456-20261022T120000Z-feature-release-candidate');
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
