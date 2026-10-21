# User Service Platform

Reusable user-service foundation, initially intended for a single-client deployment.

## Status

Architecture and repository bootstrap. Product implementation follows the decision workflow before code is added.

## Engineering workflow

This repository follows Matt Pocock's engineering skills workflow:

1. `setup-matt-pocock-skills` — configure tracker and domain docs once per repo.
2. `wayfinder` — resolve architectural/product decisions while there is still fog.
3. `to-spec` — turn settled decisions into a durable implementation specification.
4. `to-tickets` — split the spec into dependency-aware tracer-bullet vertical slices.
5. `implement` — build one approved ticket at a time using TDD, then hand off
   to the direct p3 review pane.

The operating handoff is explicit: p2 implements or corrects, p3 reviews the
exact branch directly, and p1 coordinates, checks CI, merges, and operates
releases. The implementation pane does not launch a reviewer or correction
loop.

See `AGENTS.md`, `GLOSSARY.md`, `docs/agents/`, and `docs/adr/` before making changes.

## Toolchain

Use the repository-pinned Node.js LTS version:

```bash
nvm use
```

The baseline is Node.js 24 LTS. npm and TypeScript are pinned in `package.json`; the initial compiler line is TypeScript 6.

## Skills installation

OpenCode is the primary implementation harness. Install the project-local Matt Pocock skills with:

```bash
npx skills@latest add mattpocock/skills \
  --agent opencode \
  --skill setup-matt-pocock-skills \
  --skill wayfinder \
  --skill domain-modeling \
  --skill grill-with-docs \
  --skill research \
  --skill prototype \
  --skill to-spec \
  --skill to-tickets \
  --skill tdd \
  --skill implement \
  --skill handoff \
  --skill grilling \
  --skill codebase-design \
  -y
```

`grilling` (`skills/productivity/grilling`) and `codebase-design` (`skills/engineering/codebase-design`) were vendored from `mattpocock/skills` tag `v1.3.1` at commit `24fe0ef7737efae15c87225755e9f6f5965e4888`.

OpenCode discovers these from `.agents/skills/`. The installed skills and lock metadata should be committed so implementation agents share the same workflow version. See `docs/agents/opencode.md`.

## Code quality

Repository formatting and linting are mechanical:

```bash
npm run format
npm run check
```

Prettier owns formatting. ESLint owns correctness, maintainability, and—once the source layout exists—architecture dependency rules. Formatting uses semicolons, single quotes and two-space indentation.

## Current architectural direction

- Cloudflare Workers as the deployment target.
- Hono as the HTTP framework.
- Cloudflare D1 as the initial relational store.
- Better Auth behind an application-owned configurable auth policy.
- Drizzle ORM for application persistence, pinned to a Better Auth-compatible stable line for the first release.
- Contract-first HTTP APIs with runtime validation and generated OpenAPI.
- Vertical feature slices rather than global controller/service/repository layers.
- Object storage separate from relational data.
- Analytics remains a separate service or third-party concern.

The current parent implementation specification is GitHub issue #8. It must be decomposed with `to-tickets` and approved before implementation agents start `implement` tickets.
