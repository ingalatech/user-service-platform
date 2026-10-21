---
description: Implement one approved ready-for-agent GitHub ticket using Matt Pocock's implement workflow
agent: implementer
---

Read `AGENTS.md` and `docs/agents/opencode.md`, then load the `implement` skill.

Implement exactly the GitHub implementation ticket identified by `$ARGUMENTS`.

The target must be an approved `ready-for-agent` implementation ticket produced from the parent spec, not a Wayfinder decision ticket or broad spec issue. Read the ticket, its comments, its parent spec, `GLOSSARY.md`, and all relevant ADRs before editing code.

Work only in the current isolated ticket branch/worktree. Follow the agreed test seam and TDD where appropriate, verify every acceptance criterion, and leave review to the designated p3 pane. Do not broaden scope or invent product/architecture decisions that are absent from the source artifacts.

Do not deploy, mutate production resources/secrets, publish packages, merge, or push changes. Commit locally on the ticket branch when the implementation workflow requires it, then report the verified result for human review.
