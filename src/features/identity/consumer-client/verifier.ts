// Application-owned consumer JWT verifier (spec #150, ADR-0013, ticket #152).
//
// The shipped browser client and the documented backend verifier share these
// checks: fixed asymmetric algorithm, stable key id, signature against the
// cached public JWKS, expected issuer/audience, integer issue/expiry bounds
// and the explicit claims allowlist. Verified output is a UI snapshot only —
// a decoded payload or browser result is never authorization for a receiving
// API, which verifies independently. Empty entitlements grant no
// premium/statistics right; nonempty rights are rejected here rather than
// faked, and remain blocked on future billing integration.
export interface ConsumerJsonWebKey {
  readonly kid: string;
  readonly kty: string;
  readonly alg: string;
  readonly use?: string;
  readonly crv?: string;
  readonly x?: string;
  readonly y?: string;
  readonly n?: string;
  readonly e?: string;
}

export interface VerifyConsumerTokenInput {
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds?: number;
  readonly clockToleranceSeconds?: number;
}

export interface VerifiedConsumerSnapshot {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entitlements: readonly [];
}

export type VerifyConsumerTokenErrorCode =
  | 'malformed-token'
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'invalid-signature'
  | 'invalid-issuer'
  | 'invalid-audience'
  | 'token-expired'
  | 'invalid-issued-at'
  | 'invalid-subject'
  | 'forbidden-claim'
  | 'invalid-entitlements';

export class ConsumerTokenError extends Error {
  readonly code: VerifyConsumerTokenErrorCode;

  constructor(code: VerifyConsumerTokenErrorCode, message: string) {
    super(message);
    this.name = 'ConsumerTokenError';
    this.code = code;
  }
}

// Documented clock tolerance for receiving verifiers (see
// docs/operations/consumer-tokens.md): small skew between the issuer and the
// verifier clocks must not invalidate an otherwise valid snapshot.
const DEFAULT_CLOCK_TOLERANCE_SECONDS = 60;

// Claims that must never appear in an application-owned consumer token. They
// would leak engine internals, session material or provider identifiers into
// a bearer snapshot.
const FORBIDDEN_CLAIMS = ['email', 'role', 'sessionId', 'sessionToken', 'password', 'providerId'];

function decodeSegment(segment: string): unknown {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function fail(code: VerifyConsumerTokenErrorCode, message: string): never {
  throw new ConsumerTokenError(code, message);
}

// Reads the key id from a compact JWS header without verifying anything.
// Used only to select the cached verification key; the result never
// authorizes anything on its own.
export function readTokenKid(token: string): string | null {
  try {
    const segment = token.split('.')[0];
    if (segment === undefined || segment.length === 0) {
      return null;
    }
    const header = asRecord(decodeSegment(segment));
    const kid = header?.kid;
    return typeof kid === 'string' && kid.length > 0 ? kid : null;
  } catch {
    return null;
  }
}

export async function verifyConsumerToken(
  token: string,
  keys: readonly ConsumerJsonWebKey[],
  input: VerifyConsumerTokenInput,
): Promise<VerifiedConsumerSnapshot> {
  const parts = token.split('.');
  const headerSegment = parts[0];
  const payloadSegment = parts[1];
  const signatureSegment = parts[2];
  if (
    parts.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    headerSegment.length === 0 ||
    payloadSegment.length === 0 ||
    signatureSegment.length === 0
  ) {
    fail('malformed-token', 'Rejected: malformed token.');
  }

  let header: Record<string, unknown> | null = null;
  let payload: Record<string, unknown> | null = null;
  try {
    header = asRecord(decodeSegment(headerSegment));
    payload = asRecord(decodeSegment(payloadSegment));
  } catch {
    fail('malformed-token', 'Rejected: malformed token.');
  }
  if (header === null || payload === null) {
    fail('malformed-token', 'Rejected: malformed token.');
  }

  // The algorithm is pinned before any key lookup or signature work so a
  // header pinning a different algorithm is rejected even with a valid kid.
  if (header.alg !== 'EdDSA') {
    fail('unsupported-algorithm', 'Rejected: unexpected algorithm.');
  }
  const kid = header.kid;
  if (typeof kid !== 'string' || kid.length === 0) {
    fail('unknown-key', 'Rejected: unknown key id.');
  }
  const key = keys.find((entry) => entry.kid === kid);
  if (key === undefined) {
    fail('unknown-key', 'Rejected: unknown key id.');
  }

  // `InstanceType<typeof CryptoKey>` names the WebCrypto key type without
  // relying on a DOM lib type: the repository compiles without DOM globals.
  const publicKey = await crypto.subtle
    .importKey('jwk', key as unknown as { kty: string }, { name: 'Ed25519' }, false, ['verify'])
    .catch(() => null);
  if (publicKey === null) {
    fail('unknown-key', 'Rejected: unknown key id.');
  }

  const signingInput = new TextEncoder().encode(`${headerSegment}.${payloadSegment}`);
  let signature: Uint8Array;
  try {
    const padded = signatureSegment.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(padded);
    signature = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      signature[index] = binary.charCodeAt(index);
    }
  } catch {
    fail('malformed-token', 'Rejected: malformed token.');
  }
  const authentic = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    signingInput,
  );
  if (!authentic) {
    fail('invalid-signature', 'Rejected: invalid signature.');
  }

  if (payload.iss !== input.issuer) {
    fail('invalid-issuer', 'Rejected: unexpected issuer.');
  }
  if (payload.aud !== input.audience) {
    fail('invalid-audience', 'Rejected: unexpected audience.');
  }

  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.clockToleranceSeconds ?? DEFAULT_CLOCK_TOLERANCE_SECONDS;
  const exp = payload.exp;
  if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= nowSeconds - tolerance) {
    fail('token-expired', 'Rejected: expired or missing exp.');
  }
  const iat = payload.iat;
  if (typeof iat !== 'number' || !Number.isInteger(iat) || iat > nowSeconds + tolerance) {
    fail('invalid-issued-at', 'Rejected: invalid iat.');
  }
  if (exp <= iat) {
    fail('token-expired', 'Rejected: expired or missing exp.');
  }
  const sub = payload.sub;
  if (typeof sub !== 'string' || sub.length === 0) {
    fail('invalid-subject', 'Rejected: missing sub.');
  }
  for (const forbidden of FORBIDDEN_CLAIMS) {
    if (forbidden in payload) {
      fail('forbidden-claim', `Rejected: forbidden claim ${forbidden}.`);
    }
  }
  // This increment emits no paid rights: only the empty Entitlement list is
  // acceptable. Nonempty entries are rejected rather than interpreted, so no
  // premium or statistics right can be faked from browser state.
  const entitlements = payload.entitlements;
  if (!Array.isArray(entitlements) || entitlements.length !== 0) {
    fail('invalid-entitlements', 'Rejected: unexpected entitlements.');
  }

  return {
    subject: sub,
    issuer: input.issuer,
    audience: input.audience,
    issuedAt: iat,
    expiresAt: exp,
    entitlements: [],
  };
}
