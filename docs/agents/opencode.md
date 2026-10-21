# OpenCode workflow

OpenCode is used from an isolated ticket worktree. Product and architecture
decisions remain in `GLOSSARY.md`, ADRs, Wayfinder/spec issues, and approved
implementation tickets.

## Current pane responsibilities

```text
p2 implements or corrects
p3 performs Standards and Spec review directly
p1 coordinates, checks CI, merges, and operates releases
```

P2 does not launch reviewer or correction subagents. P3 reviews the exact
branch directly and reports findings to P2 or P1. P1 decides whether the PR is
ready for merge and separately controls release operations. GitHub Actions is a
deterministic quality-gates boundary only.

## Bootstrap and path discipline

Start OpenCode from the active worktree root:

```bash
cd "$(git rev-parse --show-toplevel)"
opencode
```

Use repository-relative paths for in-worktree files. Keep external-directory
access denied unless a genuinely external trusted directory is required and
the developer grants it deliberately in local configuration.

## Permission strategy

Allow routine repository inspection, local edits, deterministic quality gates,
and local commits. Keep push, merge, deploy, publishing, secret mutation,
destructive Cloudflare operations, and external-directory access denied to the
implementation pane. `review:safe-push` is the narrow, independently tested
publication path when P1 authorizes it.

## Source of truth

Before implementation or direct review, read:

1. `AGENTS.md`.
2. `docs/agents/project-state.md`.
3. `GLOSSARY.md`.
4. The implementation ticket and its comments.
5. Its parent spec.
6. Relevant ADRs.

## Ticket execution

Implement only approved `ready-for-agent` tickets from the dependency frontier.
Work one ticket per isolated branch/worktree and verify the ticket's acceptance
criteria with repository gates. A green formatter/linter is not sufficient.

P2 may commit locally and must not merge or deploy. P3 reviews directly without
launching repository-configured reviewer workers. P1 coordinates the handoff,
inspects CI, performs the authorized merge, and controls sandbox/production
release commands.

## Safety and data boundary

Do not expose production credentials, API keys, customer data, `.env` files,
`.dev.vars`, tokens, or Cloudflare authorization to implementation or review
panes. Unattended work must use an isolated environment without those
resources. Permission rules are defense in depth, not a complete sandbox.

## GitHub Actions and releases

GitHub Actions runs only deterministic lint, formatting, typecheck, generated
contract, Worker, and harness tests. It does not run agents, review loops,
deployment, promotion, or approval automation. Sandbox and production releases
are explicit local P1 operations.
