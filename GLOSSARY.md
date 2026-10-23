# Domain context

## Purpose

A reusable user-service foundation for content-oriented web products. The first deployment is single-client, not multi-tenant SaaS.

## Core concepts

### User

A registered end user of the consuming site. Editorial CMS operators are not Users in this domain.

### Identity

Authentication identity, credentials, linked providers, account recovery, email verification, and session lifecycle.

### Administrator

An Identity User authorized by the supported Better Auth administrative
permission API to read/list Users. The first administrator is bootstrapped
explicitly, verifies email and uses the same login and HttpOnly session as any
User. This service-owned permission is separate from editorial CMS roles.
`GET /v1/admin/me` exposes only id, email, emailVerified and role; public
`GET /v1/me` retains its three-field representation.

### Administration UI

The same-origin React SPA under `/admin` (spec #123, ADR-0012). Its first slice
supports administrator sign-in, real identity, reload and sign-out; list/detail
are subsequent slices. Server responses, rather than browser role claims,
authorize access.

### Auth Policy

Deployment-level configuration that controls supported authentication behaviour without exposing Better Auth configuration directly to feature code. It includes capabilities such as registration enablement, email/password enablement, required email verification, password creation requirements, OAuth providers, and auth/session lifetimes. Password creation requirements apply to registration, reset and administrator bootstrap, not login. The initial deployment requires verified email before login succeeds.

### Profile

User-facing account data such as display name, avatar reference, and preferences.

### Subscription

A User's commercial agreement for a Plan, with a status and period of validity. The consuming product decides access from that state and owns its paywall; Subscription is separate from editorial roles.

### Entitlement

A benefit granted to a User for a defined period, independently of the collection provider. The consuming product maps that benefit to its own content and access rules.

### Paid-through date

The end of the period covered by confirmed payment. It is separate from renewal intent and the lifetime of an authentication credential.

### Plan

A subscription offer with a billing interval, price and currency.

### Billing Provider

An external service that manages collection authorizations and payments for a Subscription. Its identity is separate from the Plan and the consuming product's access rules.

### Follow

A relationship in which a User follows a target entity identified by an external canonical id and target type. Targets may include teams, topics, competitions, players, authors, or eventually users.

### Bookmark

A User's saved reference to content for later access.

### Audience

A queryable/segmentable set of Users used for operational or commercial export. The service supports segmentation/export but does not deliver newsletters.

### Marketing consent

The User's explicit communication preference and its relevant metadata, such as timestamp/source.

### Community

Optional future functionality containing comments, replies, votes, reports, and moderation. Community is not part of the initial core.

### Analytics

Traffic/product analytics is a separate service or third-party platform. This service may emit events for analytics consumers but does not own analytics storage/reporting.

## Product boundaries

### In scope initially

- identity and sessions
- configurable authentication policy
- required email verification for the initial deployment
- profile
- subscription state
- follows
- bookmarks
- preferences/consent
- audience segmentation/export
- object-storage-backed user files such as avatars
- integration/domain events

### Candidate later modules

- reading history
- saved statistical filters/comparisons
- notification preferences
- community/comments/replies/votes
- follow users
- referral/promotion metadata
- OTP/passwordless authentication
- MFA/passkeys
- new-device authentication alerts

### Out of scope

- editorial CMS roles and publishing permissions
- newsletter delivery
- web/product analytics platform
- hard protection of premium content; consuming products may use a client-side soft paywall
- historical Identity foundation (#8) excluded administration UI; the accepted
  follow-on spec #123 now includes service-owned administration

## Architectural vocabulary

### Deployment target

A company + site pair (plus the service) that owns isolated Cloudflare
resources per canonical environment. The first target is RCH RugbyChampagne.
The site is part of the isolation boundary: one company may own multiple
sites with fully separate login/session/user stores.

### Deployment key

The canonical `<company>-<site>-<service>-<environment>` identifier from
which Worker and resource names derive with explicit resource suffixes
(`-db`, future `-session`, future `-files`). Application binding names stay
short and stable (`DB`, future `SESSION`, future `FILES`).

### Feature slice

A vertical unit that owns an externally observable capability across contract, domain behaviour, persistence and tests.

### Contract

A runtime-validatable public interface. HTTP contracts are the source for generated OpenAPI and clients.

### Adapter

A narrow integration boundary for infrastructure whose implementation may change, such as object storage, transactional email, or an external provider.

### Auth Action URL

The user-facing verification/reset link delivered by transactional auth mail. It targets either a deployment-configured consumer action page or the service-owned fallback browser routes, and carries the engine token as a single `token` query parameter. The Better Auth callback URL is an engine implementation detail and never becomes an Auth Action URL.

### Consumer Origin

An exact, deployment-configured browser document origin (scheme + host + port,
no wildcard) that is allowed to call the service directly with credentialed
CORS for the consumer identity operations. It is distinct from a gateway
origin and from the service origin; CORS grants browser read permission only
and never replaces Origin/Fetch Metadata mutation authorization. The
service-only renewal session cookie is host-only to the service hostname and
is never shared with the consumer origin.

### Authenticated User

The stable application-facing identity exposed to feature slices after authentication. It must not expose Better Auth persistence models or provider-specific types.

### Session Context

The stable application-facing session data available to authenticated feature slices. It is an application contract, not a Better Auth internal type.

### Authoritative Session

The live, store-backed Better Auth session carried only by the service-hosted,
host-only HttpOnly cookie. It is the credential for account and administration
operations and for issuing Reader State or future Access Tokens. JavaScript
cannot read it, and locally restored presentation state never proves it is
active.

### Reader State

A signed, short-lived, locally verifiable presentation snapshot for cached
editorial sites (spec #195, ADR-0013, ticket #196). It contains only an opaque
subject, stable issuer, Reader-State-specific audience, integer issue/expiry
times and server-derived presentation Entitlements. Verified Reader State may
be stored in versioned deployment-scoped `localStorage` and shared across tabs,
but it never authenticates or authorizes a User Service or receiving API
endpoint.

### Access Token

A future short-lived API credential for one deployment-configured receiving
resource (spec #195). It has a resource-specific audience and is stored at
most in memory or versioned tab-scoped `sessionStorage`. It is distinct from
Reader State and is not implemented by ticket #196.

### Consumer Identity client

The framework-independent browser client for cached editorial sites. Under
spec #195 and ticket #196 it uses generated OpenAPI contracts, keeps only
verified Reader State and public keys in versioned deployment-scoped storage,
shares one controller with lazy single-flight refresh, synchronizes replacement
and logout across tabs, and exposes presentation state separately from unknown
or confirmed authoritative-session status. It never uses Reader State to call
an authenticated API.

### Same-origin gateway

The consumer-owned same-origin API gateway that forwards service calls to this service while preserving cookies and the original browser `Origin`. It accepts only its own origin plus exact deployment-approved origins, forwards only `/v1/` paths, and never trusts arbitrary forwarded-host/origin headers (spec #150, ADR-0013).

### Release environment file

The complete, versioned and secret-free `config/environments/.env.<environment>`
file that owns one remote sandbox or production release. The ignored root
`.env` is local-development-only.
