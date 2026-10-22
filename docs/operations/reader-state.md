# Reader State runbook

Reader State is a signed presentation snapshot for cached editorial consumers
(spec #195, ADR-0013, ticket #196). It is never an authentication or
authorization credential. User Service and receiving APIs must reject it as
Bearer authority even when its signature is valid.

## Operations

- `POST /v1/auth/reader-state` issues or refreshes Reader State from the live
  service-only HttpOnly session. The request carries no user, claims, issuer or
  audience. The response contains `readerState` and integer Unix `expiresAt`.
  Success and relevant errors are `private, no-store`.
- `GET /v1/auth/jwks` publishes only active and retained public verification
  keys with `Cache-Control: public, max-age=300`. Private key material is never
  published.
- The Better Auth router is never mounted. Reader State authorizes no service
  operation; account and administration routes continue to resolve the live
  cookie session from D1.

## Claims and lifetime

Reader State contains exactly opaque `sub`, stable `iss`, the
Reader-State-specific `aud`, integer `iat`/`exp`, and server-derived
`entitlements`. This slice emits `entitlements: []`; no billing or paid right
is invented. Email, roles, session credentials, provider identifiers, API
scopes and arbitrary claims are excluded.

The default and maximum lifetime is 900 seconds and `exp` never exceeds the
authoritative session expiry. Sign-out, password reset and session revocation
prevent further issuance. Already-issued Reader State can remain
cryptographically valid until its bounded expiry; it still has no API
authority.

## Configuration

- `AUTH_JWT_ISSUER`: stable deployment-owned issuer. Local/test use a
  deterministic local-only default; sandbox/production fail closed when unset.
- `AUTH_READER_STATE_AUDIENCE`: stable Reader-State-only audience. It must not
  be reused for a receiving API.
- `AUTH_READER_STATE_TTL_SECONDS`: integer `1..900`, default `900`.
- `AUTH_CONSUMER_ORIGINS`: exact direct-browser origins receiving credentialed
  CORS and cookie-mutation permission.
- `AUTH_GATEWAY_ORIGINS`: separate exact gateway-origin compatibility list.

Signing uses fixed EdDSA/Ed25519 keys persisted per deployment in D1. Unknown
key refresh is bounded and old public keys remain available through every
outstanding JWT lifetime plus clock tolerance.

## Browser boundary

The client verifies algorithm, signature, issuer, exact Reader State audience,
integer times, expiration and the exact claims set before exposing state. Only
verified compact Reader State plus its verified expiry and public JWKS cache
are stored in versioned deployment-scoped `localStorage`. No email, session
credential, unverified payload or Access Token is stored there.

Valid state restores across navigation, reload and tabs without an Identity
request. Restored state reports authoritative session status as `unknown`.
Manual refresh supports known benefit changes. Automatic refresh is lazy and
single-flight only when expired state is requested; anonymous and inactive
pages never probe or poll Identity. Replacement and logout use
credential-free cross-tab markers, and stale asynchronous results cannot
restore prior state.

## Transport

Direct browser requests use `credentials: include` from exact configured
consumer origins. CORS grants browser read permission only; Origin/Fetch
Metadata guards remain the mutation boundary. The session cookie stays
host-only, HttpOnly and service-scoped. Existing same-origin/headerless flows,
administration and account behavior remain unchanged.

The former `POST /v1/auth/token` Bearer-shaped contract is retired. Access
Tokens, receiving-backend verification and resource audiences belong to #197
and #198 and are not implemented here.
