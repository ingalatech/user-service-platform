# Consumer Identity client handoff

Framework-independent browser client for reusable JWT sessions on cached
editorial sites (spec #150, ADR-0013, ticket #152). The consumer team vendors
these sources directly from this repository — package/source delivery in the
repo is enough, no npm publication — and serves them behind its own
same-origin gateway. No consumer repository access, article/paywall UI,
blanket CORS, cross-site cookies, SSO, live deployment/CDN or credentials are
part of this handoff.

## What the consumer receives

- Independently importable entrypoint:
  `src/features/identity/consumer-client/index.ts`. It depends only on the
  generated OpenAPI contracts and `openapi-fetch`; it never imports React,
  Hono, persistence or engine server types.
- Generated TypeScript contracts:
  `src/features/identity/consumer-client/generated/api.d.ts`, produced from
  the source-generated `openapi/openapi.json` with `openapi-typescript`
  (`npm run consumer:generate`). The generator is isolated in the
  consumer-codegen workspace under the scoped TypeScript 5 exception
  (ADR-0006): pinned `openapi-typescript@7.13.0` declares peer
  `typescript@^5.x`, so the workspace pins supported 5.x version 5.9.3;
  the service stays on its pinned TypeScript 6 toolchain and ordinary
  `npm ci` installs both without peer overrides. A declared peer
  restriction is not proof that TypeScript 6 cannot run the generator;
  the desired end state is TypeScript 6 here too. Generated code is never
  hand edited; drift fails `npm run consumer:check`.
- Vanilla TypeScript handoff examples:
  `src/features/identity/consumer-client/examples/` — Astro page-script
  singleton (`astro-page-script.ts`), shared React-island consumption
  (`react-island.ts`), backend bearer verification with cached JWKS
  (`backend-verifier.ts`) and same-origin gateway forwarding
  (`same-origin-gateway.ts`).
- Compatibility protection: `npm run openapi:compat` diffs the published
  document against the pinned previous-main baseline
  (`openapi/baseline/a88774e.json`, byte-identical to that commit) using
  the retained project-owned comparator (ADR-0007), not universal OpenAPI
  analysis. Additive paths and optional fields pass; breaking changes fail
  before external adoption. Changes to other validation constraints or
  compositions conservatively require review rather than silently passing.

## Transport and gateway configuration

The supported browser transport is a same-origin API gateway owned by the
consumer team: the browser talks to the consumer origin, which forwards
service calls to this service. Direct unrelated-origin browser calls,
cross-site cookies and full SSO are outside this increment.

Gateway rules (see `examples/same-origin-gateway.ts`):

- Preserve cookies (`Set-Cookie` included) and the original browser `Origin`
  untouched so service session resolution and the Origin/Fetch Metadata guard
  observe the real caller.
- Accept the gateway's own origin plus exact deployment-approved origins from
  `AUTH_GATEWAY_ORIGINS` (comma-separated `http(s)` origins, empty means
  same-origin only). No wildcards, suffix matches or reflected values; never
  trust arbitrary forwarded-host/origin headers.
- Forward only `/v1/` paths. Anything else is a gateway configuration error,
  not a service call.
- Require a secure context wherever the client runs.

Operational limitation: the selected release environment file currently sets no explicit
`AUTH_JWT_ISSUER`/`AUTH_JWT_AUDIENCE` for sandbox, so token/JWKS operations
intentionally fail closed there until explicitly configured. Ordinary
health/session smoke is not proof of live JWT activation.

## Token lifecycle and browser storage

- `login()` authenticates through existing Identity (verified email required
  per deployment policy), then obtains the JWT plus a shared identity
  snapshot (`id`, `email`, `emailVerified`, `expiresAt`).
- The token and public-key cache live in versioned tab-scoped
  `sessionStorage` namespaced by service/issuer/audience
  (`usp.consumer.v1.*`), surviving full document navigation and reload within
  the tab. Separate deployments never share credentials; a later login for
  another user replaces previous state.
- The authoritative renewal session stays HttpOnly and is never exposed to
  JavaScript or copied into the token.
- Browser-storage/XSS trade-off: the bearer token is readable by page scripts
  by design. Bound the exposure with the short token lifetime (default 900
  seconds, configurable down to 1), secure contexts and the consumer's normal
  script/CSP controls.
- An anonymous page without local credentials makes no identity request. A
  valid token uses its locally verified snapshot without `/me`, token,
  renewal or provider requests. Explicit session recovery in a fresh tab may
  do one bootstrap (one token issue plus one identity read); absence of a
  token never authorizes probing on every anonymous page.
- JWKS fetching is cached independently with bounded refresh for unknown
  kids — distinct from per-page identity resolution.
- Before accepting persisted credentials the client verifies the fixed
  `EdDSA` algorithm, expected issuer/audience, integer issue/expiry bounds and
  the application-owned claims allowlist. Browser results drive UI only;
  receiving APIs verify independently and never trust them.
- Empty `entitlements` grants no premium/statistics right. Nonempty rights
  are rejected rather than interpreted; paid rights wait for the commercial
  lifecycle decision (#147) and future billing integration.
- Renewal is lazy and coalesced: simultaneous consumers share one renewal,
  with no polling of inactive readers and no refresh loop. `401` clears
  expired authentication; service/network failure yields `unavailable` (never
  anonymous, never extended validity) with at most one retry on network
  failure. Stable machine codes (`service-unavailable`,
  `network-unavailable`, `invalid-token`, server RFC 9457 problem codes) let
  the consumer branch without parsing text.
- `logout()` clears local state, calls server sign-out and propagates a
  credential-free marker to active same-origin tabs, which clear their own
  tab-scoped state. A failed server logout throws `logout-failed` while local
  state stays cleared — it is never presented as successful revocation.

## Cache matrix

| Content                     | Cacheability             | Notes                                                                   |
| --------------------------- | ------------------------ | ----------------------------------------------------------------------- |
| Shared editorial HTML       | Public, consumer CDN     | Contains no identity, tokens or credentials; identical for all readers. |
| `GET /v1/auth/jwks`         | `public, max-age=300`    | Public keys only; verifiers cache and refresh unknown kids (bounded).   |
| `POST /v1/auth/token`       | `private, no-store`      | Token issue/renewal; never cached or shared.                            |
| `/v1/me`, account APIs      | `private, no-store`      | Cookie-session reads; never embedded in shared HTML.                    |
| Token/account browser state | Tab `sessionStorage`     | Never in `localStorage`, cookies (except HttpOnly renewal) or URLs.     |
| Logout marker               | `localStorage` timestamp | Credential-free cross-tab signal only.                                  |

## Revocation boundary

Sign-out and password reset revoke the renewal session immediately: further
token issuance is denied (`401`). An already-issued offline token remains
valid until its own `exp` (at most 15 minutes initially). There is no instant
global JWT revocation; this bounded snapshot is the accepted trade-off
(ADR-0013). Administrative checks stay store-backed and never accept the JWT.

## OpenAPI baseline provenance and updates

- The baseline `openapi/baseline/a88774e.json` is byte-identical to
  `openapi/openapi.json` at agreed previous-main commit `a88774e`
  (verified by object hash). It is a pinned artifact, not a second
  specification.
- `npm run openapi:compat` compares the baseline against the current
  document. Intentional breaking changes require an explicit versioned
  transition (normally `/v2`) with migration planning, then a deliberate
  baseline update: regenerate `openapi/openapi.json`, copy it over the
  baseline file, and commit both with the breaking-change justification.
  Never edit the baseline to silence the gate.
