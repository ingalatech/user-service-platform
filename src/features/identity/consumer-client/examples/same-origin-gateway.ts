// Same-origin gateway forwarding for consumer browsers (spec #150, ADR-0013,
// ticket #152). The consumer team owns the gateway: the browser talks to the
// consumer origin, which forwards service calls to this service. These pure
// helpers build the forwarded request so the gateway preserves cookies and
// the original browser Origin, accepts only exact deployment-approved origins
// (never wildcards or reflected values) and never trusts arbitrary forwarded
// host/origin headers. See docs/operations/consumer-client.md for the
// routing/configuration table and the cache matrix.
export interface GatewayConfig {
  // Service origin, for example `https://users.example.com`.
  readonly serviceBaseUrl: string;
  // Exact `http(s)` origins accepted in addition to the gateway's own
  // origin. Empty means the gateway origin only; wildcards are rejected.
  readonly allowedOrigins: readonly string[];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

// Exact origin allowlist check: the gateway's own origin plus the configured
// deployment-approved origins. Matching is exact (scheme + host + port); no
// wildcards, suffixes or reflected values.
export function isAllowedGatewayOrigin(
  origin: string | null,
  gatewayOrigin: string,
  allowedOrigins: readonly string[],
): boolean {
  if (origin === null) {
    // Non-browser flows (curl, server-to-server gateways) carry no Origin;
    // the service accepts them as documented non-browser requests.
    return true;
  }
  if (origin === gatewayOrigin) {
    return true;
  }
  return allowedOrigins.includes(origin);
}

// Builds the service-bound request for one incoming browser request. Cookies
// (including the HttpOnly renewal session) and the original browser Origin
// travel untouched so the service origin guard and session resolution observe
// the real caller; `Set-Cookie` on the way back must likewise be forwarded
// untouched. Only paths under `/v1/` are forwardable — anything else is a
// gateway configuration error, not a service call.
export function buildServiceRequest(
  browserRequest: Request,
  servicePath: string,
  config: GatewayConfig,
): Request | null {
  if (!servicePath.startsWith('/v1/')) {
    return null;
  }
  const target = `${normalizeBaseUrl(config.serviceBaseUrl)}${servicePath}`;
  const headers = new Headers(browserRequest.headers);
  // Forwarded-host headers are never trusted: the service derives its base
  // URL from the direct connection origin, not from these values.
  headers.delete('x-forwarded-host');
  headers.delete('x-forwarded-proto');
  return new Request(target, {
    method: browserRequest.method,
    headers,
    body: browserRequest.body,
  });
}
