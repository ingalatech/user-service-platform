# Sandbox manual Identity acceptance — 2026-10-07

Operator-reported acceptance of the Identity foundation on the RCH sandbox
(ticket #121, spec #8). This record attributes the manual results to operator
reports dated 2026-10-07; it contains no passwords, tokens, cookies, account
ids, or private traces.

## Deployment under test

- Source commit: `3d19d915dc9fc00f87853fcab0dd46173b9d22cf` (main).
- Sandbox deploy run `37561376905`; serving Worker version
  `f30bb97c-f22a-440f-90d0-6438b8c3e7f8`; health check passed.
- Sandbox mail allowlist under test (versioned in `config/environments/.env.sandbox`):
  `jonatangarbuyo@gmail.com` (stable automated smoke),
  `cronistadev@gmail.com` (regular manual QA),
  `ingaladev@gmail.com` (administrator QA, added for first-administrator QA).

## Passed scenarios (operator-reported)

Health, anonymous `GET /v1/me` rejection, registration, verification gate
(login rejected before verification), delivered verification email, email
verification, login, authenticated `GET /v1/me`, password recovery request,
password reset, old-password rejection after reset, new-password login,
logout, post-logout session rejection, resend acceptance, expected errors
including invalid-email `400`, first-admin bootstrap creation, repeated
bootstrap `409 admin-already-bootstrapped`, and admin
verification/login/`me`.

## Resolved client-configuration note

The admin resend investigation is resolved as a client request-configuration
issue: an Insomnia pre-request script sent the regular QA address while the
visible request body used the administrator address. The corrected admin
flow passed. This was not a server SMTP defect, so no application test or
transport change records it.

## Pending separately (not acceptance-blocking for this record)

Post-deploy automated smoke fails with `401 invalid-credentials` for the
stable configured smoke identity. This is a separate operator-owned stable
smoke credential reconciliation and does not weaken the manual acceptance
above. The smoke identity, secrets, and accounts were not changed, hidden,
or reset by this ticket.
