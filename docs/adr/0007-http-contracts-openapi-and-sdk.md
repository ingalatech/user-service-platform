# ADR-0007: Generate OpenAPI and TypeScript clients from application-owned HTTP contracts

## Status

Accepted.

## Context

The service needs public HTTP contracts that are runtime-validatable, documented, versionable and consumable from other repositories. The implementation is Hono-based and organized by vertical feature slice. Consumers must not depend on persistence models or Hono server internals.

## Decision

Each public feature owns dedicated Zod request/response schemas and registers its operations through `@hono/zod-openapi` using an `OpenAPIHono` router.

The same source contracts provide:

- runtime request validation;
- TypeScript inference inside the service;
- generated OpenAPI documentation;
- the input for generated external clients.

Persistence types, including Drizzle row/schema types, are not public API contracts.

Public endpoints are namespaced under `/v1` from the initial release.

For TypeScript consumers, generate API types from the OpenAPI document with `openapi-typescript` and use `openapi-fetch` as the thin runtime HTTP client. External consumers must not import Hono server inference types from this repository.

Generated OpenAPI/client artifacts are outputs. They must never be edited by hand or treated as the source of truth.

HTTP error responses use an RFC 9457-compatible Problem Details representation (`application/problem+json`) with stable machine-readable problem identifiers/codes. Human-readable detail text is not a machine contract.

## Compatibility policy

Changes within `/v1` must be backward compatible by default. Additive endpoints, optional fields and optional parameters may remain in `/v1` when existing clients continue to behave correctly.

Removing/renaming contract members, changing their type or meaning, making optional input mandatory, or materially changing existing operation semantics is breaking and requires an explicit versioned transition, normally `/v2`, with migration/deprecation planning.

Generated SDK/package versions follow semantic versioning:

- major for breaking client/API contract changes;
- minor for backward-compatible capabilities;
- patch for non-contract-breaking fixes.

## CI consequences

Once executable application scaffolding exists, CI must:

- lint, format-check, typecheck and test;
- generate and validate OpenAPI from source contracts;
- regenerate TypeScript client artifacts;
- fail when generated artifacts drift from source contracts;
- exercise contract/integration tests through the public HTTP boundary.

Before the first external consumer relies on `/v1`, CI must also gain an OpenAPI compatibility-diff gate so breaking changes cannot land accidentally.

## First consumer integration (ticket #152, operator decision 2026-10-15)

Distribution for this increment: source and generated artifacts are delivered in this repository and consumed from a pinned commit, without npm publication. This was already authorized by spec #150 and ticket #152.

Compatibility tool for this increment: retain the project-owned comparator in `scripts/openapi-compat.ts`, exercised by `npm run openapi:compat` and `test/node/openapi-compat.test.ts`. It is not a claim of universal OpenAPI compatibility analysis. Its supported scope is the contract keywords it compares (`type`, `format`, `required`, `properties`, `items`, `enum`, operations and parameters); documentation text never breaks compatibility, while other changed validation constraints or compositions conservatively require review. Maintenance responsibility stays with this service: retain the meaningful compatible/breaking regression fixtures, preserve the existing compatibility gate, and update the pinned baseline deliberately with breaking-change justification. Revisit registry distribution or an off-the-shelf differ only through a later explicit decision.

## Research

See `docs/research/api-contract-and-codegen.md`.
