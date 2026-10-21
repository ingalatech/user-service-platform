// Explicit Origin/Fetch Metadata protection for cookie-auth mutation
// operations (spec #150, ADR-0013). Application-owned wrappers call
// `auth.api` directly, so engine-router CSRF middleware cannot be assumed to
// apply. This boundary accepts legitimate same-origin requests plus exact
// deployment-owned origins — the gateway-origin set and the direct-browser
// consumer-origin set (spec #164) — rejects hostile/null origins and
// inconsistent cross-site metadata, and preserves documented headerless
// non-browser flows (curl, tests, server-to-server gateways). No wildcard
// CORS or arbitrary forwarded-origin trust: only the request origin and exact
// deployment-owned origins are ever accepted.
export interface CookieMutationOriginInput {
  // The service origin derived from the request URL (never a forwarded host).
  readonly requestOrigin: string;
  // Raw `Origin` request header value, or null when absent.
  readonly origin: string | null;
  // Raw `Sec-Fetch-Site` request header value, or null when absent.
  readonly secFetchSite: string | null;
  // Exact deployment-owned gateway origins (empty means same-origin only).
  readonly gatewayOrigins: readonly string[];
  // Exact deployment-owned direct-browser consumer origins (spec #164,
  // ADR-0013). Distinct configuration from the gateway set so an operator can
  // migrate transports without silently changing one into the other, but both
  // are exact-match grants. Absent means none.
  readonly consumerOrigins?: readonly string[];
}

// Parses a comma-separated exact-origin configuration slot. Each entry must
// be an absolute http(s) origin without credentials, path, query or fragment;
// wildcards and reflected values are rejected. Failures name only the
// variable and the expected shape, never the supplied value.
function parseExactOrigins(varName: string, raw: string | undefined): string[] {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return [];
  }
  const origins = trimmed
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (origins.length === 0) {
    return [];
  }
  for (const origin of origins) {
    if (!isExactHttpOrigin(origin)) {
      throw new Error(
        `Configuration error: ${varName} must be a comma-separated list of exact http(s) origins without credentials, paths or wildcards.`,
      );
    }
  }
  return origins;
}

// Parses the exact gateway-origin slot (same-origin API gateway transport).
export function resolveGatewayOrigins(raw: string | undefined): string[] {
  return parseExactOrigins('AUTH_GATEWAY_ORIGINS', raw);
}

// Parses the exact direct-browser consumer-origin slot (spec #164,
// ADR-0013). The parser is deliberately identical to the gateway slot: only
// exact absolute http(s) origins survive, so wildcards, `null` and arbitrary
// reflection can never be granted.
export function resolveConsumerOrigins(raw: string | undefined): string[] {
  return parseExactOrigins('AUTH_CONSUMER_ORIGINS', raw);
}

function isExactHttpOrigin(value: string): boolean {
  // Wildcards are never exact origins.
  if (value.includes('*')) {
    return false;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false;
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    return false;
  }
  if (parsed.pathname !== '/' || parsed.search.length > 0 || parsed.hash.length > 0) {
    return false;
  }
  // Re-serialization must round-trip exactly: no trailing slashes, default
  // ports, case folding or other normalization surprises.
  return parsed.origin === value;
}

// Evaluates one cookie-auth mutation request. An explicit `Origin` header
// must match the request origin or an exact configured gateway origin;
// a present `Sec-Fetch-Site`, when present, is still validated even when the
// origin matches: unknown values always fail closed, and a service-origin
// request claiming cross-site metadata is contradictory and rejected.
// Configured gateway origins keep their exact-match semantics with any known
// fetch-metadata value. Requests with neither header are headerless
// non-browser flows and are accepted.
export function evaluateCookieMutationOrigin(input: CookieMutationOriginInput): boolean {
  const allowed = new Set<string>([
    input.requestOrigin,
    ...input.gatewayOrigins,
    ...(input.consumerOrigins ?? []),
  ]);
  if (input.origin !== null && input.origin.trim().length > 0) {
    const origin = input.origin.trim();
    if (!allowed.has(origin)) {
      return false;
    }
    if (input.secFetchSite !== null && input.secFetchSite.trim().length > 0) {
      const site = input.secFetchSite.trim().toLowerCase();
      if (
        site !== 'same-origin' &&
        site !== 'same-site' &&
        site !== 'none' &&
        site !== 'cross-site'
      ) {
        return false;
      }
      if (origin === input.requestOrigin && site === 'cross-site') {
        return false;
      }
    }
    return true;
  }
  if (input.secFetchSite !== null && input.secFetchSite.trim().length > 0) {
    const site = input.secFetchSite.trim().toLowerCase();
    if (site === 'same-origin' || site === 'same-site' || site === 'none') {
      return true;
    }
    return false;
  }
  return true;
}
