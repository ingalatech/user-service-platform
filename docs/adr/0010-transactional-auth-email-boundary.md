# ADR-0010: Isolate transactional auth email behind an application-owned mailer

## Status

Accepted.

## Context

Email verification is required before email/password login for the initial deployment. Better Auth requires application callbacks for verification and password-reset delivery, but the User Service must remain independent from any particular email provider.

## Decision

Better Auth email callbacks adapt into a purpose-specific application `AuthMailer`. The mailer exposes authentication intents such as email verification, password reset, and email-change confirmation rather than provider-specific message payloads.

Template selection and branding belong to the application/deployment configuration. A lower-level transport adapter owns the concrete provider or Cloudflare binding. Provider SDK types do not cross that adapter boundary.

Transactional sends are scheduled from Workers using the execution context (`waitUntil`) rather than awaited on the authentication request path. This follows Better Auth's guidance and avoids coupling response timing to account existence or provider latency.

The initial architecture does not introduce Cloudflare Queues solely for auth email. Delivery failures are recorded as structured operational events and verification/reset flows support explicit resend. Introduce a durable queue only if measured reliability, throttling, or retry requirements justify it.

Tests use an in-memory mail transport. Local and staging must not silently inherit production credentials; staging uses a sandbox/recipient allowlist. Production startup/configuration fails closed when a required real transport is missing.

Verification/reset URLs and tokens are secrets. They may appear only in the outbound message or isolated test sink, never in logs, analytics, generic events, or error payloads.

Email verification keeps an application-owned latest-token guard keyed by the
normalized target email. It stores only the SHA-256 token digest, expiry and
consumption metadata in D1. Better Auth remains the token signer/verifier;
the guard rejects superseded or reused tokens before/after the engine call and
never persists the plaintext token.

The recommended first production transport is Resend because it has a documented Workers integration and is a mature transactional provider. Cloudflare Email Service is an attractive native alternative but Email Sending remains Beta as of September 2026; provider substitution must not require changing auth/domain contracts.

## Consequences

- Email provider selection is infrastructure configuration, not an auth-domain decision.
- Authentication tests can assert email behavior without sending network email.
- Templates remain reusable/brandable per deployment.
- Provider outages do not expose account existence through synchronous timing differences.
- A future queue or Cloudflare-native email transport can be introduced behind the existing boundary.

## Research

See `docs/research/transactional-auth-email.md`.
