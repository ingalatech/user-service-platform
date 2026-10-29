# ADR-0013: Separate presentation state from API credentials

## Status

Accepted by the operator on 2026-10-14. Decision #149, specification #150,
implementation slices #151 and #152 under product map #146.

Amended on 2026-10-15 by decision #163, specification #164 and slice #165:
the consumer transport is direct browser CORS with a service-only host-only
session cookie, not a same-origin gateway. The JWT verification, bounded
revocation and no-per-page-Identity decisions above are unchanged.

Amended on 2026-10-21 by specification #195 and Reader State slice #196: the
former consumer JWT must no longer combine editorial presentation state with
API bearer authority. The authoritative session, Reader State and future
Access Tokens are separate contracts with non-overlapping uses and storage.

## Decision

Keep the host-only HttpOnly Better Auth Reader session as the authoritative
Reader account and Reader State issuance credential. It is never exposed to
JavaScript. Administrator credentials and sessions are isolated as specified
by ADR-0014 and are not Reader State authority.

Reader State is a short-lived, application-owned asymmetric JWT used only for
editorial presentation. It is not an authentication or authorization
credential and no User Service or receiving API endpoint accepts it as Bearer
authority. Consumers persist only cryptographically verified Reader State in
versioned deployment-scoped `localStorage` and may reuse it across page
navigations and tabs. Restored Reader State says nothing about whether the
authoritative session is still active.

POST `/v1/auth/reader-state` issues or refreshes Reader State through the live
session and returns a private, noncacheable response. The former
`POST /v1/auth/token` Bearer-shaped contract is retired by slice #196 rather
than retained as an ambiguous alias. Remote environments have not activated
that former contract, and the superseded consumer integration ticket #166 did
not ship it. GET `/v1/auth/jwks` continues to publish only public verification
keys with bounded caching.

Reader State uses a stable deployment issuer and a Reader-State-specific
audience. Its default and maximum lifetime is 900 seconds and it never exceeds
the authoritative session expiry. Claims contain only opaque `sub`, `iss`,
`aud`, integer `iat`/`exp` and server-derived presentation `entitlements`;
this increment emits an empty Entitlement list. Email, roles, session
credentials, provider identifiers, API scopes and arbitrary claims are
excluded. Commercial grants, prices and payment lifecycle are not invented by
Identity.

Access Tokens are a separate future contract for one configured receiving
resource. They will have resource-specific audiences, a maximum 300-second
lifetime and memory or versioned tab-scoped `sessionStorage` storage. They are
not implemented by slice #196. OAuth, introspection and browser-supplied
audiences or scopes remain outside this decision.

## Consumer contract

The supported browser transport is a direct call from an exact
deployment-configured consumer origin to the service Worker at a distinct
same-site origin (decision #163, spec #164). The browser uses
`credentials: include` for the existing Better Auth/D1 HttpOnly session; the
service grants credentialed CORS only to named origins, with the exact
`Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials: true` and
`Vary: Origin` on relevant success and error responses. Preflight needs no
session, is restricted to the methods and headers the consumer operations use
and uses a bounded cache. Wildcards, `null` and arbitrary reflection are never
granted. CORS is a browser permission boundary, not authentication: the
service still validates cookie-auth mutations explicitly against same-origin
or exact deployment-approved origins and Fetch Metadata.

The renewal session cookie is service-only: it is HttpOnly and host-only to
the service hostname (no `Domain` attribute), so it is never shared with the
parent editorial hostname and never depends on unrelated-site cookies. The
editorial HTML stays identical for anonymous and logged-in readers and makes
no Identity request while valid Reader State is retained. Reader State is
verified locally against cached public JWKS solely before presentation.
Receiving APIs reject it regardless of signature validity. SSO and cookies
shared with the editorial hostname remain outside this increment.

The earlier same-origin gateway transport remains supported and coexists:
`AUTH_GATEWAY_ORIGINS` still names an exact same-origin gateway, and
`AUTH_CONSUMER_ORIGINS` separately names exact direct-browser consumer
origins. Both sets are exact-match mutation grants; neither silently changes
the meaning of the other. The gateway does not make arbitrary forwarded
headers trustworthy.

A framework-independent client uses generated OpenAPI types, keeps verified
Reader State and its public-key cache in versioned deployment-scoped
`localStorage` namespaced by service/issuer/audience, and shares one controller
among scripts/islands. It stores no login identity fields or authentication
credential there. Full document navigation, reload and a second tab reuse
valid Reader State without an Identity request while authoritative session
status remains unknown.

The client verifies the fixed algorithm, signature, issuer, exact Reader State
audience, integer times, expiration and exact claims contract before exposing
presentation state. Replacement and logout synchronize across tabs without
transmitting credentials. Deployment-scoped browser locking orders login and
server logout cookie effects across tabs, while generation checks prevent stale
asynchronous Reader State results from restoring prior state. Manual refresh
supports known benefit changes. Automatic refresh is lazy and single-flight
only when expired state is requested; inactive and anonymous pages never poll
or probe Identity.

Key rollover retains old public keys through outstanding JWT expiry plus the
documented clock tolerance. A bounded unknown-key refresh is distinct from
per-page Identity resolution.

## Consequences

Reader logout/password reset immediately prevent renewal through revoked
Reader sessions. Administrator login, logout or recovery operates only on the
separate Administrator session defined by ADR-0014.
An already-issued Reader State may remain cryptographically valid until
expiry, at most 15 minutes, but logout synchronization removes local
presentation promptly in active tabs. This bounded presentation staleness is
accepted instead of a database lookup on every content navigation. Reader
account and cookie-session checks keep authoritative store-based semantics and
never accept Reader State as authority.

Entitlement validity and token expiry are separate. The consumer owns content
classification, soft paywall, SEO and cache policy. Backend Identity delivery
proceeds before the remaining billing lifecycle decision #147; its completion
must not be reported as working paid subscriptions.

## Alternatives considered

A per-page `/me`/rights lookup gives fresher state but makes read traffic
depend on Identity. Long-lived unrestricted JWTs reduce renewals but enlarge
staleness/revocation exposure. Replacing the current session would also change
accepted administration behavior; retaining it for renewal keeps that contract.

## Acceptance

The real HTTP/D1 path proves issue, public-key verification, refresh and
revocation of further issuance. A real browser at an approved consumer origin
against a real Worker/D1 at a distinct same-site service origin proves the
direct-browser lifecycle, credentialed CORS, host-only service-cookie scope
and hostile-origin rejection; two ports on one hostname cannot prove host
isolation. A shipped-client/real-Worker browser fixture proves verified
Reader State restoration across navigation, reload and a second tab with zero
Identity calls while state is valid, conservative invalid/expired/unavailable
fallbacks, cross-tab replacement/logout and lazy single-flight refresh.
Generated client drift and OpenAPI compatibility checks protect the external
handoff. Exact-HEAD Standards, Spec and CI remain required; production
promotion is separate.
