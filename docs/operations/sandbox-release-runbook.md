# Sandbox release runbook

## Sandbox release (local operator action)

Remote configuration is kept in `config/environments/.env.sandbox` and
`config/environments/.env.production`. Each file is complete, versioned and
contains no runtime secret. The ignored root `.env` is local-only; release
commands never read it. Wrangler authentication and runtime secrets remain
operator-managed outside the repository.

## Bootstrap sandbox

1. Set the sandbox `CLOUDFLARE_ACCOUNT_ID` in `.env.sandbox`.
2. Run `npm run provision -- --env sandbox --plan`.
3. Run `npm run provision -- --env sandbox --apply`.
4. Review the staged `D1_ID` diff in `.env.sandbox` and commit it.
5. Run `npm run deploy -- --env sandbox` and confirm the first deployment.
6. Configure `BETTER_AUTH_SECRET`, `SMTP_USER` and `SMTP_PASSWORD` in the
   Cloudflare Dashboard. Release tooling never lists or mutates these secrets.

Provisioning supports sandbox D1 only. It discovers or creates the exact
database named by `D1_NAME`, then stages the discovered UUID into `.env.sandbox`
without committing it. Production remains fail-closed until its account, D1
and release values are complete.

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
