# Project state checkpoint

Last verified: 2026-10-21

This file is a durable operational checkpoint. It is an index and handoff, not
a replacement for `GLOSSARY.md`, accepted ADRs, current issue/PR bodies, CI, or
the live repository state.

## Authority and bootstrap

Use canonical sources in this order for their respective concerns:

1. `GLOSSARY.md` for domain vocabulary.
2. Accepted ADRs under `docs/adr/` for architecture and technical decisions.
3. Current specification and ticket bodies plus comments for product intent.
4. Current repository HEAD, GitHub PR/issue state, and CI for implementation truth.
5. `AGENTS.md` and `docs/agents/` for engineering process.
6. This file only as a cross-session handoff.

Fresh substantial sessions read `AGENTS.md`, this file, `GLOSSARY.md`, the
current ticket/spec, relevant ADRs, and any applicable project-local skill.

## Operating agreement

The current local workflow is:

```text
p2 implements or corrects -> p3 reviews directly -> p1 coordinates
                              p1 checks CI, merges, and operates releases
```

P2 works on one approved `ready-for-agent` implementation ticket in an
isolated branch/worktree. P3 performs direct Standards and Spec review against
the exact branch commit. P2 applies valid corrections and reruns repository
gates. P1 coordinates the handoff, checks CI, performs the authorized merge,
and controls sandbox/production releases.

No repository command launches reviewer or correction subagents. There is no
automated review/correction cycle, review marker, or GitHub-hosted agent
workflow in the current execution path.

## GitHub Actions and releases

GitHub Actions contains only `.github/workflows/ci.yml`. It runs pinned
dependency installation, lint, formatting, typecheck, generated-contract
drift checks, Worker tests, and harness tests with read-only repository
permissions. It does not run agents, reviewers, correction loops, approval
automation, deployment, or promotion.

Sandbox and production release commands are explicit local P1 operations. The
deployment and promotion boundaries remain unchanged. `review:safe-push` is a
narrow, independently tested branch-publication guard; it does not merge,
deploy, or coordinate review.

## Current repository state

Main is currently verified at `8af475dc13251ee2765dac27a26281be781588dc`.
Identity and the read-only administrative panel are accepted in sandbox.
Subscription billing is not implemented. Product planning and implementation
tickets remain authoritative in GitHub; do not infer product behavior from
this checkpoint.

The repository is a single-context User Service for the first consumer. The
frontend owns site integration, content, UI, and paywall policy. This backend
owns Identity and provider-independent subscription/billing contracts. No
consumer JWT, paid entitlement, social login, or billing behavior should be
claimed as implemented unless confirmed by current source and CI evidence.

## Architecture baseline

Canonical detail lives in `GLOSSARY.md` and accepted ADRs.

- Cloudflare Workers + Hono.
- Contract-first vertical slices under `/v1`.
- Zod + `@hono/zod-openapi`; generated OpenAPI and consumer TypeScript contracts.
- RFC 9457-compatible Problem Details with stable machine codes.
- D1 for relational data; object storage for binary files.
- Better Auth behind application-owned identity/session boundaries.
- Deployment-owned `AuthPolicy`.
- Verified email before initial email/password login/session.
- Production transport behind the application-owned `AuthMailer` adapter.
- Local, sandbox, and production are isolated operational contexts.
- Credentials, cookies, session tokens, action URLs, and email bodies stay out
  of ordinary logs.

## Toolchain

ADR-0006 is authoritative:

- Node.js `24.22.1` from `.nvmrc`.
- TypeScript 6.x, ESLint flat config, and Prettier as the sole formatter.
- Semicolons, single quotes, two-space indentation, 100-column print width.
- npm with the repository-pinned versions.

## Direct-browser consumer transport (2026-10-15)

Decision #163 is resolved (operator delegated the choice, 2026-10-15) and the
successor spec is #164: direct browser calls to a separate same-site service
Worker with exact credentialed CORS and a service-only host-only HttpOnly
session cookie; no Astro gateway/proxy and no per-page Identity lookup.
ADR-0013 records the transport amendment. Slice #165 ("Authenticate directly
from an approved browser origin with service-only session cookies") is the
first executable slice; #166 is the shipped-client slice and is blocked by
accepted #165 and #152. PR #154's branch is preserved and was not modified.

#165 is implemented on branch `ticket/165-direct-browser-service-session`,
created from main `b94bca996c9b68fed9af3d01e8ddd0f7df2c19c7` (accepted #151
present). Changes are additive and confined to the identity slice:
`AUTH_CONSUMER_ORIGINS` non-secret configuration, the consumer CORS module,
the Origin/Fetch Metadata guard accepting exact consumer origins, an explicit
host-only/HttpOnly/SameSite=Lax session-cookie pin, and the real-browser
distinct-origin acceptance test. Direct-browser requests reuse the existing
Better Auth/D1 session for issuance/renewal; JWT claims, lifetime and
revocation rules are unchanged.

Explicit limitations: this is not merged and not deployed; no live sandbox
service URL, issuer, audience, DNS or TLS is verified by this work.
`usuarios.rugbychampagneweb.com` remains a selected desired production
hostname, not proof of activation. The exact reviewed commit SHA is published
as PR/issue evidence; agent work stops at `READY FOR FINAL ACCEPTANCE` and
does not merge or deploy.

## Maintaining this checkpoint

Update this file when the product frontier, execution workflow, environment
terminology, release authority, or a cross-session blocker changes materially.
Do not duplicate volatile model assignments or full issue/spec bodies here.
