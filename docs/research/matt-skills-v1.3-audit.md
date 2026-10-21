# Matt skills v1.3 audit and glossary migration

> Historical audit record only. Its former review workflow references are not operational guidance.

Verified: 2026-10-04. Source ticket: #111.

## Scope and pinned sources

- Repository baseline: `JonatanGarbuyo/user-service-platform` main at `ab6b3da672ccc9f463957a6e87d0a6e93a8e3f57`.
- Upstream: `mattpocock/skills` tagged `v1.3.1`, commit `24fe0ef7737efae15c87225755e9f6f5965e4888`. The tag is annotated; this is its resolved commit, not the tag-object SHA.
- v1.3.0 published 2026-10-04 12:47:22 UTC; v1.3.1 followed at 12:48:18 UTC.
- Compared every file in all 12 Matt bundles listed in `skills-lock.json`, including support references and `agents/openai.yaml`, before modifying them. A thirteenth bundle, the repository's custom `better-typescript`, is outside the upstream `mattpocock/skills` inventory and remains untouched.
- Upstream has 37 skill bundles; 25 are not vendored here. Absence is an inventory fact, not evidence that all 25 should be installed.

The v1.3.0 to v1.3.1 diff touches five upstream paths: plugin/package versions, CHANGELOG, the diagnosing-bugs docs page, and `ask-matt/SKILL.md`. The operative correction removes the router's stale automatic diagnosis-to-architecture handoff and recommends user-invoked retro after a fix. None of this repository's 12 bundles differs between those two tags.

## Vendored bundle comparison before migration

Nine bundles are byte-identical to v1.3.1, including their support files and Codex metadata. Three differ only around the glossary naming convention. No unrelated skill rewrite is needed.

| Skill                      | Baseline versus v1.3.1 | Required change                                       |
| -------------------------- | ---------------------- | ----------------------------------------------------- |
| `code-review`              | Identical              | No update required                                    |
| `domain-modeling`          | Glossary migration     | Rename format reference/file and map heading          |
| `grill-with-docs`          | Identical              | No update required                                    |
| `handoff`                  | Identical              | No update required                                    |
| `implement`                | Identical              | No update required                                    |
| `prototype`                | Identical              | No update required                                    |
| `research`                 | Identical              | No update required                                    |
| `setup-matt-pocock-skills` | Glossary migration     | Rename glossary pointers in skill and domain template |
| `tdd`                      | Glossary migration     | Rename the vocabulary pointer                         |
| `to-spec`                  | Identical              | No update required                                    |
| `to-tickets`               | Identical              | No update required                                    |
| `wayfinder`                | Identical              | No update required                                    |

These are all differing file paths. The format-file rename is shown as a deletion/addition in the raw comparison; its contents also change the example map heading.

| Bundle/file                          | Baseline comparison | Diff lines |
| ------------------------------------ | ------------------- | ---------- |
| `domain-modeling/CONTEXT-FORMAT.md`  | repository-only     | +0 / -60   |
| `domain-modeling/GLOSSARY-FORMAT.md` | upstream-only       | +60 / -0   |
| `domain-modeling/SKILL.md`           | changed             | +12 / -12  |
| `setup-matt-pocock-skills/SKILL.md`  | changed             | +4 / -4    |
| `setup-matt-pocock-skills/domain.md` | changed             | +8 / -8    |
| `tdd/SKILL.md`                       | changed             | +1 / -1    |

The complete before-migration comparison is [matt-skills-v1.3-vendored.diff](./matt-skills-v1.3-vendored.diff). It is an audit artifact, oriented from repository baseline to upstream v1.3.1, not a patch to apply to the repository root. Its old filename references are intentionally historical evidence.

After migration, all 12 complete vendored Matt bundles match v1.3.1 byte-for-byte. Only the three changed bundle hashes need updates. The hash procedure follows the installer: recursively collect files, order relative paths with JavaScript `localeCompare`, and SHA-256 each path followed by its file bytes. Source/sourceType/skillPath fields remain unchanged. The lock records content hashes rather than a release tag; this report records the explicit tag/commit.

## Setup assessment and migration

The v1.3.1 setup skill has the same setup process as the installed one. Its SKILL.md changes four glossary-reference lines; its domain template changes eight. Tracker and triage templates are unchanged. There is no required reset of setup or new configuration decision.

| Existing choice                                   | Assessment                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GitHub Issues                                     | Keep existing `docs/agents/issue-tracker.md`, including native dependency/sub-issue preference and fallback bodies. |
| Default five triage labels                        | Keep `docs/agents/triage-labels.md`; no label recreation or renaming.                                               |
| Single context, root glossary + `docs/adr/`       | Keep layout; rename root glossary. No monorepo or glossary map is required.                                         |
| Existing AGENTS.md                                | Update its pointers in place; create no CLAUDE.md or duplicate Agent skills block.                                  |
| Existing OpenCode review and publication controls | Preserve models, exact-HEAD evidence, dual axes, branch publication, and separate deployment authorization.         |

Implemented changes:

- `CONTEXT.md` becomes `GLOSSARY.md`, with identical content bytes.
- Domain-modeling's `CONTEXT-FORMAT.md` becomes `GLOSSARY-FORMAT.md`; update its example map heading to match upstream.
- Update active glossary pointers in AGENTS.md, README, domain/opencode/checkpoint docs, all affected OpenCode agents/commands, vendored templates/skills, and two TypeScript source comments.
- Update the three folder hashes. Product behaviour, runtime configuration, permissions, workflows, ADR decisions, and review-model assignments do not change.

Updating just the root file would leave the old local domain-modeling skill able to recreate CONTEXT.md and the runner prompts trying to read a missing file. That is why this migration includes consumers.

The setup's former confirmation steps concern choosing tracker/labels/layout. Those choices already exist and the maintainer explicitly requested this naming migration, so no additional setup interview is necessary.

## Missing repository-local dependencies

| Missing bundle       | Existing consumer                                                                       | Consequence and recommendation                                                                                                       |
| -------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `grilling`           | `grill-with-docs` and `wayfinder` explicitly call it                                    | Vendor the pinned bundle in a separate scoped follow-up. These flows are incomplete on a runner with only the local skill directory. |
| `codebase-design`    | `tdd` explicitly calls it for interface/seam design                                     | Vendor it alongside grilling; preserve the existing public-behaviour test rules.                                                     |
| `writing-for-agents` | Needed by upstream `retro` if adopted; also useful for this repo's steering maintenance | Include with a retro adoption, rather than installing retro alone.                                                                   |

The ChatGPT session catalog currently exposes these dependencies and additional skills, but that catalog is distinct from `.agents/skills/` on the GitHub/OpenCode runner. A skill being reachable in this chat does not establish that the remote harness can load it. This PR does not add new bundles or modify personal/plugin-provided skills.

Additional upstream bundles not vendored here:

- Engineering: `ask-matt`, `codebase-design`, `diagnosing-bugs`, `implement-spec`, `improve-codebase-architecture`, `pr`, `retro`, `triage`, `wizard`.
- Productivity: `grill-me`, `grilling`, `teach`, `to-questionnaire`, `wait-what`, `writing-for-agents`.
- In progress: `claude-handoff`, `loop-me`, `setup-ts-deep-modules`, `writing-beats`, `writing-fragments`, `writing-shape`.
- Miscellaneous: `git-guardrails-claude-code`, `migrate-to-shoehorn`, `scaffold-exercises`, `setup-pre-commit`.

`resolving-merge-conflicts` was removed upstream in v1.3. It was not vendored here, so there is no repository removal to perform. It remains visible in the current curated chat catalog; this audit does not change that external catalog.

## Requested last-25-session audit: coverage limitation

**A 25-session audit could not be performed.** Personal Context returned `Personal context is disabled`. No session transcript exports were available in this conversation's workspace. There is no authorized enumerator or readable dataset establishing the newest 25 session IDs, dates, and full tool events. Accordingly, this report provides no invocation frequencies, percentages, or claim that a skill was unused across that window.

Evidence available is the current conversation, including the earlier project conversation messages supplied by the user, plus live GitHub evidence. That material contains many turns and workflow runs, but cannot be partitioned into 25 verified sessions. Slash commands, assistant mentions, actual skill loads, and workflow commands are different evidence types; they must not be counted interchangeably.

| Skill/flow                           | Available evidence                                                                                                    | What can be concluded                                                                                                                     |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `code-review`                        | Configured Standards and Spec reports on PRs #109/#110, linked below; runner commands scoped to each independent axis | Review is central to the observed workflow. These are verified remote review executions, not a session-frequency measure.                 |
| `implement` / `/address-review`      | Existing OpenCode command and agent wiring; supplied conversation repeatedly dispatches correction runs               | Ticket implementation/correction is automated; final acceptance is supervised. address-review is a repository command, not a Matt bundle. |
| `diagnosing-bugs`                    | Supplied conversation explicitly announces loading it for the MiMo startup/provider failure                           | There is evidence of a chat-side diagnosis invocation; no complete session/tool timeline is available.                                    |
| `triage`                             | Supplied conversation explicitly announces its use for #80's agent brief                                              | There is evidence of chat-side triage use, although the bundle is not vendored on the runner.                                             |
| `writing-for-agents`                 | Supplied conversation announces use for checkpoint maintenance and the no-tautological-tests rule                     | Steering/context maintenance is an observed need; this is not a 25-session count.                                                         |
| `wayfinder -> to-spec -> to-tickets` | AGENTS.md, tracker conventions, accepted map/spec/ticket history                                                      | These are the documented planning flow. Documentation/history alone does not prove invocations in the requested session window.           |
| `retro`, `pr`, `implement-spec`      | No confirmed invocation in the supplied historical transcript                                                         | These are candidates to adopt; absence from the visible excerpt is not evidence of non-use in 25 sessions.                                |

To complete the requested sample, provide exports or tool-event logs for the newest 25 sessions. Record session ID/date, explicit user invocation, actual assistant skill-load event, skill version/source, and outcome. Count unique sessions separately from repeated loads within a session, and keep child-agent runs separate. A reference to `/review-spec` in prose is not itself a skill-load event.

## Workflow recommendations from the available evidence

1. **Close the local dependency gap first.** Add pinned grilling and codebase-design to the remote runner installation. Nine installed bundles are already current; a blanket reinstall is unnecessary. Keep the customized better-typescript skill.

2. **Adopt user-invoked retro after difficult corrections.** The observed #82 work involved repeated provider errors, incomplete issue reads, a missing-dependency bootstrap and an accidentally truncated workflow publication. Retro targets the agent environment that made those errors possible. First inspect existing checks: dependency restoration and exact-HEAD checks already exist in the accepted PRs, so verify their wiring rather than propose duplicates. New mechanical findings should become deterministic guardrails; keep judgement-based testing rules such as avoiding tautological tests as review criteria. Add writing-for-agents when adding retro. Evidence is from the supplied conversation, not a measured 25-session trend.

3. **Adopt model-invoked pr at close-out, with a repository overlay.** Its before/after evidence and merge-danger section would make publication/deployment side effects explicit before final acceptance. At the time of this audit, preserve source-ticket identification, the automated-implementation phrase required by the then-current hosted approver, trusted handoff provenance, Closes references, and exact-HEAD review/CI links. A generic PR template must not overwrite those machine-consumed contracts. The earlier summary edit that removed that phrase is a concrete reason for this overlay.

4. **Pilot implement-spec only for independent approved slices.** The new engineering flow reads tickets as a dependency graph, implements ready-frontier tickets in separate worktrees, and combines them on an integration branch. This can reduce serial waiting, but it conflicts with the current one-ticket-at-a-time publication/review model and branch guards. Define a separate integration workflow with the same configured two-axis, exact-HEAD CI and final-acceptance requirements before adopting it. Keep infrastructure/protected-workflow changes on the existing guarded path. Do not grant a model merge/deployment rights to make the pilot run.

5. **Respect invocation boundaries and log actual loads.** In the upstream convention, retro and implement-spec are user-invoked; pr, grilling, and codebase-design are model-invoked. A router can recommend a user-invoked skill, but cannot silently fire it. Observe explicit model-invoked tool calls where upstream prescribes them, while keeping the repository's independently orchestrated reviewers. A future audit needs harness skill-load events keyed by session and skill-source commit; mining slash-name text alone would produce false counts.

The highest immediate value is reliable local dependencies plus retro/pr close-out. Parallel implementation is a later process decision, after the existing gates are operational, rather than a required step for this release migration.

## Validation

- Byte comparison against the baseline preserves the entire glossary content.
- Every file in all 12 Matt bundles is compared with the tagged upstream bundle after migration; all must match.
- All 12 skills-lock hashes must match actual directory contents; only three entries changed.
- Scan active tracked source/config/docs for obsolete domain filenames. Historical names in this report and the pre-migration diff are intentional.
- Parse affected YAML frontmatter, verify the renamed format link, and use the pinned Node.js/npm versions for repository `npm run check`.
- The PR's CI validates the published exact HEAD. Draft publication is not final acceptance and does not authorize merge/deployment.

## Sources

- [v1.3.0 release](https://github.com/mattpocock/skills/releases/tag/v1.3.0)
- [v1.3.1 release](https://github.com/mattpocock/skills/releases/tag/v1.3.1)
- [v1.3.0 to v1.3.1 comparison](https://github.com/mattpocock/skills/compare/v1.3.0...v1.3.1)
- [Tagged setup skill](https://github.com/mattpocock/skills/blob/v1.3.1/skills/engineering/setup-matt-pocock-skills/SKILL.md)
- [Tagged invocation rules](https://github.com/mattpocock/skills/blob/v1.3.1/.agents/invocation.md)
- [Tagged retro](https://github.com/mattpocock/skills/blob/v1.3.1/skills/engineering/retro/SKILL.md)
- [Tagged pr](https://github.com/mattpocock/skills/blob/v1.3.1/skills/engineering/pr/SKILL.md)
- [Tagged implement-spec](https://github.com/mattpocock/skills/blob/v1.3.1/skills/engineering/implement-spec/SKILL.md)
- [Installer folder-hash implementation](https://github.com/vercel-labs/skills/blob/main/src/local-lock.ts)
- [PR #109 exact-HEAD Standards](https://github.com/JonatanGarbuyo/user-service-platform/pull/109#issuecomment-5961762044)
- [PR #109 exact-HEAD Spec](https://github.com/JonatanGarbuyo/user-service-platform/pull/109#issuecomment-5961613539)
- [PR #110 exact-HEAD Standards](https://github.com/JonatanGarbuyo/user-service-platform/pull/110#issuecomment-5962145354)
- [PR #110 exact-HEAD Spec](https://github.com/JonatanGarbuyo/user-service-platform/pull/110#issuecomment-5962137332)
