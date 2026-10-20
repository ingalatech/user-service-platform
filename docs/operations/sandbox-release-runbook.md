# Sandbox release runbook

## Sandbox release (local operator action)

Remote configuration is kept in `config/environments/.env.sandbox` and
`config/environments/.env.production`. Each file is complete, versioned and
contains no runtime secret. The ignored root `.env` is local-only; release
commands never read it. Wrangler authentication and runtime secrets remain
operator-managed outside the repository.

## Bootstrap sandbox

1. Set the sandbox `CLOUDFLARE_ACCOUNT_ID` in `.env.sandbox`. The selected
   environment file is authoritative for the Worker, account, D1 names and all
   non-secret deployment values; the ignored root `.env` is not consulted.
2. Run `npm run provision -- --env sandbox --plan`.
3. Run `npm run provision -- --env sandbox --apply`.
4. Review the staged `D1_ID` diff in `.env.sandbox` and commit it.
5. Run `npm run deploy -- --env sandbox` and confirm the first deployment.
6. Configure the required secrets in Cloudflare. Provisioning and deployment
   preflight may list secret metadata (names and `secret_text` types) and report
   missing or incorrectly typed bindings, but never read, print or mutate secret
   values. If the Worker does not exist yet, provisioning reports the required
   secret names and `wrangler secret put` instructions for after deployment.

Provisioning supports sandbox D1 only. It discovers or creates the exact
database named by `D1_NAME`, then stages the discovered UUID into `.env.sandbox`
without committing it. Production provisioning is rejected, not a read-only
plan or an apply operation; production release uses the deployment and
promotion commands with the production environment file.

## Subsequent releases

Use `npm run deploy -- --env sandbox --dry-run` to inspect a release, then run
the same command without `--dry-run`. Candidate upload, migration ordering,
first-deploy confirmation and immutable promotion remain unchanged.

Promotion is an explicit local operator action. Promote an immutable Worker
version with `npm run promote -- --env sandbox`.
Production promotion additionally requires `--confirm` with the exact Worker
name and never happens as a side effect of sandbox deployment.

All malformed, duplicate, unknown or secret environment-file entries fail
before a provider command. Empty or placeholder D1 IDs fail before remote
mutation.
