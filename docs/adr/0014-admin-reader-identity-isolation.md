# ADR-0014: Isolate Administrator and Reader identities

## Status

Accepted for fresh development environments. There are no real Users to
preserve in the development database, so development starts from a fresh D1
database and a new Administrator bootstrap. Do not add a legacy bridge,
credential migration, or rollout phases.

## Context

The current service stores Administrator and Reader identities in the same
Better Auth tables and uses one session cookie. A User row with
`role='admin'` can therefore authenticate both Reader and Administration
operations. Signing into or out of `/admin` can replace the cookie used by
`/v1/me`, Account Details, and Reader State.

## Decision

- Administrator and Reader are different identities with independent IDs,
  credentials, verification/recovery state, and live sessions. They may use the
  same email address; uniqueness is enforced only inside each realm.
- Better Auth `1.7.12` remains the authentication engine. The Identity feature
  owns separate Better Auth contexts and separately mapped Drizzle/D1 tables.
  Its generic Better Auth router is never mounted; every public operation uses
  an application-owned runtime-validatable contract.
- Reader storage remains `user`, `account`, `session`, and `verification`.
  Administration storage is `admin_user`, `admin_account`, `admin_session`,
  and `admin_verification`, with separately scoped bootstrap support state.
  Reader State signing keys and photo/account data stay in the Reader realm.
- Each realm has its own Better Auth cookie name/prefix and an appropriate Path:
  Reader cookies cover Reader endpoints; Administrator cookies cover
  `/v1/admin/*`. Every handler resolves only its own realm and rejects a cookie
  from the other realm. Login, logout, revocation, password reset, verification,
  and bans in one realm do not affect the other.
- `/v1/me`, Reader State issuance, self-account operations, and consumer auth
  resolve only Reader identities. `/v1/me` includes the required
  `realm: "reader"` discriminator. A legacy Reader-row `role='admin'` is not
  authority and must be rejected as a Reader session.
- Administration resolves only the Administrator session and checks
  authorization server-side. Admin list/detail and Account Details management
  read/write the intended Reader tables. An Admin identity is never a Reader
  target, and updating a Reader never uses an Admin-table `adminUpdateUser`
  operation.
- The Administration SPA retains its same-origin `/admin` asset surface but
  uses application-owned `/v1/admin/auth/*` operations for login and logout.
  First-Administrator bootstrap creates only in the Admin realm. First-admin
  wins, concurrency/recovery fences, and verification delivery behavior remain
  enforced and tested.
- No general Admin user-management capabilities beyond the existing intended
  Reader list/detail and Account Details slices are added here. Social identity
  providers and Google Calendar credentials are outside this change.

## Fresh development and existing local databases

Local development setup must create a fresh D1 database, apply the complete
versioned migrations, and run the explicit first-Administrator bootstrap. It
must not copy credentials or database contents. A database initialized with the
old shared Admin/Reader model is incompatible with this schema and must not be
silently bridged, migrated, or reset by application startup. Operators receive
separate manual instructions to preserve or explicitly discard a disposable
old local database; no command in the application deletes or resets a user's
existing local D1 database.

## Consequences

- Equal email strings are valid in both realms without linking their identities.
- Cookie ownership and identity lookup are unambiguous at every HTTP boundary.
- Reader-facing consumers can distinguish a verified Reader session by the
  explicit `realm` contract without treating Reader State as authority.
- Tests must exercise both realms through the real Worker and isolated D1,
  including equal-email concurrent sessions and independent lifecycle actions.
- This decision is for fresh local development and does not authorize remote D1
  mutation, release, or promotion.
