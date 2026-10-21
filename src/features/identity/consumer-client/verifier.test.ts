import { beforeAll, describe, expect, it } from 'vitest';
import { verifyConsumerToken, type ConsumerJsonWebKey } from './verifier.js';

// Seam under test (spec #150, ADR-0013, ticket #152): the application-owned
// consumer JWT verifier. These tests prove signature, algorithm, issuer,
// audience, integer time bounds and the explicit claims allowlist against
// real Ed25519 cryptography — the same checks the shipped browser client and
// the documented backend verifier apply before accepting persisted
// credentials. Browser decisions are UI snapshots only; receiving APIs
// authorize independently.
const ISSUER = 'https://auth.test';
const AUDIENCE = 'test-audience';
const NOW = 1_700_000_000;

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

interface KeyMaterial {
  readonly kid: string;
  readonly publicJwk: ConsumerJsonWebKey;
  // `InstanceType<typeof CryptoKey>` names the WebCrypto key type without a
  // DOM lib type (see verifier.ts).
  readonly privateKey: InstanceType<typeof CryptoKey>;
}

async function generateKey(kid: string): Promise<KeyMaterial> {
  const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify',
  ])) as unknown as {
    readonly publicKey: InstanceType<typeof CryptoKey>;
    readonly privateKey: InstanceType<typeof CryptoKey>;
  };
  const publicJwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<
    string,
    unknown
  >;
  return {
    kid,
    publicJwk: {
      kid,
      kty: 'OKP',
      alg: 'EdDSA',
      crv: 'Ed25519',
      x: publicJwk.x as string,
    },
    privateKey: pair.privateKey,
  };
}

async function mintToken(input: {
  key: KeyMaterial;
  alg?: string;
  kid?: string;
  payload: Record<string, unknown>;
}): Promise<string> {
  const header = { alg: input.alg ?? 'EdDSA', kid: input.kid ?? input.key.kid, typ: 'JWT' };
  const headerSegment = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
  const payloadSegment = base64UrlEncode(new TextEncoder().encode(JSON.stringify(input.payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'Ed25519' },
      input.key.privateKey,
      new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
    ),
  );
  return `${headerSegment}.${payloadSegment}.${base64UrlEncode(signature)}`;
}

function validPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sub: 'user-1',
    iss: ISSUER,
    aud: AUDIENCE,
    iat: NOW - 10,
    exp: NOW + 890,
    entitlements: [],
    ...overrides,
  };
}

let primary: KeyMaterial;
let other: KeyMaterial;

beforeAll(async () => {
  primary = await generateKey('primary-key');
  other = await generateKey('other-key');
});

describe('verifyConsumerToken', () => {
  it('accepts a correctly signed token with the expected claims', async () => {
    const token = await mintToken({ key: primary, payload: validPayload() });

    const snapshot = await verifyConsumerToken(token, [primary.publicJwk], {
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    });

    expect(snapshot).toEqual({
      subject: 'user-1',
      issuer: ISSUER,
      audience: AUDIENCE,
      issuedAt: NOW - 10,
      expiresAt: NOW + 890,
      entitlements: [],
    });
  });

  it('rejects a token signed by an unknown key', async () => {
    const token = await mintToken({ key: other, payload: validPayload() });

    await expect(
      verifyConsumerToken(token, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'unknown-key' });
  });

  it('rejects a tampered signature', async () => {
    const token = await mintToken({ key: primary, payload: validPayload() });
    const segments = token.split('.');
    const header = segments[0] ?? '';
    const payload = segments[1] ?? '';
    const signature = segments[2] ?? '';
    expect(header.length).toBeGreaterThan(0);
    expect(payload.length).toBeGreaterThan(0);
    expect(signature.length).toBeGreaterThan(0);
    const flipped = `${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
    const tampered = `${header}.${payload}.${flipped}`;

    await expect(
      verifyConsumerToken(tampered, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid-signature' });
  });

  it('rejects an unexpected algorithm before signature evaluation', async () => {
    const token = await mintToken({
      key: primary,
      alg: 'HS256',
      payload: validPayload(),
    });

    await expect(
      verifyConsumerToken(token, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'unsupported-algorithm' });
  });

  it('rejects wrong issuer and audience', async () => {
    const token = await mintToken({ key: primary, payload: validPayload() });

    await expect(
      verifyConsumerToken(token, [primary.publicJwk], {
        issuer: 'https://wrong.example',
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid-issuer' });
    await expect(
      verifyConsumerToken(token, [primary.publicJwk], {
        issuer: ISSUER,
        audience: 'wrong-audience',
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid-audience' });
  });

  it('rejects expired tokens and far-future issued-at values', async () => {
    const expired = await mintToken({
      key: primary,
      payload: validPayload({ exp: NOW - 61 }),
    });
    await expect(
      verifyConsumerToken(expired, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'token-expired' });

    const futureIat = await mintToken({
      key: primary,
      payload: validPayload({ iat: NOW + 500 }),
    });
    await expect(
      verifyConsumerToken(futureIat, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid-issued-at' });
  });

  it('rejects non-integer time bounds', async () => {
    const fractional = await mintToken({
      key: primary,
      payload: validPayload({ exp: NOW + 12.5 }),
    });
    await expect(
      verifyConsumerToken(fractional, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'token-expired' });
  });

  it('rejects forbidden claims and nonempty entitlements without faking rights', async () => {
    const withEmail = await mintToken({
      key: primary,
      payload: validPayload({ email: 'ada@example.com' }),
    });
    await expect(
      verifyConsumerToken(withEmail, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'forbidden-claim' });

    const withRights = await mintToken({
      key: primary,
      payload: validPayload({ entitlements: [{ kind: 'premium' }] }),
    });
    await expect(
      verifyConsumerToken(withRights, [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'invalid-entitlements' });
  });

  it('rejects malformed tokens without reaching verification', async () => {
    await expect(
      verifyConsumerToken('not-a-token', [primary.publicJwk], {
        issuer: ISSUER,
        audience: AUDIENCE,
        nowSeconds: NOW,
      }),
    ).rejects.toMatchObject({ code: 'malformed-token' });
  });

  it('never exposes the raw token in the rejection', async () => {
    const token = await mintToken({ key: other, payload: validPayload() });
    const failure = await verifyConsumerToken(token, [primary.publicJwk], {
      issuer: ISSUER,
      audience: AUDIENCE,
      nowSeconds: NOW,
    }).catch((error: unknown) => error);

    expect(JSON.stringify(failure)).not.toContain(token);
  });
});
