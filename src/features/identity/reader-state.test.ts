import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READER_STATE_TTL_SECONDS as DEFAULT_CONSUMER_TOKEN_TTL_SECONDS,
  LOCAL_READER_STATE_AUDIENCE as LOCAL_CONSUMER_TOKEN_AUDIENCE,
  LOCAL_READER_STATE_ISSUER as LOCAL_CONSUMER_TOKEN_ISSUER,
  MAX_READER_STATE_TTL_SECONDS as MAX_CONSUMER_TOKEN_TTL_SECONDS,
  capReaderStateExpirySeconds as capTokenExpirySeconds,
  extractReaderStateExpiry as extractTokenExpiry,
  resolveReaderStateConfig as resolveConsumerTokenConfig,
} from './reader-state.js';

// Seam under test: the pure application-owned Reader State configuration
// boundary (spec #195, ADR-0013). Issuer, audience and lifetime resolve from
// the effective non-secret configuration; malformed values fail closed and
// sandbox/production never fall back to local defaults. No runtime, database
// or auth engine is involved.
describe('resolveReaderStateConfig', () => {
  it('uses deterministic local-only defaults when nothing is configured', () => {
    const config = resolveConsumerTokenConfig({ environment: 'local' });

    expect(config.issuer).toBe(LOCAL_CONSUMER_TOKEN_ISSUER);
    expect(config.audience).toBe(LOCAL_CONSUMER_TOKEN_AUDIENCE);
    expect(config.ttlSeconds).toBe(DEFAULT_CONSUMER_TOKEN_TTL_SECONDS);
    expect(DEFAULT_CONSUMER_TOKEN_TTL_SECONDS).toBe(900);
    expect(MAX_CONSUMER_TOKEN_TTL_SECONDS).toBe(900);
  });

  it('uses deterministic local-only defaults in the isolated test context', () => {
    const config = resolveConsumerTokenConfig({ environment: 'test' });

    expect(config.issuer).toBe(LOCAL_CONSUMER_TOKEN_ISSUER);
    expect(config.audience).toBe(LOCAL_CONSUMER_TOKEN_AUDIENCE);
    expect(config.ttlSeconds).toBe(900);
  });

  it('honours explicit deployment issuer, audience and shorter TTL', () => {
    const config = resolveConsumerTokenConfig({
      environment: 'sandbox',
      issuer: 'https://auth.rugbychampagne.example',
      audience: 'rugbychampagne-web',
      ttlSeconds: '300',
    });

    expect(config).toEqual({
      issuer: 'https://auth.rugbychampagne.example',
      audience: 'rugbychampagne-web',
      ttlSeconds: 300,
    });
  });

  it('accepts the lower TTL bound of one second', () => {
    const config = resolveConsumerTokenConfig({ environment: 'local', ttlSeconds: '1' });

    expect(config.ttlSeconds).toBe(1);
  });

  it('trims surrounding whitespace from configured values', () => {
    const config = resolveConsumerTokenConfig({
      environment: 'sandbox',
      issuer: '  https://auth.example  ',
      audience: '  consumer  ',
      ttlSeconds: ' 60 ',
    });

    expect(config).toEqual({
      issuer: 'https://auth.example',
      audience: 'consumer',
      ttlSeconds: 60,
    });
  });

  it('fails closed when sandbox or production issuer/audience fall back to local defaults', () => {
    expect(() => resolveConsumerTokenConfig({ environment: 'sandbox' })).toThrow(/AUTH_JWT_ISSUER/);
    expect(() =>
      resolveConsumerTokenConfig({
        environment: 'production',
        issuer: 'https://auth.example',
      }),
    ).toThrow(/AUTH_READER_STATE_AUDIENCE/);
    expect(() =>
      resolveConsumerTokenConfig({
        environment: 'production',
        audience: 'consumer',
      }),
    ).toThrow(/AUTH_JWT_ISSUER/);
  });

  it('falls back to the default lifetime when the TTL slot is explicitly unset', () => {
    expect(resolveConsumerTokenConfig({ environment: 'local', ttlSeconds: '' }).ttlSeconds).toBe(
      900,
    );
    expect(resolveConsumerTokenConfig({ environment: 'local', ttlSeconds: '   ' }).ttlSeconds).toBe(
      900,
    );
  });

  it('rejects malformed TTL values instead of minting with an unintended lifetime', () => {
    for (const ttlSeconds of ['0', '-5', '901', '900.5', 'fifteen', '1e2', '0x10', '+60']) {
      expect(() => resolveConsumerTokenConfig({ environment: 'local', ttlSeconds })).toThrow(
        /AUTH_READER_STATE_TTL_SECONDS/,
      );
    }
  });

  it('rejects blank or unbounded issuer/audience values', () => {
    expect(() =>
      resolveConsumerTokenConfig({ environment: 'sandbox', issuer: '   ', audience: 'ok' }),
    ).toThrow(/AUTH_JWT_ISSUER/);
    expect(() =>
      resolveConsumerTokenConfig({ environment: 'sandbox', issuer: 'ok', audience: '' }),
    ).toThrow(/AUTH_READER_STATE_AUDIENCE/);
    expect(() =>
      resolveConsumerTokenConfig({
        environment: 'local',
        issuer: 'has space.example',
        audience: 'ok',
      }),
    ).toThrow(/AUTH_JWT_ISSUER/);
  });

  it('never echoes configured values in validation errors', () => {
    let message = '';
    try {
      resolveConsumerTokenConfig({
        environment: 'local',
        issuer: 'not-an-issuer super-secret-marker',
        ttlSeconds: 'evil-marker',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain('super-secret-marker');
    expect(message).not.toContain('evil-marker');
  });
});

describe('capReaderStateExpirySeconds', () => {
  it('uses the TTL when the session outlives it', () => {
    expect(
      capTokenExpirySeconds({ nowSeconds: 1000, ttlSeconds: 900, sessionExpirySeconds: 2000 }),
    ).toBe(1900);
  });

  it('caps at the session expiry when the session is shorter than the TTL', () => {
    expect(
      capTokenExpirySeconds({ nowSeconds: 1000, ttlSeconds: 900, sessionExpirySeconds: 1060 }),
    ).toBe(1060);
  });

  it('never extends past an already-expired session', () => {
    expect(
      capTokenExpirySeconds({ nowSeconds: 1000, ttlSeconds: 900, sessionExpirySeconds: 900 }),
    ).toBe(900);
  });
});

describe('extractTokenExpiry', () => {
  function encodeSegment(value: unknown): string {
    return Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function craftedToken(exp: unknown): string {
    return `${encodeSegment({ alg: 'EdDSA' })}.${encodeSegment({ exp })}.signature`;
  }

  it('reads the integer exp claim from a compact token', () => {
    expect(extractTokenExpiry(craftedToken(1790000900))).toBe(1790000900);
  });

  it('returns null for malformed tokens and non-integer exp claims', () => {
    expect(extractTokenExpiry('not-a-token')).toBeNull();
    expect(extractTokenExpiry('a.b')).toBeNull();
    expect(extractTokenExpiry(craftedToken('tomorrow'))).toBeNull();
    expect(extractTokenExpiry(craftedToken(1790000900.5))).toBeNull();
    expect(extractTokenExpiry(craftedToken(0))).toBeNull();
    expect(extractTokenExpiry(craftedToken(-10))).toBeNull();
    expect(extractTokenExpiry(`${encodeSegment({ alg: 'none' })}.!!!.signature`)).toBeNull();
  });
});
