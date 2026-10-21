# Engineering agent contract

This repository is developed through explicit architecture, contracts, vertical slices, tests, and direct pane-based review. Do not introduce new architectural patterns ad hoc.

## Agent skills

### Issue tracker

Specs, wayfinder maps, decision tickets, and implementation tickets live in GitHub Issues. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default Matt Pocock triage vocabulary: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. Read `GLOSSARY.md` and relevant ADRs under `docs/adr/` before changing code. See `docs/agents/domain.md`.

### Session checkpoint

Read `docs/agents/project-state.md` at the start of a fresh substantial planning/implementation session and reconcile it before ending a long planning/orchestration session. It is an operational handoff, not a replacement for live GitHub state, ADRs, specs, or tickets.

### Project-local skills

When a workflow names a project-local skill under `.agents/skills/`, read that skill before using it. Do not reconstruct Wayfinder/spec/ticket/implementation behavior from model memory.

When writing or reviewing TypeScript, consult `.agents/skills/better-typescript/SKILL.md` and load only the referenced technique sections that apply to the code at hand.

### OpenCode implementation

When OpenCode is used as the implementation harness, follow `docs/agents/opencode.md`. P2 implements or corrects one approved `ready-for-agent` ticket in an isolated ticket branch/worktree; P3 reviews directly; P1 coordinates, checks CI, merges, and operates releases.

## Required workflow

For substantial work, follow this progression:

1. `wayfinder` while material product or architecture decisions remain unresolved.
2. `to-spec` once the route is clear.
3. `to-tickets` to produce dependency-aware tracer-bullet vertical slices.
4. `implement` one ticket at a time, using TDD where possible, then hand off to the designated direct reviewer.

Do not skip directly from a broad idea to implementation.

## Architecture rules

- Organize application behaviour by vertical feature slice, not by global controller/service/repository folders.
- Every HTTP endpoint must have an explicit runtime-validatable contract.
- The OpenAPI document is generated from source contracts; do not maintain a second hand-written API specification.
- Generate API clients/SDKs from the published OpenAPI contract where practical.
- Business rules belong to their owning feature, not routes, persistence adapters, or shared utility modules.
- Infrastructure concerns are accessed through narrow interfaces when substitution or testing benefits justify the seam.
- Do not create generic abstractions before two concrete use cases demonstrate the common shape.
- Relational data and binary/object data are separate concerns. Databases store object keys/metadata, not user-uploaded binaries.
- Analytics is not part of this service. The service may emit integration/domain events, but analytics storage and reporting live elsewhere.
- Editorial CMS roles are outside this service.

## Code quality

- Prettier is the sole formatter. Do not enforce formatting through ESLint rules.
- ESLint is authoritative for correctness, maintainability and architecture rules.
- Formatting uses semicolons, single quotes, two-space indentation and the repository Prettier configuration.
- Use the repository-pinned Node.js LTS version (`nvm use`) and pinned TypeScript/tool versions.
- Run `npm run check` before completing changes that touch executable/configuration code.
- Once the application TypeScript project is scaffolded, typed linting and `typecheck` become mandatory CI gates.
- Architecture boundaries documented here must become machine-enforced import/dependency rules once the source layout is finalized.

## Testing rules

- Do not write tautological tests.
- Prefer tests of public behaviour and repository contracts over implementation details.

## Change rules

- A feature slice owns its contract, domain behaviour, persistence implementation, and tests.
- Cross-feature imports must use public interfaces; do not import another feature's internals.
- Schema changes require migrations and tests at the agreed seam.
- New externally observable behaviour requires tests.
- Architectural exceptions require an ADR before implementation.
- Keep `GLOSSARY.md` vocabulary current when a domain term is introduced or materially changed.
