# ADR-0008: Isolate local, sandbox, and production and promote releases explicitly

## Status

Accepted.

## Context

The service runs on Cloudflare Workers with D1 and R2. Worker versions do not include the mutable state of attached storage resources, so application releases and data migrations cannot be treated as one automatically reversible unit.

## Decision

Use three operational contexts: local development, sandbox, and production.

Sandbox and production are separate Cloudflare Worker environments and use separate D1 databases, R2 buckets, secrets, domains/routes, and environment-specific configuration. Mutable resources must never be shared between sandbox and production.

Pull requests initially run local/CI checks only; per-PR deployed Cloudflare infrastructure is deferred.

Sandbox and production releases are explicit local operator actions. GitHub Actions runs deterministic repository CI only; it does not execute agents, upload Worker versions, promote traffic, or mutate Cloudflare resources. Operators use the repository deployment commands from an isolated local worktree and record the source commit plus resulting Worker version/deployment identifier. Production remains a separately confirmed promotion.

Remote release configuration is owned by one complete, versioned,
secret-free `config/environments/.env.<environment>` file per environment.
The root `.env` is local-development-only and is never read by deploy,
promote, or provision. Runtime secrets remain in Cloudflare. Sandbox D1
provisioning stages its discovered id back into `.env.sandbox` as an
uncommitted, reviewable change; production provisioning is not supported.

Database migrations are version controlled and validated against local/disposable D1 before merge. Production schema changes use an expand-deploy-contract strategy whenever rollback compatibility could matter:

1. introduce backward-compatible schema;
2. deploy code that uses the expanded schema;
3. remove obsolete schema only in a later release.

A Worker code rollback is not a data rollback. D1 Time Travel is the emergency point-in-time data recovery mechanism and requires an explicit runbook and confirmation.

Smoke tests are required after sandbox and production deployment.

## Consequences

- Local release tooling must select environment-specific bindings explicitly.
- Secrets are configured outside source control.
- Migration design must account for the immediately preceding Worker version when rollback is plausible.
- Destructive migrations cannot be casually coupled to the code release that stops using the old shape.
- Production releases are slightly more deliberate than continuous deployment to every environment, in exchange for safer schema/data operations.

## Deferred

- Gradual/canary production deployments.
- Ephemeral per-PR environments.
- Long-term database archive beyond D1 Time Travel retention.

## Research

See `docs/research/environments-observability-operations.md`.
