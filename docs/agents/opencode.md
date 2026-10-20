# OpenCode implementation workflow

Use OpenCode as an implementation harness. Product/architecture decisions remain in `GLOSSARY.md`, ADRs, Wayfinder/spec issues, and approved implementation tickets.

## Bootstrap

The Matt Pocock skills are committed project-locally under `.agents/skills/`. OpenCode discovers them automatically.

Connect OpenCode Zen locally with `/connect`, then verify the configured models appear in `/models`.

The repository defines dedicated agents for implementation/correction, Standards review, and Spec review. Their concrete model assignments are operational configuration and may change; read `.opencode/agents/*.md` and `.opencode/commands/*.md` rather than copying model names into durable project-state snapshots.

`/implement` and `/address-review` use the configured implementation/correction agent. `/review-standards` and `/review-spec` run as separate reviewer executions so both review axes retain independent context and responsibilities even if model assignments change.

## Working-directory and path discipline

Start OpenCode from the active git worktree root:

```bash
cd "$(git rev-parse --show-toplevel)"
opencode
```

For repository files, every project agent is instructed to use repository-relative paths with read/edit/glob/grep/file tools. Do not convert in-worktree paths to absolute paths. OpenCode's external-directory boundary can produce unnecessary prompts or denials when a model supplies an absolute/poorly-normalized path; retry with the worktree-relative path instead of widening external access.

Keep `external_directory` denied for the project agents. If a genuinely external trusted directory is required, grant it deliberately in the developer's local OpenCode configuration rather than committing a machine-specific broad allow rule to this repository.

## Permission strategy

The implementer uses least-surprise permissions rather than either extreme of asking for every shell call or allowing every shell command:

- file edits inside the worktree are allowed;
- routine read-only git/GitHub inspection commands are allowed;
- local `git add`/`git commit` are allowed;
- deterministic repository quality-gate scripts are allowed;
- uncommon shell commands still ask;
- push, merge, deploy, publishing, secret mutation, destructive Cloudflare operations and `rm -rf` are explicitly denied;
- external-directory access is denied.

For an unattended or low-interruption run, OpenCode's `--auto` mode may be used: it auto-approves operations that would otherwise be `ask`, while explicit `deny` rules still apply. This is convenience, not a security sandbox.

```bash
cd "$(git rev-parse --show-toplevel)"
opencode --auto
```

A shell deny-list cannot prevent every equivalent side effect reachable through another interpreter or script. Therefore unattended execution must still happen in an isolated worktree/container/account with no production credentials, API keys, customer data, `.env`, `.dev.vars`, Cloudflare production auth, or other sensitive host resources available.

## Model data boundary

Free/third-party models available through OpenCode Zen must be treated as untrusted for secrets and production/customer data regardless of current model assignment.

- Never expose production credentials, API keys, customer data, `.env` files, or `.dev.vars` to these agents.
- Do not rely solely on OpenCode permission rules as a secret boundary when an agent has shell access.
- Unattended runs must use a clean worktree/container/account with no production credentials available in the workspace, environment, shell profile, credential stores, or Cloudflare tooling.

## Source of truth

Before implementation or review, read:

1. `AGENTS.md`.
2. `docs/agents/project-state.md`.
3. `GLOSSARY.md`.
4. The implementation ticket in full, including comments.
5. Its parent spec.
6. Relevant ADRs referenced by the ticket/spec.
7. The live `.opencode/agents/*` / `.opencode/commands/*` configuration for the current agent/model assignment.

A chat transcript is not stronger authority than these artifacts.

## Ticket execution

- Implement only approved `ready-for-agent` tickets from the dependency frontier.
- Never run `implement` directly against a Wayfinder map or broad parent spec.
- Work one ticket per fresh context and isolated branch/worktree.
- Follow the ticket's highest agreed test seam and use TDD where required.
- A green formatter/linter is not sufficient; every acceptance criterion must be verified.

### Local Git identity and publication

Run `npm run agent:ticket` through OpenCode/Herdr from an isolated local
worktree. Use the developer's normal local Git identity; the
`preagent:ticket` hook is a no-op outside GitHub Actions and must not overwrite
it. Local branch publication still goes through the repository-owned
safe-push/trusted-publication controls. No GitHub-hosted agent workflow is
part of this execution path.

## Pull request as the review handoff

After local implementation is complete, push the ticket branch and open a draft pull request before adversarial review. The pull request is the durable handoff between implementation, automated/model review, and final human/ChatGPT acceptance.

The PR should reference the implementation ticket and parent spec. Review findings belong on the PR rather than being copied into chat or posted to the implementation issue.

## Dual adversarial review gate

Every implementation ticket must pass two independent read-only review axes before final acceptance:

1. **Standards**: repository rules, architecture conventions, maintainability, and the repository-pinned code-review skill's smell baseline.
2. **Spec**: missing/incorrect requirements and scope creep against the implementation ticket and parent spec.

Run the configured `/review-standards` and `/review-spec` commands from a branch with an open PR. The command/agent configuration is the source of truth for which model currently owns each axis.

Each reviewer resolves the PR base as its fixed point and publishes one top-level PR comment. Every report includes its axis and the exact reviewed HEAD SHA so stale reviews are visible after subsequent commits.

The findings remain separate; do not let one axis cancel or rerank the other. Material findings go back to the implementation/correction agent or human reviewer. After corrections, rerun both reviews from fresh contexts and publish new SHA-stamped reports.

Final acceptance inspects the PR diff, CI and both review comments directly from GitHub; no manual copy/paste into chat is required.

## Addressing review findings

After final acceptance or adversarial review requests changes, run the configured `/address-review` workflow for the PR. It reads the latest Standards, Spec, and final acceptance comments, respects later dispositions such as rejected false positives, fixes only clearly valid in-scope findings, runs quality gates, and commits the fixes locally. It does not merge or deploy.

After publishing a correction, rerun both adversarial reviews so their reports are stamped against the new HEAD.

## Decision boundary

Implementation agents may choose local details that do not alter public contracts or accepted architecture. Stop and report rather than inventing a decision when work would require changing a public contract, accepted ADR, infrastructure/provider choice, security policy, feature data ownership, deployment behavior, or product scope.

## Unattended execution safety

The implementation/correction agent may commit on an isolated ticket branch but may not deploy, publish, merge, mutate production infrastructure, or change secrets. Reviewer agents are read-only except for publishing review evidence to the PR.

Repository-owned local scripts may perform narrowly validated branch publication through deterministic guards. They must not expose generic push, workflow-write, merge, deploy, publish, or secret-mutation capabilities to the model process.

## Current implementation frontier

Do not hardcode a product frontier in this process document. Read `docs/agents/project-state.md` for the last verified checkpoint, then confirm it against live GitHub issue/PR state before launching work.

Implementation and review agents run locally through OpenCode/Herdr in isolated ticket worktrees. Follow the existing ticket, TDD, and independent Standards/Spec review requirements above; do not execute agent workflows from GitHub Actions.
