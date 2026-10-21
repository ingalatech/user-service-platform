# Consumer tokens runbook

Application-owned short-lived access tokens for cached editorial consumers
(spec #150, ADR-0013, ticket #151). The authoritative HttpOnly cookie session
remains the renewal credential; the JWT is a bounded offline snapshot that
receiving APIs verify with cached public keys and no per-request identity
lookup. Initial tokens grant no paid Entitlements; the framework-independent
consumer client is the follow-on slice (#152).

## Operations

- `POST /v1/auth/token` issues or renews from the live cookie session. The
  request carries no user, claims, issuer or audience. The response holds
  `accessToken`, literal `tokenType: Bearer` and integer Unix `expiresAt`.
  All responses are private, no-store.
- `GET /v1/auth/jwks` publishes the active and retained public verification
  keys as an RFC 7517 set with `Cache-Control: public, max-age=300`.
  Private key material is never published. Failures are not cached.
- The engine auth router is never mounted: no `/api/auth/*` surface exists.
  The JWT alone authorizes no service operation — administrative checks stay
  store-backed and `/v1/me` keeps its cookie-session semantics.

## Cookie renewal vs offline-token revocation

- Sign-out and password reset revoke the renewal session immediately:
  further `POST /v1/auth/token` calls with that session are denied (401).
- An already-issued offline token remains valid until its own `exp`, at most
  15 minutes initially. There is no instant global JWT revocation; this
  bounded snapshot is the accepted trade-off (ADR-0013).
- The service slides the renewal session on activity (pinned engine
  default): a live session normally outlives any outstanding token, and the
  minted `exp` additionally never exceeds the authoritative session expiry.

## Direct-browser transport with consumer CORS

The supported browser transport is a direct call from an exact
deployment-configured consumer origin to this service Worker at a distinct
same-site origin (decision #163, spec #164, ADR-0013). The consumer document
uses `credentials: include`; the service grants credentialed CORS only to
origins named in `AUTH_CONSUMER_ORIGINS`:

- Relevant success and error responses carry the exact
  `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true` and
  `Vary: Origin`. Wildcards, `null` and arbitrary reflection are never emitted.
- `OPTIONS` preflight needs no session, allows only `GET`/`POST` and the
  `Content-Type`/`Authorization` request headers, and uses
  `Access-Control-Max-Age: 600`.
- CORS is a browser permission boundary, not authentication. Cookie-auth
  mutations stay authorized by the Origin/Fetch Metadata guard below, so an
  unapproved origin cannot mutate state through an unguarded path.

The service-only renewal session cookie is HttpOnly and host-only to the
service hostname (no `Domain` attribute): it is never sent to the editorial
hostname, and the editorial HTML/cache stays free of cookies and per-page
Identity calls. `usuarios.rugbychampagneweb.com` is the selected desired
production service hostname; live DNS/TLS/issuer/audience values are separate
operational facts and must be verified before claiming sandbox/live readiness.

The earlier same-origin API gateway transport remains supported and coexists:
`AUTH_GATEWAY_ORIGINS` names exact gateway origins; `AUTH_CONSUMER_ORIGINS`
separately names exact direct-browser consumer origins. Both are exact-match
mutation grants and neither silently changes the other's meaning.

Cookie-auth mutations (`POST /v1/auth/register`, `/v1/auth/login`,
`/v1/auth/sign-out`, `/v1/auth/token`) enforce an explicit Origin/Fetch
Metadata guard because the application-owned wrappers call `auth.api`
directly:

- An explicit `Origin` header must equal the request origin, an exact
  configured gateway origin, or an exact configured consumer origin; `null`
  and unlisted origins are rejected (403).
- Without `Origin`, `Sec-Fetch-Site: cross-site` (or an unknown value) is
  rejected; `same-origin`, `same-site` and `none` are accepted.
- Requests with neither header (curl, tests, server-to-server gateways) are
  accepted as documented non-browser flows.
- There is no wildcard CORS and no trust in arbitrary forwarded-host/origin
  headers.

## Issuer, audience, TTL and key configuration

Non-secret deployment values (see `src/config/profiles.ts`):

- `AUTH_JWT_ISSUER` / `AUTH_JWT_AUDIENCE`: stable deployment-owned
  identifiers. Local/test fall back to deterministic local-only defaults;
  sandbox/production fail closed (500) without explicit values. Never
  derived from request or forwarded hosts.
- `AUTH_JWT_TTL_SECONDS`: token lifetime in seconds, `1..900`, default
  `900`. Malformed values fail closed. The minted `exp` is additionally
  capped at the live session expiry.
- `AUTH_GATEWAY_ORIGINS`: comma-separated exact `http(s)` gateway origins
  accepted for cookie-auth mutations in addition to the request origin. Empty
  means same-origin only; wildcards, paths, credentials and fragments are
  rejected.
- `AUTH_CONSUMER_ORIGINS`: comma-separated exact `http(s)` direct-browser
  consumer origins granted credentialed CORS and accepted for cookie-auth
  mutations. Empty means same-origin only (no direct consumer origin);
  wildcards, `null`, paths, credentials and fragments are rejected.

Signing keys:

- Fixed asymmetric algorithm `EdDSA` (`Ed25519`); durable per-deployment
  key rows in D1 (`jwks` table, additive migration `0002`); stable key ids
  surface as JWT `kid` values, so separate Worker instances with the same
  database reuse keys. No per-request rotation and no shared
  sandbox/production keys.
- Private keys stay encrypted through the engine facility
  (`BETTER_AUTH_SECRET`) and never enter logs or responses.
- Keys are retained indefinitely in this slice, which covers every
  outstanding token lifetime (at most 15 minutes) plus verifier clock
  tolerance. Receiving verifiers should allow ~60 seconds of clock skew and
  refresh unknown `kid` values from `GET /v1/auth/jwks` (bounded,
  distinct from per-page identity queries).

## Claims contract

`sub` (opaque User id), `iss`, `aud`, integer `iat`/`exp`, and
`entitlements: []`. Email, roles, session identifiers/tokens, engine rows
and billing-provider identifiers are excluded. A missing billing
implementation grants nothing: paid Entitlements wait for the commercial
lifecycle decision (#147).
