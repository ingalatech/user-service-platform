# Sandbox release runbook

## Sandbox release (local operator action)

Remote configuration is kept in `config/environments/.env.sandbox` and
`config/environments/.env.production`. Each file is complete, versioned and
contains no runtime secret. Deploy materializes the selected non-secret
application profile as Wrangler `define` data in the Worker bundle; it does
not upload plaintext application `vars`. The ignored root `.env` is local-only;
release commands never read it. Wrangler authentication and encrypted runtime
secrets remain operator-managed outside the repository.

## Bootstrap sandbox

1. Set the sandbox `CLOUDFLARE_ACCOUNT_ID` in `.env.sandbox`. The selected
   environment file is authoritative for the Worker, account, D1 names and all
   non-secret deployment values; the ignored root `.env` is not consulted.
2. Run `npm run provision -- --env sandbox --plan`.
3. Run `npm run provision -- --env sandbox --apply`.
4. Review the staged `D1_ID` diff in `.env.sandbox` and commit it.
5. Before the first remote rollout, build and dry-run the exact materialized
   candidate without uploading it:

   ```text
   nvm use
    npm run deploy -- --env sandbox --dry-run
   ```

   This uses the existing deploy dry-run. It runs the real preflight and
   read-only deployment plan without migrations, upload, deployment or smoke;
   it validates target selection and `keep_vars: false`, but not remote
   encrypted-secret presence or inheritance.

6. Run `npm run deploy -- --env sandbox` and confirm the first deployment.
7. Configure the runtime secrets in the Cloudflare Dashboard. Release tooling
   never lists, validates, uploads, prints or instructs CLI mutation of secrets.
   A same-name Dashboard binding for compiled application configuration is
   ignored by the Worker and produces a redacted warning; it cannot override
   the selected Git profile.
8. Run `npm run smoke:readiness` to verify public health and anonymous Identity.
   During the temporary Identity-unavailable window, only `/v1/health` is
   expected to pass. Record the resulting Worker version after Dashboard
   secret changes.
9. After readiness passes, perform the privileged manual acceptance with:
   `npm run smoke:sandbox`. This explicitly covers registration, login and
   email verification through the allowlisted QA mailbox. Supply its QA-only
   values (`SMOKE_SANDBOX_EMAIL`, `SMOKE_PASSWORD` and, when completing the
   mailbox transition, `SMOKE_VERIFICATION_TOKEN`) only for this manual smoke;
   they remain outside `deploy` and `promote`, and are never committed or
   placed in a release environment file.

For a single interactive acceptance, use:

```text
nvm use
npm run smoke:sandbox -- --interactive
```

Interactive mode reads the Worker URL and non-secret `AUTH_MAIL_ALLOWLIST`
policy from `config/environments/.env.sandbox`. It offers numbered recipient
choices without printing their addresses, validates the selected allowlisted
recipient, and reads the password and mailbox token with terminal echo
disabled. It runs registration, the verification gate, and the verification
request, pauses once for the operator to retrieve the token, then continues
verification, verified login, `/v1/me`, Reader State issuance, public sign-out,
and post-sign-out authorization checks in the same process. It requires a
TTY and fails clearly on cancellation. It never writes credentials or tokens
to environment variables, arguments, files, or logs. The existing environment
variable mode remains available for headless or automated use.

After either a fresh verification or an already-verified exact-recipient login,
the smoke POSTs `/v1/auth/reader-state` with the session cookie and checks only
its response shape, future integer expiry, and compact token structure. It then
confirms `/v1/me` is authenticated, POSTs public `/v1/auth/sign-out`, and
confirms both `/v1/me` and Reader State issuance return `401 unauthenticated`.
The Reader State and cookie are never logged.

Provisioning supports sandbox D1 only. It discovers or creates the exact
database named by `D1_NAME`, then stages the discovered UUID into `.env.sandbox`
without committing it. Production provisioning is rejected, not a read-only
plan or an apply operation; production release uses the deployment and
promotion commands with the production environment file.

## Subsequent releases

Use `npm run deploy -- --env sandbox --dry-run` to inspect the read-only
release plan; it performs preflight reads but does not bundle or upload. The
normal deploy command then materializes the compiled profile, keeps
`keep_vars: false`, preserves local `.env` isolation, and never places secrets
in the bundle. The first deployment migrates, deploys and checks only
`/v1/health`; later candidate uploads do not run an automatic smoke.

Promotion is an explicit local operator action. After selecting and validating
the immutable Version ID, the command enables Version URLs in its minimal
target-only Wrangler config, constructs the documented URL from that exact ID,
then queries the full Version metadata with
`wrangler versions view <version-id> --json`. It requires the exact-version
manifest in both supported Wrangler annotations (`workers/message` and
`workers/tag`), validates their matching deterministic fingerprint and derives
the required secret set from the manifest transport, never from the current
application `.env`. It uses the returned Version URL when available (otherwise
the documented format only after the full-ID and manifest match), and runs
health followed by anonymous Identity (`GET /v1/me`) against it. This proves
`BETTER_AUTH_SECRET` request wiring without reading secret values. It fails
closed unless `BETTER_AUTH_SECRET` is present as `secret_text`, plus
`SMTP_USER`/`SMTP_PASSWORD` for `smtp` or `RESEND_API_KEY` for `resend`.
Extra encrypted bindings are allowed; remote `inmemory`, empty, unknown or
manifest-less candidates are rejected. This proves presence/type only, not SMTP delivery;
the full privileged SMTP/Identity QA smoke remains manual. Only after all
checks pass does it run `wrangler versions deploy <id>@100%`; production
still requires the exact Worker-name confirmation. This follows Cloudflare's
[Version URLs documentation](https://developers.cloudflare.com/workers/versions-and-deployments/version-urls/)
and [deployment management documentation](https://developers.cloudflare.com/workers/versions-and-deployments/deployment-management/).

All malformed, duplicate, unknown or secret environment-file entries fail
before a provider command. Empty or placeholder D1 IDs fail before remote
mutation.

## Safe Wrangler secret-preservation check

The generated deployment config contains only infrastructure bindings and the
compiled non-secret profile. It declares no secrets and does not invoke secret
management commands. Cloudflare Version URLs use the uploaded version's
existing configuration and resources; readiness therefore exercises the
candidate's secret-backed runtime behavior without exposing or asserting any
secret value. Do not use secret listing/get commands or print values.
