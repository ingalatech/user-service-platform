# Project state checkpoint

Last verified: 2026-10-24

This is a concise operational handoff, not a replacement for the glossary,
accepted ADRs, current issues/PRs, CI or live repository state.

## Current repository state

- `main` is verified at `bcc5e7f8918d5b97c978ac39c9227fefc9d30a2a` (PR #241).
- PRs #235–#241 are merged. Together they restore auth/bootstrap invariants,
  centralize Identity runtime and operation behavior (including the #231
  password-policy correction), narrow the Consumer Identity surface, deepen
  local release execution and generate browser-safe Admin contracts.
- PR #241's CI run succeeded for its reviewed head; the main CI run for
  `bcc5e7f` has since completed successfully.
- Sandbox: #14 records accepted Identity deployment and smoke acceptance on
  `f3377b2`. In #201, Reader State candidate `e696391` was deployed as an
  inactive Version and passed readiness/CORS probes, but was not promoted; its
  review records the prior Version as still active then. Current active sandbox
  status is unverified (no current GitHub deployment record); no production
  activation is evidenced. No release was performed for #242.
- Configurable Profile and the D1 collections engine remain in planning under
  Wayfinder issues #208 and #216. Billing is not implemented.

## Operating agreement

```text
p2 implements or corrects -> p3 reviews directly -> p1 coordinates, checks CI,
                              merges and operates releases
```

P2 works one approved `ready-for-agent` ticket per isolated worktree and may
commit locally; it does not push, merge or deploy. P3 reviews the exact HEAD
directly. P1 coordinates the handoff, checks CI, performs authorized merges,
and controls sandbox/production operations. No automated review/correction
workers or release commands run from repository CI.

## Architecture and toolchain

- One-context User Service; frontend owns site integration, presentation and
  paywall policy. The service owns Identity and provider-independent contracts.
- Cloudflare Workers + Hono; contract-first vertical slices; Zod source
  contracts generate OpenAPI and consumer/Admin artifacts. Generated files are
  checked for drift, never hand-edited.
- Reader State is presentation-only and never authorizes User Service or a
  receiving API. The host-only HttpOnly session remains authoritative.
- Node.js `24.22.1` (`nvm use`), pinned TypeScript, ESLint and Prettier.
- Versioned `config/environments/.env.<environment>` files contain complete
  non-secret deployment configuration, including `AUTH_VERIFY_EMAIL_ACTION_URL`
  and `AUTH_RESET_PASSWORD_ACTION_URL`; runtime secrets remain out-of-band.
  Full delivered Auth Action URLs containing verification/reset tokens, token
  values, cookies and credentials stay out of files, arguments and logs. The
  ignored root `.env` is local-only.

## Release boundary

Deploy, promotion and provisioning are explicit local P1 operations. CI runs
deterministic lint, formatting, typecheck, generated-contract checks, Worker
tests and harness tests only; it does not mutate Cloudflare. A Worker rollback
does not roll back D1; destructive data recovery requires the separate
operator runbook and confirmation.
