import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READER_STATE_TTL_SECONDS,
  LOCAL_READER_STATE_AUDIENCE,
  LOCAL_READER_STATE_ISSUER,
  MAX_READER_STATE_TTL_SECONDS,
  capReaderStateExpirySeconds,
  extractReaderStateExpiry,
  resolveReaderStateConfig,
} from './reader-state.js';

// Seam under test: the pure application-owned Reader State configuration
// boundary (spec #195, ADR-0013). Issuer, audience and lifetime resolve from
// the effective non-secret configuration; malformed values fail closed and
// sandbox/production never fall back to local defaults. No runtime, database
// or auth engine is involved.
describe('resolveReaderStateConfig', () => {
  it('uses deterministic local-only defaults when nothing is configured', () => {
    const config = resolveReaderStateConfig({ environment: 'local' });

    expect(config.issuer).toBe(LOCAL_READER_STATE_ISSUER);
    expect(config.audience).toBe(LOCAL_READER_STATE_AUDIENCE);
    expect(config.ttlSeconds).toBe(DEFAULT_READER_STATE_TTL_SECONDS);
    expect(DEFAULT_READER_STATE_TTL_SECONDS).toBe(900);
    expect(MAX_READER_STATE_TTL_SECONDS).toBe(900);
  });

  it('uses deterministic local-only defaults in the isolated test context', () => {
    const config = resolveReaderStateConfig({ environment: 'test' });

    expect(config.issuer).toBe(LOCAL_READER_STATE_ISSUER);
    expect(config.audience).toBe(LOCAL_READER_STATE_AUDIENCE);
    expect(config.ttlSeconds).toBe(900);
  });

  it('honours explicit deployment issuer, audience and shorter TTL', () => {
    const config = resolveReaderStateConfig({
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
    const config = resolveReaderStateConfig({ environment: 'local', ttlSeconds: '1' });

    expect(config.ttlSeconds).toBe(1);
  });

  it('trims surrounding whitespace from configured values', () => {
    const config = resolveReaderStateConfig({
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
    expect(() => resolveReaderStateConfig({ environment: 'sandbox' })).toThrow(/AUTH_JWT_ISSUER/);
    expect(() =>
      resolveReaderStateConfig({
        environment: 'production',
        issuer: 'https://auth.example',
      }),
    ).toThrow(/AUTH_READER_STATE_AUDIENCE/);
    expect(() =>
      resolveReaderStateConfig({
        environment: 'production',
        audience: 'consumer',
      }),
    ).toThrow(/AUTH_JWT_ISSUER/);
  });

  it('falls back to the default lifetime when the TTL slot is explicitly unset', () => {
    expect(resolveReaderStateConfig({ environment: 'local', ttlSeconds: '' }).ttlSeconds).toBe(900);
    expect(resolveReaderStateConfig({ environment: 'local', ttlSeconds: '   ' }).ttlSeconds).toBe(
      900,
    );
  });

  it('rejects malformed TTL values instead of minting with an unintended lifetime', () => {
    for (const ttlSeconds of ['0', '-5', '901', '900.5', 'fifteen', '1e2', '0x10', '+60']) {
      expect(() => resolveReaderStateConfig({ environment: 'local', ttlSeconds })).toThrow(
        /AUTH_READER_STATE_TTL_SECONDS/,
      );
    }
  });

  it('rejects blank or unbounded issuer/audience values', () => {
    expect(() =>
      resolveReaderStateConfig({ environment: 'sandbox', issuer: '   ', audience: 'ok' }),
    ).toThrow(/AUTH_JWT_ISSUER/);
    expect(() =>
      resolveReaderStateConfig({ environment: 'sandbox', issuer: 'ok', audience: '' }),
    ).toThrow(/AUTH_READER_STATE_AUDIENCE/);
    expect(() =>
      resolveReaderStateConfig({
        environment: 'local',
        issuer: 'has space.example',
        audience: 'ok',
      }),
    ).toThrow(/AUTH_JWT_ISSUER/);
  });

  it('never echoes configured values in validation errors', () => {
    let message = '';
    try {
      resolveReaderStateConfig({
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
      capReaderStateExpirySeconds({
        nowSeconds: 1000,
        ttlSeconds: 900,
        sessionExpirySeconds: 2000,
      }),
    ).toBe(1900);
  });

  it('caps at the session expiry when the session is shorter than the TTL', () => {
    expect(
      capReaderStateExpirySeconds({
        nowSeconds: 1000,
        ttlSeconds: 900,
        sessionExpirySeconds: 1060,
      }),
    ).toBe(1060);
  });

  it('never extends past an already-expired session', () => {
    expect(
      capReaderStateExpirySeconds({
        nowSeconds: 1000,
        ttlSeconds: 900,
        sessionExpirySeconds: 900,
      }),
    ).toBe(900);
  });
});

describe('extractReaderStateExpiry', () => {
  function encodeSegment(value: unknown): string {
    return Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  function craftedReaderState(exp: unknown): string {
    return `${encodeSegment({ alg: 'EdDSA' })}.${encodeSegment({ exp })}.signature`;
  }

  it('reads the integer exp claim from compact Reader State', () => {
    expect(extractReaderStateExpiry(craftedReaderState(1790000900))).toBe(1790000900);
  });

  it('returns null for malformed Reader State and non-integer exp claims', () => {
    expect(extractReaderStateExpiry('not-a-reader-state')).toBeNull();
    expect(extractReaderStateExpiry('a.b')).toBeNull();
    expect(extractReaderStateExpiry(craftedReaderState('tomorrow'))).toBeNull();
    expect(extractReaderStateExpiry(craftedReaderState(1790000900.5))).toBeNull();
    expect(extractReaderStateExpiry(craftedReaderState(0))).toBeNull();
    expect(extractReaderStateExpiry(craftedReaderState(-10))).toBeNull();
    expect(extractReaderStateExpiry(`${encodeSegment({ alg: 'none' })}.!!!.signature`)).toBeNull();
  });
});
