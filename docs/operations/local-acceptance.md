# Local Identity release acceptance

Proves the complete first Identity release end to end on localhost before the
commit is eligible for sandbox promotion (ticket #60, spec #8). The run starts
from an explicitly reset local D1 database, serves the real Worker under
Wrangler/workerd with the canonical `local` environment configuration, and
exercises the delivered Identity journeys through the public HTTP boundary
with a real configured transactional-mail transport (SMTP or Resend).

Automated suites stay deterministic and credential-free on the in-memory
transport; this operational acceptance is distinct from ordinary CI tests and
never runs there. Real external delivery is a human-operated gate, not a CI
step.

## Prerequisites

From a clean clone, with your own local provider credentials:

```bash
nvm use
npm ci
cp .env.example .env
```

Select one real transport in the ignored root `.env` (never commit secrets):

```bash
# SMTP (provider-neutral: Gmail, Amazon SES SMTP, Exchange, client SMTP):
AUTH_MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mailer@example.com
SMTP_PASSWORD=<local-only secret>
AUTH_MAIL_FROM=User Service <noreply@example.com>
AUTH_MAIL_ALLOWLIST=@example.com
# or Resend:
# AUTH_MAIL_TRANSPORT=resend
# RESEND_API_KEY=<local-only secret>
# AUTH_MAIL_FROM=User Service <noreply@example.com>
# AUTH_MAIL_ALLOWLIST=@example.com
```

The allowlist must cover the acceptance address: non-production deliveries
outside it are skipped before reaching the provider for both transports.
Port 25 is rejected on Workers; TLS certificate verification cannot be
disabled through supported configuration.

## 1. Reset to an empty local state

```bash
npm run db:local:reset
```

This deletes only Wrangler's persisted local D1 state under `.wrangler/` and
reapplies the canonical versioned `./drizzle` migrations to an empty
database. It takes no remote flags, so sandbox/production databases cannot be
affected.

## 2. Start the Worker through the normal local path

```bash
npm run dev:local
```

This runs `wrangler dev --env-file .env` with the canonical `local`
environment configuration and ignored local secrets/overrides. Leave the
Worker running; every step below goes through its public HTTP boundary
(`http://localhost:8787` by default).

## 3. Run the acceptance runner

In a second terminal, with the Worker still running, supply the acceptance
identity, its password rotation, and the first-admin inputs. Run the command
once from the freshly reset state: the runner pauses mid-run and prompts for
each delivered token, so both tokens must not be supplied upfront (neither
exists until this run's emails arrive).

```bash
ACCEPTANCE_EMAIL="acceptance@example.com" \
  ACCEPTANCE_PASSWORD="correct-horse-60" \
  ACCEPTANCE_NEW_PASSWORD="correct-horse-61" \
  ADMIN_NAME="Site Admin" ADMIN_EMAIL="admin@example.com" \
  ADMIN_PASSWORD="correct-horse-41" \
  npm run acceptance:local
```

`npm run acceptance:local` (`scripts/local-acceptance.ts`) refuses any
non-localhost target, so these real credentials and email-action tokens
cannot be sent to a deployment from this runner.

For a non-interactive run, `ACCEPTANCE_VERIFICATION_TOKEN` and/or
`ACCEPTANCE_RESET_TOKEN` may be pre-supplied in the environment; each
pre-supplied token skips its corresponding mid-run prompt.

## 4. Human email interaction (explicit, never bypassed)

The runner does not read test-only transport state and never mutates the
database directly. A single run completes both mail flows without restarting:
when the runner reaches each mail stage it pauses and prompts for the
corresponding token variable.

1. When the runner prompts for `ACCEPTANCE_VERIFICATION_TOKEN`, open the
   verification email delivered to `ACCEPTANCE_EMAIL` through your selected
   transport.
2. Extract the `token` query parameter from the verification action URL and
   paste it at the prompt; terminal echo stays disabled while pasting, so the
   token contents never appear in the visible transcript. The runner continues
   through sign-in, sign-out, and password recovery.
3. When the runner prompts for `ACCEPTANCE_RESET_TOKEN`, repeat the same
   interaction with the reset email (also with hidden input).

Registration and password recovery each produce a real message through the
selected transport; verification and reset complete through the real
`POST /v1/auth/verify-email` and `POST /v1/auth/reset-password` flow.

## 5. Stage order and expected outcomes

Sections 1–2 are operator-executed prerequisites (reset/migrations/boot)
evidenced via the retained transcript. The runner executes and records, in
order:

1. `health` — `GET /v1/health` returns `200 {status:"ok"}`.
2. `me-anonymous` — anonymous `GET /v1/me` returns `401 unauthenticated`.
3. `register` — `POST /v1/auth/register` returns `201` unverified and sends
   the real verification email.
4. `login-unverified` — email/password login is rejected with
   `403 email-verification-required` while the policy requires verified
   email.
5. `verify-email` — the delivered verification action completes through the
   real flow.
6. `login-verified` — the verified User signs in and establishes a session.
7. `me-authenticated` — `GET /v1/me` returns the expected application-owned
   identity for that session.
8. `sign-out` — sign-out succeeds and the session stops resolving
   (`me-after-sign-out` returns `401`).
9. `request-password-reset` — recovery returns identical `202` for the known
   and an unknown address (no enumeration leakage) and sends the real reset
   email.
10. `reset-password` — the delivered reset action completes through the real
    flow.
11. `login-old-rejected` — the old password returns `401
invalid-credentials`.
12. `login-new` — the new password establishes a session.
13. `admin-bootstrap` — `POST /v1/admin/auth/bootstrap` against the same
    fresh environment returns `201` with the application-owned admin
    representation (`role: "admin"`).

The bootstrap operation uses explicit operator inputs; no migration seeds
credentials and the repository defines no default admin password. Repeats or
conflicting identities fail with explicit machine codes instead of
duplicating privileged accounts.

## 6. Evidence and promotion eligibility

The runner logs one JSON line per stage (method, path, status, stable
`pass`/problem-code outcome) plus a final `acceptance-summary` record with
the exact tested commit (`git rev-parse HEAD`), the selected transport by
name, per-stage outcomes (stage name, HTTP status, and stable outcome), and
`eligibility: eligible | ineligible`. The transport name resolves from the
runner environment, falling back to the documented ignored root `.env` (the
same file `npm run dev:local` loads), so the documented command records
`smtp` or `resend` without extra environment duplication; it is recorded by
name only and every other entry from that file is discarded — no secret is
ever retained or logged. The machine `acceptance-summary`
covers exactly the runner stages listed in section 5. Keep the full terminal
transcript — including the `db:local:reset` completion output and the Worker
boot log — as the evidence record: together they show the
reset/migrations/boot prerequisites and whether each runner stage passed.

No passwords, provider credentials, cookies, session tokens,
verification/reset tokens, action URLs, or message bodies appear in ordinary
logs or committed evidence.

Failure at any stage marks the commit `ineligible` for sandbox promotion;
there is no partial-success interpretation. A passing run plus green quality
gates (below) makes the exact tested commit the sandbox promotion candidate;
sandbox changes only environment-specific configuration, resources, and
secrets.

## 7. Confirm the gates

```bash
npm run check        # lint + formatting
npm run typecheck
npm test             # Workers-runtime suite (config, identity, contracts)
npm run test:harness # whole-Worker harness + Node suite
npm run openapi:check # generated OpenAPI artifact has no drift
```

Real external mail delivery is never part of these gates.
