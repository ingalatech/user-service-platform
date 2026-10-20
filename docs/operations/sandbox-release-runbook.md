# Sandbox release, rollback, and recovery runbook

Operates the verified-email identity service in sandbox and promotes it to
production (tickets #14, #78, ADR-0008, ADR-0009, ADR-0010). Written so a
maintainer other than the original author can provision sandbox, deploy,
inspect failures, roll back Worker code, and initiate D1 recovery.

Canonical environments are **local / sandbox / production**. Any historical
`staging` reference elsewhere in planning history means `sandbox`.
Application code still accepts the legacy `staging` `ENVIRONMENT` value as a
sandbox context, but deployment tooling uses `sandbox` only and never offers
`staging` as a selection.

## 1. Isolation model

Each deployment target owns a company slug, a site slug, the service slug and
a canonical environment. The canonical deployment key is
`<company>-<site>-<service>-<environment>`; the site is part of the isolation
boundary because one company may own multiple sites with fully separate
login/session/user stores. Physical Cloudflare resource names derive from
that key with explicit suffixes, while application binding names stay short
and stable.

First target (`rch-rugbychampagne` in `deploy/targets.json`):

| Resource | Sandbox                                      | Production                                      |
| -------- | -------------------------------------------- | ----------------------------------------------- |
| Worker   | `rch-rugbychampagne-user-service-sandbox`    | `rch-rugbychampagne-user-service-production`    |
| D1       | `rch-rugbychampagne-user-service-sandbox-db` | `rch-rugbychampagne-user-service-production-db` |
| Binding  | `DB`                                         | `DB`                                            |

Targets must never share:

- D1 databases (per company + site + environment);
- R2 buckets (when user files land; relational rows stay in D1, binaries in
  object storage per ADR-0003);
- secrets (`BETTER_AUTH_SECRET`, `RESEND_API_KEY`, provider credentials);
- routes/domains and environment-specific vars (notably `AUTH_MAIL_ALLOWLIST`).

`wrangler.jsonc` is the version-controlled **local base config only** and
contains **no secrets** and no remote `env` sections: remote deploys go
through `npm run deploy` (ticket #78), which selects a target from the
versioned secret-free `deploy/targets.json` and materializes a temporary
target-specific Wrangler config (removed after the deployment, even on
failure). Worker secrets remain configured directly in Cloudflare for the
selected target Worker (section 2); GitHub Actions has no Cloudflare
credentials.

## 2. First-time target provisioning

Prerequisites: a Cloudflare account with Workers Paid (D1 Time Travel
retention beyond Free), an account ID configured for the selected target and
environment, Wrangler OAuth login (default) or an optional local
`CLOUDFLARE_API_TOKEN`, and a mail-provider-authorized sender for the target.

Cloudflare account IDs are non-secret 32-character hexadecimal identifiers.
Set each target/environment's `accountId` in `deploy/targets.json` for the
team default. To use a personal account without changing shared configuration,
copy the sample and edit only the desired environment:

```bash
cp deploy/targets.local.example.json deploy/targets.local.json
```

`deploy/targets.local.json` is git-ignored. Resolution precedence is
versioned `deploy/targets.json`, then the matching local override, then
`CLOUDFLARE_ACCOUNT_ID` from the current process (highest precedence). The
selected ID is materialized as Wrangler `account_id` and supplied to every
Wrangler/provisioning executor call. Never put `CLOUDFLARE_API_TOKEN` or any
other credential in either target file. The example IDs are placeholders, not
usable Cloudflare accounts.

Provisioning is owned by one repository entry point (ticket #80), which
derives physical resource names from the canonical deployment key so the
operator never invents Cloudflare resource names. Dependency provisioning
stays separate from application deployment: provisioning discovers or
creates the target D1 database and reports Worker/secret state, while only
the normal `npm run deploy` creates/publishes the Worker.

```bash
# 1. Preview first-time provisioning for the target (read-only; the default
#    --plan mode performs no remote mutation). Planning production is also
#    read-only and needs no confirmation.
npm run provision -- --target rch-rugbychampagne --env sandbox --plan

# 2. Provision the target sandbox dependencies. For an unprovisioned target
#    this creates the client-scoped database
#    rch-rugbychampagne-user-service-sandbox-db (never shared across
#    companies, sites or environments) and stages its non-secret database_id
#    in deploy/targets.json. A rerun after any partial failure rediscovers
#    the exact-name resource and converges without duplicate creation.
npm run provision -- --target rch-rugbychampagne --env sandbox --apply

# 3. Review the staged non-secret database id, then commit it. Database ids
#    are not secrets and are version controlled. The deployer refuses to run
#    while the slot is empty or a placeholder. Provisioning never commits or
#    pushes automatically.
git diff -- deploy/targets.json

# 4. Materialize the target config (no remote mutation; also used for every
#    targeted wrangler command below).
npm run deploy -- --target rch-rugbychampagne --env sandbox \
  --write-config /tmp/rch-sandbox.json

# 5. Set sandbox secrets against the target Worker (never commit these; never
#    reuse production values; never copy them from local files — type or paste
#    each value at the prompt). The RCH sandbox selects the SMTP transport
#    (ticket #88), so it needs the SMTP credential pair, not a Resend key.
#    `SMTP_USER` is the Gmail address and `SMTP_PASSWORD` is a Google App
#    Password, never the normal Google password. Provisioning prints the
#    exact per-secret operator commands but never handles secret values:
npx wrangler secret put BETTER_AUTH_SECRET --config /tmp/rch-sandbox.json
npx wrangler secret put SMTP_USER --config /tmp/rch-sandbox.json
npx wrangler secret put SMTP_PASSWORD --config /tmp/rch-sandbox.json

# 6. Confirm preflight passes without mutating anything.
npm run deploy -- --target rch-rugbychampagne --env sandbox --dry-run
```

Provisioning reports when the Worker is not deployed yet; that is expected
for a new target and is not an error. The first normal deploy must be
interactive:

```bash
npm run deploy -- --target rch-rugbychampagne --env sandbox
```

It explains the unavoidable activation and requires the exact confirmation
`FIRST DEPLOY rch-rugbychampagne-user-service-sandbox` before it
creates/publishes the Worker. Do not use `--non-interactive` for the first
deployment; it fails closed because no inactive first version is possible.
When the Worker already exists,
provisioning additionally reports each required secret name as
present/missing (names/types only, never values).

Production provisioning follows the same flow with an explicit human guard:
production `--apply` requires `--confirm` equal to the exact target Worker
name and cannot happen as a side effect of sandbox:

```bash
npm run provision -- --target rch-rugbychampagne --env production --plan
npm run provision -- --target rch-rugbychampagne --env production --apply \
  --confirm rch-rugbychampagne-user-service-production
```

If the provisioning command cannot safely complete a step (ambiguous
discovery, a configured D1 ID absent from the selected account, a configured
ID that disagrees with the remote exact-name resource, or an unreachable
provider), it fails closed and prints the exact
next operator action. The manual fallback for D1 creation is:

```bash
export CLOUDFLARE_ACCOUNT_ID="<selected-32-hex-account-id>"
npx wrangler d1 create \
  rch-rugbychampagne-user-service-sandbox-db --update-config=false
# Creation prints human-readable text (pinned Wrangler has no --json flag for
# this command) and never touches versioned config. Rerun provisioning to
# rediscover the exact-name database and stage its id, then commit:
# npm run provision -- --target rch-rugbychampagne --env sandbox --apply
```

Sandbox non-secret mail values are versioned per target in
`deploy/targets.json` (RCH sandbox, tickets #88/#119/#121:
`AUTH_MAIL_TRANSPORT=smtp`, `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`,
`SMTP_SECURE=false`, `AUTH_MAIL_FROM=User Service <jonatangarbuyo@gmail.com>`,
`AUTH_MAIL_ALLOWLIST=jonatangarbuyo@gmail.com,cronistadev@gmail.com,ingaladev@gmail.com`). Gmail
submission is represented only through these ordinary provider-neutral SMTP
settings; there is no Gmail-specific application branch. `AUTH_MAIL_FROM` must
correspond to a sender authorized by the selected mail provider, and the
RCH sandbox sender/allowlist no longer depend on `ingalatech.com`. The
allowlist holds exactly three recipients: the stable automated smoke
recipient `jonatangarbuyo@gmail.com`, the regular manual register/verify/reset
QA mailbox `cronistadev@gmail.com`, and the administrator QA mailbox
`ingaladev@gmail.com`. The SMTP credentials (`SMTP_USER`/`SMTP_PASSWORD`)
stay runtime secrets configured directly on the Worker and never enter
versioned config.

Local operator credentials and values (not GitHub repository secrets):

| Setting                      | Purpose                                                                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`       | Optional local Wrangler authentication for deploys and D1 migration applies                                                                   |
| `CLOUDFLARE_ACCOUNT_ID`      | Account scope for local Wrangler operations                                                                                                   |
| `SANDBOX_BASE_URL`           | Local smoke-test origin                                                                                                                       |
| `SANDBOX_SMOKE_EMAIL`        | Explicit allowlisted recipient for local smoke registrations (ticket #87)                                                                     |
| `SANDBOX_SMOKE_EMAIL_DOMAIN` | Sandbox-allowlisted domain for local smoke registrations (domain fallback)                                                                    |
| `SANDBOX_SMOKE_PASSWORD`     | Stable operator-owned smoke credential for exact-recipient mode (ticket #91; wired as `SMOKE_PASSWORD` at runtime, never committed or logged) |

When the sandbox `AUTH_MAIL_ALLOWLIST` holds exact emails rather than a
domain (RCH sandbox: `jonatangarbuyo@gmail.com` for stable automated smoke,
`cronistadev@gmail.com` for regular manual register/verify/reset QA, and
`ingaladev@gmail.com` for administrator QA), configure
`SANDBOX_SMOKE_EMAIL` with the stable smoke recipient
(`jonatangarbuyo@gmail.com`) only. The smoke then registers that address
directly (`SMOKE_SANDBOX_EMAIL` at runtime) instead of generating a per-run
domain address. Keep the allowlist limited to these three exact recipients.
Never broaden `AUTH_MAIL_ALLOWLIST` merely to make the smoke pass.

Sandbox mail must stay allowlisted: `AUTH_MAIL_ALLOWLIST` covers only
operator/test domains, and any delivery outside it is skipped with
`auth-mail.sandbox-skipped` telemetry before reaching the provider
(ADR-0010). The allowlist guard applies to both the Resend and SMTP
transports. The concrete transport is deployment configuration
(`AUTH_MAIL_TRANSPORT=resend` or `smtp` with provider-neutral
`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE` plus `SMTP_USER`/`SMTP_PASSWORD`
secrets); switching transports never changes Identity semantics, templates,
or public contracts (ticket #58).

### 2.1 Cleaning up obsolete bootstrap resources

The first provisioning pass created a temporary generic D1 database
`user-service-sandbox` (id `d37249ce-90cc-4e86-b7a3-36d2f9d1ed02`) and a
generic `user-service-sandbox` Worker name. Those generic names are not the
multi-client convention and must be removed after the target-specific
deployment succeeds:

```bash
# Only after the RCH sandbox deployment + smoke test pass (section 3.1):
# 1. Confirm the serving target deployment.
npm run deploy -- --target rch-rugbychampagne --env sandbox \
  --write-config /tmp/rch-sandbox.json
npx wrangler deployments list --config /tmp/rch-sandbox.json
npm run smoke:sandbox

# 2. Delete the obsolete bootstrap database (it never served traffic).
npx wrangler d1 delete user-service-sandbox

# 3. Remove the obsolete generic Worker (dashboard or CLI) once nothing
#    references its workers.dev origin.
```

## 3. Local candidate release procedure

### 3.1 Sandbox release (local operator action)

GitHub Actions does not deploy sandbox. Releases are operator initiated from a
developer workstation in the isolated release worktree. Use the local
Wrangler OAuth login by default; `CLOUDFLARE_API_TOKEN` is optional and must
remain in the local process environment, never in repository configuration.
`npm run deploy` validates and applies compatible D1 migrations, then uploads
an immutable Worker Version for an existing Worker without changing traffic.
The upload message carries the source commit, branch and UTC upload time. Use
the version preview URL shown by Wrangler to inspect service behavior before
promotion.

```bash
npm run deploy -- --target rch-rugbychampagne --env sandbox
npx wrangler versions list --name rch-rugbychampagne-user-service-sandbox
npm run promote -- --target rch-rugbychampagne --env sandbox
```

The first Worker Version is the unavoidable exception: Cloudflare activates it
immediately. The deploy command explains this and requires the exact text
`FIRST DEPLOY <worker-name>` before making that initial mutation. Promotion
selects an existing immutable Version ID and routes 100% of traffic to it; it
does not build assets, apply D1 migrations, or create a Worker Version. Sandbox
candidate upload does not run stable-origin smoke because the stable origin
still serves the previous version. Promotion runs `npm run smoke:sandbox`
against the stable origin after routing the selected version. The first deploy
retains its stable-origin smoke after the unavoidable activation. For
production, enter the exact production Worker name when prompted. Worker
rollback does not roll back D1; use the data recovery procedure in section 5
only when a separate, explicitly confirmed database recovery is needed.

Keep account identifiers in non-secret target configuration where available;
Cloudflare credentials remain in Wrangler OAuth or the local
`CLOUDFLARE_API_TOKEN` process environment and never enter version control.

### 3.2 Worker code rollback (code only, never data)

A Worker rollback reverts code/configuration to a prior version. It does
**not** revert D1 or R2 state (ADR-0008). Roll back only onto a migration
state the old code understands; migrations must stay compatible with at
least the immediately preceding Worker version (section 4).

```bash
# Materialize the target config, list versions, then roll back sandbox code
# to a known-good version.
npm run deploy -- --target rch-rugbychampagne --env sandbox \
  --write-config /tmp/rch-sandbox.json
npx wrangler deployments list --config /tmp/rch-sandbox.json
npx wrangler rollback --config /tmp/rch-sandbox.json
```

After rollback, re-run the smoke test (section 6) and confirm the
`email-verification-required` gate still behaves; a rollback that meets a
newer data shape can produce errors instead of silently succeeding.

### 3.3 Production promotion (explicit, human-controlled)

Production is never deployed by merging, by a GitHub Actions trigger, or by
the sandbox workflow. Promotion is an explicit local operator action. Select
the target and provide the exact production Worker name (for example
`rch-rugbychampagne-user-service-production`) as confirmation. The promoter
enforces that confirmation before any remote mutation:

```bash
npm run promote -- --target rch-rugbychampagne --env production \
  --confirm rch-rugbychampagne-user-service-production
```

Promotion applies no migrations and does not build or upload a version. Record
the selected immutable Version ID and source commit in the release notes. After
promotion, it runs the non-mutating production smoke: `GET /v1/health` must
return `{ "status": "ok" }`, and anonymous `GET /v1/me` must return `401`
with `unauthenticated`. Set `SMOKE_PRODUCTION_BASE_URL` to the production
Worker origin before promotion. This smoke performs no registration, email,
login or other user mutation.

## 4. D1 migrations

Migrations live versioned under `./drizzle` (generated by
`npm run db:generate` from `src/features/identity/schema.ts`) and are
consumed unchanged by local tests, sandbox, and production
(`migrations_dir: drizzle` in the base config; every materialized target
config carries the absolute repository path to that same `./drizzle` source
so temporary configs resolve correctly).

```bash
# Materialize the target config once per session.
npm run deploy -- --target rch-rugbychampagne --env sandbox \
  --write-config /tmp/rch-sandbox.json

# Inspect what would apply.
npx wrangler d1 migrations list DB --remote --config /tmp/rch-sandbox.json

# Validate against disposable local state before merge (also runs in the
# deployer and in CI).
npx wrangler d1 migrations apply DB --local

# Apply to the target only as an explicit local operator action.
npx wrangler d1 migrations apply DB --remote --config /tmp/rch-sandbox.json
```

Schema evolution follows **expand -> deploy -> contract** whenever rollback
compatibility could matter:

1. add backward-compatible schema first (new nullable columns/tables);
2. deploy code that operates with the expanded schema;
3. remove obsolete fields/constraints only in a later release, after no
   serving Worker version depends on them.

Never couple a destructive migration to the code release that stops using
the old shape. CI applies the same `./drizzle` files to the isolated test
database, so a migration that breaks the identity flow fails before merge.

## 5. D1 Time Travel recovery

D1 Time Travel is the emergency point-in-time data-recovery mechanism. Restore
is destructive to the target database, so it requires explicit operator
confirmation and a recorded restore point.

```bash
# 1. Identify the restore point (bookmark id) preceding the incident.
#    See https://developers.cloudflare.com/d1/reference/time-travel/
npx wrangler d1 time-travel info rch-rugbychampagne-user-service-sandbox-db

# 2. Confirm the incident scope, the bookmark, and that the sandbox database
#    (not production) is the target. Get a second maintainer to acknowledge
#    for production restores.

# 3. Restore the target database to the bookmark.
npx wrangler d1 time-travel restore rch-rugbychampagne-user-service-sandbox-db --bookmark <bookmark-id>

# 4. Verify: re-run the smoke test (section 6) and inspect logs/traces for
#    the affected request ids (section 7).
```

Notes:

- Retention is 30 days on Workers Paid and shorter on Free; sandbox
  incidents older than retention need the export/archive path, which is
  deferred until retention requirements demand it (ADR-0008).
- Restoring data does not roll back Worker code; if the incident involved a
  schema change, align the serving Worker version with the restored shape
  first (section 3.2).
- Production restores additionally require the release record (source commit
  - deployment id, section 3.3) so the post-restore state is attributable.

## 6. Sandbox smoke test

Recipient selection (ticket #87):

- **Exact-recipient mode** — set `SMOKE_SANDBOX_EMAIL` to one explicit
  allowlisted recipient. The smoke registers that address directly; nothing is
  generated or inferred, and the address is never logged. Use this mode when
  the sandbox `AUTH_MAIL_ALLOWLIST` holds exact emails (RCH sandbox).
- **Domain-generated mode** — set `SMOKE_SANDBOX_EMAIL_DOMAIN` to a
  sandbox-allowlisted domain. Each run registers a unique
  `smoke-<run-id>@<domain>` address. Retained as the fallback when no exact
  recipient is configured.

When `SMOKE_SANDBOX_EMAIL` is set it takes precedence; an invalid value fails
closed instead of falling back to domain mode. Either variable must cover an
address the sandbox mail guard will actually deliver — otherwise the smoke
proves the verification gate but cannot prove externally delivered
transactional mail.

```bash
export SMOKE_SANDBOX_BASE_URL="https://rch-rugbychampagne-user-service-sandbox.jonatangarbuyo.workers.dev"
# Exact-recipient mode (RCH sandbox allowlist holds the stable automated
# smoke recipient, the regular manual QA mailbox, and the administrator QA
# mailbox; the smoke keeps using the stable recipient only):
export SMOKE_SANDBOX_EMAIL="jonatangarbuyo@gmail.com"  # stable smoke recipient only
# Exact-recipient mode requires a stable operator-owned credential (never
# committed or logged; provide it locally):
export SMOKE_PASSWORD="<operator-owned-sandbox-smoke-password>"
# Domain-generated fallback (only when no exact recipient is configured):
# export SMOKE_SANDBOX_EMAIL_DOMAIN="ops.example.org"  # sandbox-allowlisted only
# Optional: complete the full verify -> sign-in path with a token pasted from
# the stable smoke mailbox while reusing the same SMOKE_PASSWORD. Without it
# the smoke proves the verification gate. The regular manual QA mailbox
# (cronistadev@gmail.com) and the administrator QA mailbox
# (ingaladev@gmail.com) are reserved for manual QA and are never used by the
# automated smoke.
export SMOKE_VERIFICATION_TOKEN="<token-from-allowlisted-mailbox>"
npm run smoke:sandbox
```

### 6.1 Exact-recipient repeatability (ticket #91)

Exact-recipient smoke is repeatable against the same persistent sandbox D1
without a fresh database and without a new recipient. Routine smoke behavior
stays at the public application HTTP boundary: no D1 SQL, no sandbox-only
application endpoint, no allowlist change, and no Gmail plus-address
rewriting. The same explicit address is used directly every run; nothing is
generated or inferred in exact mode.

Exact-recipient mode requires an explicit stable operator-owned smoke
credential (`SMOKE_PASSWORD`; provide it locally from the operator's secret
store, never commit or log it).
Domain-generated mode keeps a random per-run password. The smoke never
silently generates a credential in exact mode: a missing `SMOKE_PASSWORD`
fails closed before any HTTP request.

The sandbox D1 keeps the same mailbox identity across deploys, so the smoke
models the persisted login state explicitly instead of assuming freshness:

- **Fresh (`pass-fresh`)** — the stable credential matches an unverified
  identity. The smoke proves health, anonymous `GET /v1/me` (`401`),
  registration (`201`, unverified), the verification gate (`403
email-verification-required`), resend accepted (`202`), and — with the
  token — the full verify -> sign-in -> authenticated `GET /v1/me` path.
  This is the one-time full acceptance.
- **`already-verified` (`pass-already-verified`)** — the stable credential
  matches an already-verified identity (repeat after a prior token
  verification). The smoke proves session (`200` login plus `200` me) and
  resend acceptance without claiming a fresh gate.
- **Credential mismatch (fail closed)** — `401 invalid-credentials` means
  the configured smoke credential does not own the persisted identity. The
  smoke fails closed rather than reporting a pass; a credential collision is
  never masked as a successful smoke.

Any other login outcome fails closed. Domain-generated mode is unchanged:
each run registers a unique address and still requires the fresh gate.

Two-step human acceptance for the exact recipient: first run with the stable
credential sends the real email; after receiving the token, rerun the smoke
with the **same** `SMOKE_PASSWORD` plus `SMOKE_VERIFICATION_TOKEN` to prove
verify -> login -> authenticated `GET /v1/me`. Later repeats with the same
stable credential remain `pass-fresh` while unverified and
`pass-already-verified` after the one-time verification.

The smoke verifies, in order: `GET /v1/health`, anonymous `GET /v1/me`
(`401 unauthenticated`), registration (`201`, unverified), the classified
login state above, resend accepted (`202`), and — on the fresh path with
the token — verification, sign-in, and authenticated `GET /v1/me` (`200`).
It refuses invalid exact recipients and non-sandbox domain recipients,
non-HTTP(S) targets, and localhost (unless `SMOKE_ALLOW_LOCALHOST=true`),
and logs only method, path, status, and stable problem codes — never the
recipient address. Run it after every sandbox deploy, Worker rollback, and
D1 recovery.

## 7. Logs, traces, and metrics

Cloudflare-native observability is the baseline (ADR-0009), enabled via the
top-level `observability.enabled` flag in `wrangler.jsonc` (inherited by
every materialized target config):

- **Logs**: materialize the target config (`--write-config`), then
  `npx wrangler tail --config /tmp/rch-sandbox.json` for live logs, or the
  Cloudflare dashboard Workers Logs for persisted queries. Correlate with
  the `requestId` field every application log record carries.
- **Traces**: automatic request traces in the dashboard show the Worker and
  binding/subrequest flow for a failing `requestId`.
- **Metrics**: Workers metrics cover request volume, error rate, CPU/wall
  time, and execution behavior; alerting/export beyond this needs an
  explicit OTLP decision, not feature-code changes.

Redaction rules (enforced by tests): application and mail logs carry
`requestId`, method, stable route, status, and stable problem codes only.
Credentials, cookies, session tokens, verification/reset tokens and action
URLs, email bodies, and provider secrets must never appear. Query strings
are not logged by application code.

## 8. Secret rotation

```bash
# Materialize the target config, rotate without committing, redeploy, verify.
npm run deploy -- --target rch-rugbychampagne --env sandbox \
  --write-config /tmp/rch-sandbox.json
npx wrangler secret put BETTER_AUTH_SECRET --config /tmp/rch-sandbox.json
# RCH sandbox mail uses SMTP (ticket #88); production keeps its own provider
# credential. Rotate the credential matching the environment's transport:
npx wrangler secret put SMTP_USER --config /tmp/rch-sandbox.json
npx wrangler secret put SMTP_PASSWORD --config /tmp/rch-sandbox.json
npm run deploy -- --target rch-rugbychampagne --env sandbox --non-interactive
npm run smoke:sandbox
```

Rotate `BETTER_AUTH_SECRET` and the environment's mail credential
(`SMTP_USER`/`SMTP_PASSWORD` for the RCH sandbox, `RESEND_API_KEY` where a
deployment selects Resend) independently; sandbox and
production values are distinct and rotated separately. After rotation,
confirm the smoke passes and that `auth-mail.failed` telemetry does not
spike for the allowlisted recipient.

## 9. Post-deploy and post-recovery verification

After any deploy, rollback, migration, or restore:

1. `npx wrangler deployments list --config /tmp/rch-sandbox.json` identifies
   the serving version;
2. `npm run smoke:sandbox` proves health plus the verified-email gate;
3. Workers Logs/traces for the smoke `requestId`s show no `error` records
   and no redaction violations;
4. `npx wrangler d1 migrations list DB --remote --config /tmp/rch-sandbox.json`
   shows no unapplied migrations.
