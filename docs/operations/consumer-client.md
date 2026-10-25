# Consumer Reader State client handoff

Framework-independent browser client for presentation-only Reader State on
cached editorial sites (spec #195, ADR-0013, ticket #196). The consumer team
vendors `src/features/identity/consumer-client/` directly; no npm publication
or frontend repository change is part of this slice.

## Public surface

- `createConsumerClient()` creates the shared deployment-scoped controller and
  is the supported entry point. Its returned `ConsumerClient` is the consumer
  interface; storage, JWKS-cache construction, signature verification and
  cross-tab adapters are implementation details.
- `login()` authenticates through the service-only HttpOnly session and then
  obtains verified Reader State.
- `getSnapshot()` returns locally verified presentation state. It performs no
  request when state is absent or valid; expired state triggers one lazy,
  coalesced refresh.
- `refreshReaderState()` is the explicit "refresh benefits" operation.
- `getSessionStatus()` distinguishes `unknown`, `authenticated` and
  `anonymous`. Restored Reader State always starts `unknown`.
- `logout()` clears local state first and again after acquiring the deployment
  mutation lock, then propagates credential-free logout and requests server
  sign-out. Server failure remains visible as `logout-failed`.
- `observeReaderState()` lets scripts/islands react to verified replacement or
  logout without polling.

The consumer barrel exports the public client/error/config/input/state types
and the password-policy evaluator used by registration forms. It does not
export storage mutation, cache construction or low-level verification helpers.
The storage key helper, storage adapter type, `readerStateStore` option and
`nowSeconds` option remain as a compatibility exception for the vendored RCH
client test. Removing them requires a separate RCH change; production RCH code
uses the controller and does not coordinate storage internals.

Generated TypeScript contracts live at
`src/features/identity/consumer-client/generated/api.d.ts` and are produced by
`npm run consumer:generate`. Never edit them manually; `npm run consumer:check`
detects drift. Source contracts generate `openapi/openapi.json`.

## Storage and verification

Reader State and the public-key cache use versioned deployment-scoped
`localStorage` keys namespaced by service URL, issuer and Reader State
audience (`usp.reader-state.v1.*`). The client stores only the compact verified
Reader State and verified expiry, never login identity fields, a session
credential, an unverified payload or an API credential.
If a cross-tab logout cannot remove the state key, it records a durable
invalidation marker so a reload or new controller fails closed instead of
restoring the old snapshot.

Before exposure, the client validates fixed `EdDSA`, key id, Ed25519 signature,
configured issuer, exact Reader State audience, integer `iat`/`exp`, current
expiration, opaque subject, empty server-derived Entitlements and the exact
claims allowlist. Unknown-key JWKS refresh is bounded and independent of
Identity/session resolution.

Valid state restores across full navigation, reload and another tab with zero
Identity calls. Cross-tab replacement/logout messages contain only change type,
source id, deployment mutation revision (`authMutationVersion`) and timestamp.
Revisions order markers from serialized login/logout mutations; generation
guards ensure an older in-flight result cannot overwrite a newer replacement or
resurrect state after logout.

## Browser support

Browser `login()` and `logout()` require a secure context, Web Locks and usable
`localStorage`. Missing or rejected Web Locks and unavailable or failing
`localStorage` reject with the stable `unsupported-browser` code before any
server auth mutation. Login therefore fails closed. Logout still clears the
client's local Reader State first, then rejects visibly because server session
revocation did not run; consumers must not present that failure as a completed
server sign-out.

## Request behavior

- Anonymous page with no local state: zero requests.
- Valid local Reader State: zero Identity/JWKS requests when cached keys are
  available.
- Expired state requested by UI: one coalesced Reader State refresh.
- Manual benefit refresh: one explicit Reader State refresh.
- `401`: clear state and record authoritative session `anonymous`.
- Service/network/JWKS failure: report unavailable without extending validity,
  inventing anonymity or retaining unverified state.
- No request includes Reader State in `Authorization` or any other header.

## Cache matrix

| Content                      | Cacheability                        | Notes                                      |
| ---------------------------- | ----------------------------------- | ------------------------------------------ |
| Shared editorial HTML        | Public consumer CDN                 | Identical for all readers.                 |
| `GET /v1/auth/jwks`          | `public, max-age=300`               | Public keys only.                          |
| `POST /v1/auth/reader-state` | `private, no-store`                 | Live-session issue/refresh.                |
| `/v1/me`, account APIs       | `private, no-store`                 | Cookie-session reads.                      |
| Verified Reader State/JWKS   | Versioned deployment `localStorage` | Presentation state/public keys only.       |
| Cross-tab marker             | Versioned deployment `localStorage` | Credential-free replacement/logout signal. |

## Explicit boundary

Reader State drives editorial presentation only. It never authenticates User
Service, administration, account APIs or a receiving backend. Access Tokens,
resource profiles, backend verifier examples, OAuth, introspection and API
calls are deferred to #197/#198.
