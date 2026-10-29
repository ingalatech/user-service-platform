# Research: account administration capabilities

## Question

What observable behavior do Arc XP Identity and Better Auth 1.7.12 provide for the
selected Reader and Administrator administration capabilities, which engine mechanisms can be
reused under the repository's separate Administrator/Reader realms, and which behavior remains an
application product decision?

This is research for issue [#260](https://github.com/ingalatech/user-service-platform/issues/260),
not an implementation specification. Arc XP is a behavioral reference, not an API or data-model
compatibility target.

## Evidence and confidence

Primary sources reviewed on 2026-10-29:

- Arc XP, [Arc XP Customer Service Admin portal](https://docs.arcxp.com/en/products/subscriptions/arc-xp-customer-service-admin-portal.html), updated 2026-01-16.
- Arc XP, [Manage user account: CSR perspective](https://docs.arcxp.com/en/products/subscriptions/introduction-to-arc-xp-identity/manage-user-account--csr-perspective.html), updated 2025-07-21.
- Arc XP, [What is an Arc XP Identity account](https://docs.arcxp.com/en/products/subscriptions/introduction-to-arc-xp-identity/what-is-an-arc-xp-identity-account.html), updated 2025-02-10.
- Arc XP, [Managing users](https://docs.arcxp.com/en/products/arc-xp-administration/permissions/managing-users.html), updated 2025-05-07. This describes Arc XP workforce/tool users, not Reader accounts.
- Better Auth, [Admin plugin](https://better-auth.com/docs/plugins/admin), [Email and password](https://better-auth.com/docs/authentication/email-password), and [User and accounts](https://better-auth.com/docs/concepts/users-accounts).
- The installed `better-auth@1.7.12` package, especially
  `dist/plugins/admin/routes.mjs`, `dist/api/routes/email-verification.mjs`,
  `dist/api/routes/password.mjs`, `dist/api/routes/update-user.mjs`, and
  `dist/api/routes/account.mjs`. Package version and repository provenance are declared in its
  installed `package.json`. Installed source was treated as authoritative for exact 1.7.12
  behavior where the rolling website documentation could differ.
- Repository contracts in `GLOSSARY.md`, ADR-0012, ADR-0014, ADR-0009, ADR-0010,
  `src/features/identity/auth.ts`, `identity-runtime.ts`, `schema.ts`, and `admin-users.ts` at
  commit `179657e`.

Arc XP's public product pages establish observable UI behavior but do not publish transaction,
authorization, concurrency, idempotency, or complete API semantics for these controls. No such
semantics are inferred below.

## Fixed repository boundary

These are existing decisions, not recommendations from this research:

- Administrator and Reader are independent identities. They have different IDs, credentials,
  verification/recovery state, tables, cookies, and sessions; the same email can exist once in each
  realm (ADR-0014).
- Administration authenticates through the Administrator Better Auth context and operates on a
  Reader only as an explicit target. An Administrator is never turned into or impersonates a
  Reader. Reader operations never mutate `admin_*` tables (ADR-0014).
- The generic Better Auth router is not mounted. Public behavior uses runtime-validatable,
  application-owned contracts (ADR-0014).
- The repository already creates separate Better Auth contexts over `user`/`account`/`session`/
  `verification` and `admin_user`/`admin_account`/`admin_session`/`admin_verification`. Reader and
  Administrator session resolution bypasses cookie cache so durable revocation takes effect
  immediately.
- Better Auth's Admin plugin is currently installed only in the Administrator context, whose
  adapter maps to `admin_*` tables. The Reader context deliberately has no same-realm
  Administrator session.

The last point is decisive: Better Auth's Admin plugin routes authorize an admin session and mutate
the users visible to that same auth context. Calling the existing Administrator context's
`adminUpdateUser`, `banUser`, `revokeUserSessions`, or `removeUser` would therefore target an
Administrator, not a Reader. Installing the plugin on the Reader context would not make the
separate Administrator cookie a Reader-context admin session. Those routes are useful source for
engine semantics, but they are not a cross-realm administration API.

## Capability matrix

| Capability                                      | Arc XP observable fact                                                                                                                                                                                                                                                                                 | Better Auth 1.7.12 fact                                                                                                                                                                                                                                                                                                                                            | Reuse under separate realms                                                                                                                                                                                                                                                                                                                                                                                                                                        | Product choice required                                                                                                                                                                                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Administrative verification                     | Arc XP exposes **Verify email** for an unverified email and warns that self-verification is preferred because it proves access. Activity classifies email verification as account activity.                                                                                                            | Admin `update-user` permits setting `emailVerified`, but only within its own admin-plugin realm. Core verification proves possession through a signed token; it has no cross-realm “force verified” operation.                                                                                                                                                     | Do not call the Administrator context against a Reader. A narrow application-owned Reader lifecycle mutation must set verification state after Administrator authorization and write an audit/activity event atomically. Existing token verification remains the Reader self-service path.                                                                                                                                                                         | Whether force-verification is allowed for both initial and pending-change addresses; mandatory reason/confirmation; exact concurrency rule if the pending address changes while the action is open.                                                                                                   |
| Resend verification/reset                       | Arc XP exposes **Request email verification** for the pending email and **Send password reset email**. The latter sends a link; it does not set a password.                                                                                                                                            | `sendVerificationEmail` and `requestPasswordReset` invoke configured mail callbacks. Reset responses avoid account enumeration; reset tokens expire and are single-use. This repository already adapts both callbacks to `AuthMailer`, reserves only the latest verification token, and revokes sessions after a successful reset.                                 | Reuse the Reader context's core server APIs behind Administrator-authorized application contracts, using the Reader email and Reader mail/action URLs. Use the Administrator context for equivalent-Administrator resend. Never use `setUserPassword`; map notes explicitly exclude direct password setting.                                                                                                                                                       | Admin response semantics, throttling, duplicate clicks/idempotency, and whether resend invalidates every earlier reset token (verification already reserves latest; Better Auth reset creation does not visibly delete earlier unexpired reset records).                                              |
| Pending email change                            | Arc XP can show a primary and an unverified email simultaneously. Editing replaces the unverified email; only verification promotes it to primary.                                                                                                                                                     | Core `changeEmail` keeps the stored email unchanged until the new address verifies by default. Its signed token carries current and target email. It can optionally require current-address confirmation. Better Auth does not expose a query for a durable pending address; the default pending value lives in the emailed signed token rather than the user row. | The verification mechanics and `AuthMailer` are reusable, but an admin-visible pending state and replacement semantics require application-owned persistence. Calling self-service `changeEmail` would require a Reader session and is not a cross-realm admin operation.                                                                                                                                                                                          | Durable pending-email model, expiry/display semantics, old-address confirmation policy, collision behavior, replacement/concurrency, cancellation, and whether administrative editing itself must generate a new verification message.                                                                |
| Social account listing/unlink                   | Arc XP lists linked social/OIDC login methods and lets a CSR remove them. Arc XP states an account has one or more identities and must have at least one sign-in identity.                                                                                                                             | `list-accounts` returns the current user's linked methods. `unlink-account` requires a fresh session, checks ownership, and rejects removal of the last account unless `allowUnlinkingAll` is enabled. These endpoints do not accept an administrative target user.                                                                                                | Use an application-owned safe projection of Reader `account` rows and a narrow unlink mutation after Administrator authorization. Preserve the useful Better Auth invariant by counting viable login methods in the same transaction; never expose provider tokens or the external `accountId`.                                                                                                                                                                    | What counts as a viable remaining login method, behavior when a credential row has no usable password, confirmation level, provider-display allowlist, and concurrency with provider linking/sign-in.                                                                                                 |
| Reversible disable                              | Arc XP toggles Active/Inactive and can later enable an inactive account. Its workforce administration separately describes reversible suspension/deactivation.                                                                                                                                         | Admin `ban-user` marks `banned`, optionally stores reason/expiry, and deletes all sessions; `unban-user` clears ban fields. Plugin installation also supplies sign-in/session enforcement.                                                                                                                                                                         | The Reader schema already has ban fields, but the Reader context does not install the Admin plugin, so merely updating them does not establish the plugin's enforcement. Implement a Reader lifecycle state plus an authoritative sign-in/session gate, or add an equivalent narrow engine hook; revoke Reader sessions on disable. Administrator disable uses only `admin_*` state and must enforce last-active/self-disable invariants at the application layer. | Canonical state vocabulary (`disabled` versus engine `banned`), reason/expiry, whether enable restores pending-deletion accounts, exact session-revocation outcome on partial failure, and race fencing against login/session creation.                                                               |
| Deletion request, not deletion                  | Arc XP **Request deletion** creates a pending task and label; an administrator later approves or declines it. Current CSA docs show Pending, Ready, Declined, and Completed request states and describe completion as anonymization.                                                                   | Core `deleteUser` and Admin `removeUser` hard-delete user data; the latter is explicitly irreversible. Hooks around core deletion do not turn it into a review request.                                                                                                                                                                                            | Reuse neither deletion endpoint. Create an application-owned request/workflow record and disable/revoke the Reader while review is pending. Material deletion/anonymization is out of scope and must not be triggered by this capability.                                                                                                                                                                                                                          | Request state machine, who may approve/decline/cancel, repeat-request idempotency, suspension restoration after decline, handling an already-disabled Reader, and concurrency/versioning.                                                                                                             |
| Lifecycle activity/audit                        | Arc XP shows reverse-chronological activity cards, filterable by type, with timestamp, description, sometimes actor and old/new values. Current categories include account creation, social link/unlink, verification, status change, deletion request, profile/password/email updates, and CSR notes. | Better Auth has callbacks/hooks for selected operations but no durable lifecycle activity or administrative audit ledger. Admin plugin mutations do not create such a ledger.                                                                                                                                                                                      | Add an application-owned durable ledger in the owning administration/identity capability. It is distinct from Worker diagnostics under ADR-0009. The map already excludes routine login/logout, IP, User-Agent, tokens, and email content. Record realm-qualified actor and target IDs; activity can be a safe projection of audit events rather than a second truth.                                                                                              | Exact event catalog and payload schema, old/new-value redaction, note support (not selected by this map), retention/pagination, actor labels after identity changes, and atomicity between mutation and event.                                                                                        |
| Reader session revocation                       | Arc XP documents invalidating all active sessions.                                                                                                                                                                                                                                                     | Admin plugin can list sessions, revoke by raw session token, or revoke all by user ID. In 1.7.12, single-session revocation accepts only a token and deletes it; the route does not itself verify that the token belongs to a separately supplied target user.                                                                                                     | “All” can be a narrow application operation deleting Reader sessions by Reader ID. “One” needs an opaque application session ID, a Reader ownership check, and an atomic delete scoped by both session and target; never return or accept the bearer token in the public contract. Existing authoritative session resolution already observes durable deletion.                                                                                                    | Safe session metadata to display (the map excludes IP and User-Agent), opaque selector design, treatment of the current Reader session, idempotent missing-session behavior, and interaction with already-issued Reader State, which remains valid until its short expiry but cannot renew.           |
| Equivalent-Administrator invitation/supervision | Arc XP workforce users are provisioned in an external IdP, activated by email, and then visible to Permissions after first login. Suspension/deactivation is reversible. This is not Arc XP Reader Identity behavior and does not prove an Arc-owned invitation state machine.                         | Admin `createUser` requires the caller to provide a password; it is not an invitation. The CLI can create a verified admin, but is provisioning tooling. Admin ban/unban is same-realm and prevents self-ban, while remove prevents self-removal; Better Auth does not preserve the last active admin or implement invite acceptance/supervision.                  | Build an Administrator-realm invitation/activation flow using `admin_*` tables, Administrator mail/action URLs, and application-owned contracts. Existing admin verification/reset mail mechanics may be reused after an Administrator identity exists. All Administrators receive the same application authority; enforce no self-disable and at least one active Administrator with transactional/concurrency fences.                                            | Whether an invitation creates `admin_user` immediately or only on acceptance, invite expiry/reissue/revocation, initial credential ceremony, email uniqueness with pending invites, who can inspect invitation activity, and the precise definition of “active” for the last-Administrator invariant. |

## Facts that should shape the specification

### Verification and recovery are delivery actions, not credential overrides

Arc XP's reset control sends a reset email. Better Auth's recommended mechanism does the same and
the repository already owns secure action URLs, mail transport, token redaction, and session
revocation after reset. The selected administrative behavior should therefore schedule a Reader- or
Administrator-realm message and report that scheduling outcome; it should never reveal the token or
let an Administrator choose the target's password.

Direct administrative verification is materially different: it bypasses proof of mailbox access.
Arc XP exposes it but explicitly discourages it. It needs a stronger, separately audited application
operation rather than being modeled as “resend succeeded.”

### Pending email is application state in this product

Better Auth's default change-email flow correctly delays promotion until verification, but the
pending target is encoded in its signed action token. That is sufficient for self-service completion
and insufficient for an administrative detail screen, replacement, cancellation, activity history,
or deterministic concurrency handling. A durable pending-email record is therefore not duplication
of a Better Auth user field; it is application workflow state.

### Disable and deletion request are distinct states

Arc XP presents reversible Active/Inactive separately from pending deletion. Better Auth offers a
reversible ban and an irreversible deletion, but no reviewed deletion request. The application must
not overload `banned` to mean both disabled and pending deletion without preserving why access is
suspended and what enabling/declining should restore.

A deletion request should suspend new and existing Reader access immediately according to the map,
but completion/anonymization/material deletion remains outside this effort.

### Activity and audit can share events, not purposes

Arc XP's Activity view is a customer-service history. The map additionally requires every
administrative action to be auditable. One durable, append-only event can support both if its schema
contains safe actor, target, realm, action, outcome/version, timestamp, and selected change metadata.
The Reader-facing activity response should be a redacted projection. Operational logs cannot serve
as this ledger because their retention, sampling, purpose, and PII policy differ.

### Per-session revocation needs an application selector

Better Auth stores and uses a session token as a bearer credential. Its Admin route accepts that
token directly. Publishing it to the Admin SPA would violate repository security boundaries. The
application must identify a session with a non-secret row ID or derived opaque handle and perform a
target-scoped delete server-side. Since IP and User-Agent are excluded, the product must decide what
minimal metadata makes two sessions distinguishable, likely creation and last-updated/expiry times.

## Recommended direction for subsequent decision tickets

These are recommendations, not established product facts:

1. Keep one realm-explicit administration service with separate Reader and Administrator lifecycle
   adapters. Every command carries the actor realm/ID and target realm/ID; no operation selects a
   realm from an email address.
2. Reuse Better Auth core verification/reset token handling and mail callbacks through the matching
   realm context. Do not reuse same-realm Admin plugin mutation routes as cross-realm APIs.
3. Own pending email, deletion requests, invitation state, lifecycle state, and the audit ledger in
   application tables. Treat Better Auth user/account/session rows as authentication mechanics, not
   the complete administrative domain model.
4. Implement lifecycle mutations and their audit event in one D1 transaction where available.
   Explicitly design failure behavior for session revocation and mail scheduling, which cannot all be
   one atomic transaction.
5. Keep direct verification exceptional and auditable. Keep reset/resend non-destructive and
   enumeration-safe. Keep unlink, disable, deletion request, session revocation, and Administrator
   supervision guarded by target-state preconditions.
6. Define the last-active-Administrator and no-self-disable rules in application-owned transactional
   commands. Better Auth's self-ban guard is insufficient and its plugin has no last-admin invariant.

## Newly visible fog

The research makes the following decision questions precise enough for the map's later decision
tickets. They do not require new tickets while the Wayfinder map is still decomposing the work:

- **Lifecycle precedence:** What state machine combines active, explicitly disabled, pending
  deletion, and declined deletion, and exactly which prior state is restored after decline?
- **Pending email ownership:** What durable record, uniqueness reservation, expiry, replacement, and
  compare-and-swap rule governs an address awaiting verification?
- **Viable login method:** Which Reader account rows count toward the “never unlink the last usable
  identity” invariant, especially a credential row without a usable password?
- **Single-session identity:** Which non-secret fields and opaque selector let an Administrator
  distinguish and revoke one Reader session while IP and User-Agent remain excluded?
- **Administrator invitation:** Does invite creation reserve/create the Administrator identity, and
  what acceptance credential proves control without an Administrator-selected password?
- **Audit atomicity and redaction:** Which event fields are mandatory, which changes may include
  redacted old/new values, and how are mail/session side-effect failures represented without tokens,
  email bodies, IP, or User-Agent?

None of these questions changes the selected scope, and no additional issue was created by this
research.

## Answer

Arc XP validates the selected observable capability set for Reader administration: force or request
verification, send reset, maintain a pending email, list/unlink identities, reversible disable,
reviewed deletion request, lifecycle activity, and all-session revocation. It does not establish the
application's hidden contracts or concurrency rules. Its workforce-user documentation provides only
an analogy for Administrator activation and reversible supervision because those users are owned by
an external IdP.

Better Auth 1.7.12 supplies useful authentication primitives for verification/reset, delayed email
promotion, linked accounts, bans, and session deletion. It does not supply pending-email query state,
a deletion-request workflow, invitation acceptance, a durable audit/activity ledger, or the
last-active-Administrator invariant. Most importantly, its Admin plugin is same-realm. Under
ADR-0014 it cannot administer Readers from an Administrator session, and invoking the existing
Administrator context would mutate `admin_*` records.

Therefore reuse Better Auth only behind realm-specific application adapters where its primitive
matches the operation. Own cross-realm authorization, workflow state, safe projections, lifecycle
invariants, concurrency, and audit in the application. Reader and Administrator commands must remain
separate even when they share implementation mechanics.
