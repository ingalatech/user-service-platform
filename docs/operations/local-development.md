# Local development runbook

Runs the verified-email Identity service from a clean local checkout without
depending on Cloudflare-hosted mutable resources (ticket #57, spec #8,
ADR-0008). Local persistence uses Wrangler/workerd local D1; no Dockerized
or standalone SQLite service is introduced. The same versioned `./drizzle`
migrations consumed by sandbox/production initialize local D1.

Canonical environments are **local / sandbox / production**. Never introduce
`staging` terminology into new configuration or documentation; the runtime
still accepts the legacy `staging` value as a sandbox context, but local
practice uses `local` only.

## 1. Configure local overrides and secrets

```bash
cp .env.example .env
```

`.env` lives at the repository root, is ignored by Git, and is loaded by
`npm run dev:local` (`wrangler dev --env-file .env`). Every `AUTH_*` name in
it is a local runtime variable. Remote sandbox and production commands read
only their complete files under `config/environments/`; they never read this
root file. Remote releases compile their non-secret profile through Wrangler's
bundle substitution instead of creating application `vars`. Sandbox/production
secrets are configured directly in Cloudflare and never belong in `.env`.

- Non-secret scenario toggles (for example `AUTH_REGISTRATION_ENABLED=false`)
  take effect on the next request; restart `wrangler dev` after editing.
- `BETTER_AUTH_SECRET` may stay empty locally (a documented dev-only value
  is used); sandbox/production fail closed without an explicit secret.
- The mail transport stays unset locally so the metadata-only development
  sink is used: no credentials, no network delivery. Real-delivery
  acceptance is owned by later tickets.

Invalid or incomplete effective configuration fails early with a redacted
configuration error (variable names and expected shapes only; values,
secrets, tokens and addresses are never echoed).

## 2. Persistent local-development path (ordinary restarts keep data)

Local D1 state persists under `.wrangler/` across restarts. From a fresh
clone:

```bash
npm run db:local:migrate
npm run dev:local
```

`db:local:migrate` applies the versioned migrations to local D1
(`wrangler d1 migrations apply DB --local`). It never takes `--remote` or
`--env`, so remote databases cannot be affected. Leave the Worker running
and iterate; local rows survive ordinary restarts until a reset is
requested.

## 3. Clean/reset path (reproducibility from an empty database)

```bash
npm run db:local:reset
npm run dev:local
```

`db:local:reset` (`scripts/reset-local-d1.ts`) deletes Wrangler's persisted
local D1 state and reapplies the versioned migrations to an empty database,
then the Worker starts against that fresh state. Only paths under the local
`.wrangler/` directory are removed; the script takes no remote flags. If a
previous `wrangler dev` is still running, stop that process first so the old
workerd does not keep serving on the same port.

## 4. Prove a clean boot through the real HTTP boundary

With the Worker running against fresh local D1:

```bash
curl -s http://localhost:8787/v1/health
# {"status":"ok", ...}

curl -s -i http://localhost:8787/v1/me
# HTTP/1.1 401 Unauthorized with an application/problem+json body whose
# machine code is "unauthenticated".
```

Both checks go through the real Worker HTTP boundary: health proves routing
and the composed application boot, while anonymous `/v1/me` proves the
unauthenticated identity boundary returns the stable RFC 9457 contract.
Authenticated and mail-delivery journeys are owned by the follow-up tickets
(#58 mail transports, #59 admin bootstrap, #60 full local acceptance).

To prove same-name local overrides work, set a single value in `.env` and
restart:

```bash
# in .env:
AUTH_REGISTRATION_ENABLED=false
```

```bash
curl -s -X POST http://localhost:8787/v1/auth/register \
  -H 'content-type: application/json' \
  -d '{"name":"Local Probe","email":"probe@example.com","password":"correct-horse-9"}'
# HTTP 403 with machine code "registration-disabled".
```

Remove the override (or restore `true`) and restart to return to the
profile defaults.

## 5. Real-delivery acceptance (SMTP or Resend)

The metadata-only sink above proves routing and contracts, not delivery.
Ticket #58 makes the local registration/verification and password-recovery
journeys runnable against a real transport through the running Worker. The
`AuthMailer` boundary, background-send behavior and redaction guarantees are
unchanged; only deployment configuration selects the concrete transport.

```bash
# in .env, either:
AUTH_MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=mailer@example.com
SMTP_PASSWORD=<local-only secret>
AUTH_MAIL_ALLOWLIST=<local test domain, e.g. @example.com>
# or:
AUTH_MAIL_TRANSPORT=resend
RESEND_API_KEY=<local-only secret>
AUTH_MAIL_ALLOWLIST=<local test domain, e.g. @example.com>
```

Non-production deliveries are allowlist-guarded for both transports, so the
allowlist must cover the local test address before anything is delivered.
The local default stays credential-free on the metadata-only development
sink; opt into real delivery only by setting the SMTP variables below in
the ignored root `.env`.

The current RCH sandbox acceptance uses Gmail submission through the same
provider-neutral SMTP variables (ticket #88). The equivalent optional local
real-mail setup selects the same transport with operator-owned credentials;
there is no Gmail-specific application branch:

```bash
# in .env, optional Gmail SMTP real-delivery acceptance only:
AUTH_MAIL_TRANSPORT=smtp
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=<local Gmail address>
SMTP_PASSWORD=<local-only Google App Password, never the normal password>
AUTH_MAIL_FROM="User Service <user@gmail.com>"
AUTH_MAIL_ALLOWLIST=<local Gmail address>
```

```bash
npm run dev:local
```

Then exercise the real journeys through the running Worker: register an
address the local transport may deliver to, open the verification action
received by email, sign in with the verified account, request password
recovery for the same address, open the reset action received by email, and
sign in with the new password. Automated tests never do this: they stay
credential-free on the in-memory transport, and the full scripted acceptance
(`npm run acceptance:local`, `docs/operations/local-acceptance.md`,
ticket #60) is the local release gate before sandbox promotion.

SMTP notes:

- Host, port, implicit-TLS (`SMTP_SECURE=true`, typically 465) versus
  STARTTLS (`SMTP_SECURE=false`, typically 587), credentials and sender
  identity are plain configuration; there are no provider-specific branches.
- Port 25 and malformed host/port/mode values fail closed with a redacted
  configuration error.
- TLS certificate verification is always enforced and cannot be disabled
  through supported application configuration.

## 6. Bootstrap the first administrator

With the Worker running against fresh local D1 (sections 2–3), create the
first administrative User through the auth engine (ticket #59, spec #8):

```bash
ADMIN_NAME="Site Admin" ADMIN_EMAIL="admin@example.com" \
  ADMIN_PASSWORD="correct-horse-41" npm run admin:bootstrap
```

`npm run admin:bootstrap` (`scripts/bootstrap-admin.ts`) posts explicit
operator inputs to `POST /v1/auth/admin/bootstrap` on the running Worker
(`ADMIN_BOOTSTRAP_BASE_URL`, default `http://localhost:8787`). The first
call succeeds with the application-owned admin representation
(`role: "admin"`); no migration seeds credentials and the repository defines
no default admin password. The bootstrapped administrator remains subject
to the deployment email-verification policy and completes verification
before signing in.

Bootstrap is intentionally independent of `AUTH_REGISTRATION_ENABLED`: a
closed deployment must still be able to provision its first administrator.
It does require email/password authentication to remain enabled because the
operator-supplied bootstrap credential uses that mechanism.

The operation is first-admin-wins: repeats or conflicting identities fail
with explicit machine codes (`admin-already-bootstrapped`,
`admin-email-conflict`, exit code 2) instead of duplicating privileged
accounts. The script logs only method, path, status and stable codes —
never names, addresses, passwords, tokens or action URLs.

## 7. Confirm the gates before handing off

```bash
npm run check        # lint + formatting
npm run typecheck
npm test             # Workers-runtime suite (config, identity, contracts)
npm run test:harness # whole-Worker harness + Node suite
npm run openapi:check # generated OpenAPI artifact has no drift
```

Real external mail delivery is never part of these gates: automated tests
use isolated/in-memory mail, and the full real-transport acceptance lives in
ticket #60.
