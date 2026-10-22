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

export interface VerifyReaderStateInput {
  readonly issuer: string;
  readonly audience: string;
  readonly nowSeconds?: number;
  readonly clockToleranceSeconds?: number;
}

export interface VerifiedReaderState {
  readonly subject: string;
  readonly issuer: string;
  readonly audience: string;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly entitlements: readonly [];
}

export type VerifyReaderStateErrorCode =
  | 'malformed-reader-state'
  | 'unsupported-algorithm'
  | 'unknown-key'
  | 'invalid-signature'
  | 'invalid-issuer'
  | 'invalid-audience'
  | 'reader-state-expired'
  | 'invalid-issued-at'
  | 'invalid-subject'
  | 'forbidden-claim'
  | 'invalid-entitlements';

export class ReaderStateError extends Error {
  readonly code: VerifyReaderStateErrorCode;

  constructor(code: VerifyReaderStateErrorCode, message: string) {
    super(message);
    this.name = 'ReaderStateError';
    this.code = code;
  }
}

const ALLOWED_CLAIMS = new Set(['sub', 'iss', 'aud', 'iat', 'exp', 'entitlements']);

function decodeSegment(segment: string): unknown {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null;
}

function fail(code: VerifyReaderStateErrorCode, message: string): never {
  throw new ReaderStateError(code, message);
}

export function readReaderStateKid(readerState: string): string | null {
  try {
    const segment = readerState.split('.')[0];
    if (segment === undefined || segment === '') return null;
    const kid = asRecord(decodeSegment(segment))?.kid;
    return typeof kid === 'string' && kid !== '' ? kid : null;
  } catch {
    return null;
  }
}

export async function verifyReaderState(
  readerState: string,
  keys: readonly ConsumerJsonWebKey[],
  input: VerifyReaderStateInput,
): Promise<VerifiedReaderState> {
  const parts = readerState.split('.');
  const [headerSegment, payloadSegment, signatureSegment] = parts;
  if (
    parts.length !== 3 ||
    headerSegment === undefined ||
    payloadSegment === undefined ||
    signatureSegment === undefined ||
    headerSegment === '' ||
    payloadSegment === '' ||
    signatureSegment === ''
  ) {
    fail('malformed-reader-state', 'Rejected malformed Reader State.');
  }
  let header: Record<string, unknown> | null;
  let payload: Record<string, unknown> | null;
  try {
    header = asRecord(decodeSegment(headerSegment));
    payload = asRecord(decodeSegment(payloadSegment));
  } catch {
    fail('malformed-reader-state', 'Rejected malformed Reader State.');
  }
  if (header === null || payload === null) {
    fail('malformed-reader-state', 'Rejected malformed Reader State.');
  }
  if (header.alg !== 'EdDSA') fail('unsupported-algorithm', 'Rejected unexpected algorithm.');
  const kid = header.kid;
  if (typeof kid !== 'string' || kid === '') fail('unknown-key', 'Rejected unknown key.');
  const key = keys.find((candidate) => candidate.kid === kid);
  if (key === undefined) fail('unknown-key', 'Rejected unknown key.');
  const publicKey = await crypto.subtle
    .importKey('jwk', key as unknown as { kty: string }, { name: 'Ed25519' }, false, ['verify'])
    .catch(() => null);
  if (publicKey === null) fail('unknown-key', 'Rejected unknown key.');
  let signature: Uint8Array;
  try {
    const binary = atob(signatureSegment.replace(/-/g, '+').replace(/_/g, '/'));
    signature = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    fail('malformed-reader-state', 'Rejected malformed Reader State.');
  }
  const authentic = await crypto.subtle.verify(
    { name: 'Ed25519' },
    publicKey,
    signature,
    new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
  );
  if (!authentic) fail('invalid-signature', 'Rejected invalid signature.');
  if (payload.iss !== input.issuer) fail('invalid-issuer', 'Rejected unexpected issuer.');
  if (payload.aud !== input.audience) fail('invalid-audience', 'Rejected unexpected audience.');
  for (const claim of Object.keys(payload)) {
    if (!ALLOWED_CLAIMS.has(claim)) fail('forbidden-claim', `Rejected forbidden claim ${claim}.`);
  }
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  const tolerance = input.clockToleranceSeconds ?? 0;
  const issuedAt = payload.iat;
  const expiresAt = payload.exp;
  if (typeof issuedAt !== 'number' || !Number.isInteger(issuedAt) || issuedAt > now + tolerance) {
    fail('invalid-issued-at', 'Rejected invalid issued-at time.');
  }
  if (
    typeof expiresAt !== 'number' ||
    !Number.isInteger(expiresAt) ||
    expiresAt <= now - tolerance ||
    expiresAt <= issuedAt
  ) {
    fail('reader-state-expired', 'Rejected expired Reader State.');
  }
  const subject = payload.sub;
  if (typeof subject !== 'string' || subject === '') fail('invalid-subject', 'Rejected subject.');
  if (!Array.isArray(payload.entitlements) || payload.entitlements.length !== 0) {
    fail('invalid-entitlements', 'Rejected unexpected Entitlements.');
  }
  return {
    subject,
    issuer: input.issuer,
    audience: input.audience,
    issuedAt,
    expiresAt,
    entitlements: [],
  };
}
