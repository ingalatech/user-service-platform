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
   npm run deploy:dry-run -- --env sandbox
   ```

   The repository command creates and removes its OS-native temporary config;
   no shell-specific `mktemp`, quoting or trap is required.

   This validates the local bundle and explicit `keep_vars: false`; it does
   not prove preservation of remote encrypted secrets.

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

Provisioning supports sandbox D1 only. It discovers or creates the exact
database named by `D1_NAME`, then stages the discovered UUID into `.env.sandbox`
without committing it. Production provisioning is rejected, not a read-only
plan or an apply operation; production release uses the deployment and
promotion commands with the production environment file.

## Subsequent releases

Use `npm run deploy -- --env sandbox --dry-run` to inspect the read-only
release plan; it performs preflight reads but does not bundle or upload. Use
the explicit materialization dry-run in step 5 to exercise bundling, then run
the deploy command without `--dry-run`. The candidate contains the compiled
profile and no plaintext application `vars`; the first deployment migrates,
deploys and checks only `/v1/health`; later candidate uploads do not run an
automatic smoke. Candidate upload, migration ordering and first-deploy
confirmation remain unchanged; immutable promotion is currently fail-closed.

Promotion is an explicit local operator action, and it is currently fail-closed.
`npm run promote -- --env sandbox` may list
versions and perform read-only preflight, but it refuses before
`wrangler versions deploy` because the repository has no approved, safe
behavior-verification seam tied to the selected Version ID. Cloudflare
documents Version URLs as a possible seam, but enabling them and defining the
secret-backed candidate checks requires an operator decision for each target.
Production confirmation does not bypass this gate. No promotion is allowed
until that evidence contract is implemented and approved.

All malformed, duplicate, unknown or secret environment-file entries fail
before a provider command. Empty or placeholder D1 IDs fail before remote
mutation.

## Safe Wrangler secret-preservation check

The generated target config contains only infrastructure bindings and the
compiled non-secret profile. It declares no secrets and does not invoke secret
management commands. The commands in step 5 are the safe local provider check:
they bundle the candidate without uploading it. They therefore prove neither
remote secret presence nor preservation.

The current repository has no approved candidate-version HTTP smoke seam that
can verify encrypted-secret behavior before traffic activation. A future
operator may upload a candidate with the normal deploy flow and inspect only
version and deployment metadata, but metadata cannot prove secret values. Do
not claim pre-activation secret preservation from that operation, and do not
use secret listing/get commands or print values. Promotion is enforced
fail-closed in the command until an approved Version-ID-bound candidate
verification seam exists.
