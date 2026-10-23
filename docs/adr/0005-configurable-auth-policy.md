# ADR-0005: Define a configurable authentication policy above Better Auth

## Status

Accepted.

## Context

The service uses Better Auth for identity and session mechanics, but it is intended to remain an extensible User Service rather than expose Better Auth configuration as its public architecture.

PocketBase provides useful product inspiration here: authentication methods, verification requirements, token lifetimes and related behaviours are configurable capabilities rather than assumptions scattered through application code.

The initial deployment requires email verification before a user may authenticate. The service should be reusable for future clients, where this policy may differ.

## Decision

Define an application-owned `AuthPolicy` configuration that is resolved at deployment/configuration time and translated into Better Auth configuration by the identity infrastructure layer.

The initial policy supports these capabilities:

- public registration can be enabled or disabled;
- email/password authentication can be enabled or disabled;
- email verification can be required before successful login;
- password reset is supported when email/password auth is enabled;
- email change must be verified before replacing the canonical email address;
- OAuth support is available, with enabled providers supplied by deployment configuration;
- session lifetime and relevant auth-token lifetimes are configuration-owned values rather than constants hidden inside feature code.
- password creation requirements (length and Unicode character-category counts) are deployment-owned and publicly discoverable through the application-owned auth configuration contract. Existing passwords are not revalidated during login.

For the first deployment, `requireEmailVerification` is enabled.

Business feature slices consume a stable authenticated-user/session boundary owned by this service. They must not import Better Auth table models, provider-specific types, or internal session representations.

Better Auth hooks/plugins may extend authentication lifecycle behaviour, but business capabilities such as subscriptions, follows, bookmarks, profiles and audiences remain outside Better Auth extensions.

## Deferred capabilities

The policy model should be extendable later, but the initial implementation does not need to ship:

- OTP/passwordless authentication;
- MFA;
- passkeys;
- new-device authentication alerts;
- per-user authentication policy;
- internal operator/admin authentication.

These are future capabilities, not placeholders that must be implemented in the MVP.

## Consequences

- Auth behaviour is configurable per deployment/client without coupling the domain to Better Auth.
- The default deployment can require verified email while another future deployment may choose a different policy.
- Feature slices depend on a small `AuthenticatedUser`/`SessionContext` contract rather than Better Auth internals.
- Changing auth providers or replacing Better Auth remains materially easier than if its types/configuration leaked through the application.
- Transactional email delivery becomes a separate infrastructure decision because verification, reset and email-change flows require outbound email.
- Consumer applications can discover the effective password policy without receiving secrets or Better Auth configuration; administrative editing of that deployment policy remains a separate follow-up.

## Decision record

Wayfinder decision: https://github.com/JonatanGarbuyo/user-service-platform/issues/3
