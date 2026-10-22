// Application-owned Reader State configuration (spec #195, ADR-0013).
// Issuer, audience and token lifetime resolve from the effective non-secret
// configuration; malformed values fail closed and sandbox/production never
// fall back to local defaults. Secrets never enter this boundary.
export const MAX_READER_STATE_TTL_SECONDS = 900;

export const DEFAULT_READER_STATE_TTL_SECONDS = 900;

// Deterministic local-only issuer/audience defaults. These constants are the
// only fallback and apply exclusively to local/test contexts; they are never
// derived from request or forwarded hosts.
export const LOCAL_READER_STATE_ISSUER = 'https://local.user-service.internal';

export const LOCAL_READER_STATE_AUDIENCE = 'user-service-local-reader-state';

const MAX_CLAIM_VALUE_LENGTH = 256;

export interface ReaderStateConfigInput {
  readonly environment?: string;
  readonly issuer?: string;
  readonly audience?: string;
  readonly ttlSeconds?: string;
}

export interface ReaderStateConfig {
  readonly issuer: string;
  readonly audience: string;
  // Bounded token lifetime in seconds (1..900). The minted `exp` additionally
  // never exceeds the authoritative renewal-session expiry.
  readonly ttlSeconds: number;
}

function isProductionLike(environment: string): boolean {
  const normalized = environment.trim().toLowerCase();
  return normalized === 'sandbox' || normalized === 'staging' || normalized === 'production';
}

// Parses a configured claim value (`parseDontValidate`: returns the refined
// value instead of check-and-forget). Values are trimmed; blank means unset.
// Non-blank values must be bounded printable identifiers without whitespace
// so they can never carry header-breaking characters. Failures name only the
// variable and the expected shape, never the supplied value.
function parseClaimValue(name: string, value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (trimmed.length > MAX_CLAIM_VALUE_LENGTH || /\s/.test(trimmed) || hasControlChar(trimmed)) {
    throw new Error(
      `Configuration error: ${name} must be a bounded identifier without whitespace.`,
    );
  }
  return trimmed;
}

// Detects C0 control characters and DEL by code-unit comparison, without
// control-escape regular expressions. Visible whitespace (including space)
// is covered by the `\s` check at the call site; this loop covers the
// non-whitespace controls.
function hasControlChar(value: string): boolean {
  for (const char of value) {
    if (char < ' ' || char === '\u007f') {
      return true;
    }
  }
  return false;
}

// Parses the configured TTL seconds. An explicitly unset slot selects the
// default; otherwise only canonical decimal integers within 1..900 are
// accepted so a typo can never mint longer-lived tokens than approved.
function parseTtlSeconds(value: string | undefined): number {
  const trimmed = (value ?? '').trim();
  if (trimmed.length === 0) {
    return DEFAULT_READER_STATE_TTL_SECONDS;
  }
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      'Configuration error: AUTH_READER_STATE_TTL_SECONDS must be an integer number of seconds within 1..900.',
    );
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_READER_STATE_TTL_SECONDS) {
    throw new Error(
      'Configuration error: AUTH_READER_STATE_TTL_SECONDS must be an integer number of seconds within 1..900.',
    );
  }
  return parsed;
}

// Resolves Reader State configuration from effective non-secret values.
// Local/test contexts fall back to deterministic local-only defaults;
// sandbox/production fail closed without explicit stable deployment values.
export function resolveReaderStateConfig(input: ReaderStateConfigInput): ReaderStateConfig {
  const environment = (input.environment ?? 'local').trim().toLowerCase();
  const productionLike = isProductionLike(environment);

  const issuer = parseClaimValue('AUTH_JWT_ISSUER', input.issuer) ?? null;
  const audience = parseClaimValue('AUTH_READER_STATE_AUDIENCE', input.audience) ?? null;

  if (issuer === null && productionLike) {
    throw new Error(
      'Configuration error: AUTH_JWT_ISSUER must be an explicit stable deployment value in sandbox/production.',
    );
  }
  if (audience === null && productionLike) {
    throw new Error(
      'Configuration error: AUTH_READER_STATE_AUDIENCE must be an explicit stable deployment value in sandbox/production.',
    );
  }

  return {
    issuer: issuer ?? LOCAL_READER_STATE_ISSUER,
    audience: audience ?? LOCAL_READER_STATE_AUDIENCE,
    ttlSeconds: parseTtlSeconds(input.ttlSeconds),
  };
}

// Reads the integer `exp` claim from a compact JWS without verifying it.
// Used only to report the expiry of a token this service just minted in the
// issuance response; verification of received tokens always goes through the
// public JWKS. Returns null for malformed tokens or non-integer exp claims.
export function extractReaderStateExpiry(readerState: string): number | null {
  const parts = readerState.split('.');
  if (parts.length !== 3) {
    return null;
  }
  const encoded = parts[1];
  if (encoded === undefined || encoded.length === 0) {
    return null;
  }
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded))) as Record<
      string,
      unknown
    >;
    const exp = payload.exp;
    if (typeof exp !== 'number' || !Number.isInteger(exp) || exp <= 0) {
      return null;
    }
    return exp;
  } catch {
    return null;
  }
}

function decodeBase64Url(segment: string): Uint8Array {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface CapReaderStateExpiryInput {
  readonly nowSeconds: number;
  readonly ttlSeconds: number;
  // Authoritative renewal-session expiry as integer Unix seconds.
  readonly sessionExpirySeconds: number;
}

// Caps the minted token expiry at the live renewal-session expiry so a
// token can never outlive the session it was renewed from. With the pinned
// engine's sliding sessions a live session normally outlives the token; this
// cap is the backstop for short-lived or non-sliding session configurations.
export function capReaderStateExpirySeconds(input: CapReaderStateExpiryInput): number {
  return Math.min(input.nowSeconds + input.ttlSeconds, input.sessionExpirySeconds);
}
