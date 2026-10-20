# Project state checkpoint

Last verified: 2026-10-14

This file is the durable operational checkpoint for starting a fresh ChatGPT/OpenCode session. It is an index and handoff, not a replacement for `GLOSSARY.md`, ADRs, specs, tickets, PRs, CI, or current repository state.

## Authority and bootstrap

Use canonical sources in this order for their respective concerns:

1. `GLOSSARY.md` for domain vocabulary.
2. Accepted ADRs under `docs/adr/` for architecture/technical decisions.
3. Current spec/ticket bodies plus comments for product intent.
4. Current repository HEAD, GitHub PR/issue state, CI, and exact-HEAD review evidence for implementation truth.
5. `AGENTS.md`, `docs/agents/`, `.agents/skills/`, and `.opencode/` for engineering process.
6. This file only as a cross-session handoff.

Fresh substantial sessions should read `AGENTS.md`, this file, `GLOSSARY.md`, the current ticket/spec, relevant ADRs, and the applicable project-local skill. Do not reconstruct project-local workflow from model memory.

Required progression for broad work remains:

```text
wayfinder -> to-spec -> to-tickets -> implement
```

## Operating agreement

- **ChatGPT** owns design discussion, Wayfinder/spec/ticket planning, orchestration decisions, inspection of durable GitHub evidence, trusted publication where required, final acceptance/verification, and may perform the final PR merge through a separately authorized GitHub operation once the agreed gates are satisfied and no human decision remains pending.
- **OpenCode agents** are the primary implementation/correction and adversarial-review workers, run locally through Herdr in isolated ticket worktrees.
- GitHub Actions is a deterministic CI boundary only; implementation, correction, and review agents do not run on GitHub-hosted runners.
- OpenCode/model-run agents and repository automation do **not** merge, deploy, publish production infrastructure, mutate secrets, or receive unrestricted push/workflow-write credentials. They stop at `READY FOR FINAL ACCEPTANCE`.
- “No automated merge” means the agent/workflow cannot self-merge. It does not prohibit ChatGPT, acting as the separately authorized final operator, from merging an accepted PR with an exact expected HEAD.
- Deployment, production-infrastructure mutation, and secret mutation remain separately controlled even after final acceptance; merge authority does not imply deployment authority.
- Review and run evidence lives on GitHub; manual copy/paste into chat is not part of the normal workflow.

## Current product frontier (2026-10-14)

Main is `a88774e6b5a7433c0c185b0152a5c10c634f2728`. Identity and the
read-only administrative panel are accepted in sandbox. Subscription billing
is not implemented. The active route is
[Consumer-ready login and pluggable subscription billing backend](https://github.com/JonatanGarbuyo/user-service-platform/issues/146).
Read that map and its current decision tickets before specifying or executing
consumer-authentication or billing work.

The operator confirmed this repository as the backend for the first consumer,
`rugbychampagneweb.com` (Astro on Cloudflare). The frontend team owns site
integration, content, UI and paywall policy/enforcement. This backend owns
Identity and provider-independent subscription/billing contracts. Monthly and
annual offers are required; prices remain pending. The operator selected
Mercado Pago Argentina in ARS for the first adapter. Cancellation stops renewal
and preserves the already-paid period; the consumer decides access. Remaining
commercial lifecycle details are tracked by decision #147. Consumer transport
and reusable-token behavior are settled by decision #149 and spec #150. No consumer
repository or service-copy repository is required for this backend increment.

Product work takes priority over further tooling. Implementation/review work
runs locally in isolated Herdr worktrees. Preserve meaningful checks and
independent review evidence; sandbox and production release commands are
explicit local operator actions. GitHub Actions remains limited to deterministic
repository CI.

Maintenance #143/#144 is implemented by PR #145 (remove wall-clock CI
polling waits from the real review-cycle regression tests), pending final
operator inspection; it does not block this product planning. The older
dated product/administration snapshots below are historical.

## Consumer JWT delivery (approved 2026-10-14)

The operator approved navigation and local rights evaluation without an
Identity request per page. [Decision #149](https://github.com/JonatanGarbuyo/user-service-platform/issues/149)
settles the consumer handoff; [spec #150](https://github.com/JonatanGarbuyo/user-service-platform/issues/150)
defines two complete slices:
[token issue/renewal and durable JWKS #151](https://github.com/JonatanGarbuyo/user-service-platform/issues/151),
then [the multi-page consumer client #152](https://github.com/JonatanGarbuyo/user-service-platform/issues/152).
Only #151 is initially executable; #152 waits for its accepted merge.
ADR-0013 records the accepted architecture and revocation trade-off.

These capabilities are approved, not implemented or deployed. Current main
still uses authoritative cookie sessions; do not claim that JWT, generated
external clients, social login or paid entitlements already work. Initial
JWTs grant no paid Entitlements. The browser reuses a short-lived token
between navigations and renews through the HttpOnly session, with an initial
maximum 15-minute snapshot; existing admin checks retain immediate store-backed
session validation. Initial browser transport is a documented same-origin
gateway owned by the consumer team, not unconfigured cross-origin requests.

Decision #147 remains open for commercial activation/payment/period semantics.
Mercado Pago handles collection behind the backend boundary. Backend-local
facts will drive future Entitlement snapshots; the consumer owns content,
paywall, SEO and CDN configuration. Identity delivery does not wait for
commercial prices or the Astro repository. Maintenance PR #145 remains a
separate open candidate pending final operator inspection, not a product
prerequisite.

## Consumer client recovery (2026-10-15)

PR #153 completed #151 at main `f8785394810203cd76f663997be3074fe4e73ef8`.
Standards and Spec PASS at `67b1ce88e46aa10aa77b96129649a62f11227988`;
exact-HEAD CI 38671491683, post-merge CI 38721888600, sandbox/ordinary
session smoke 38721888445 and Pages 38721888268 passed. Completion evidence:
#151 comment 6190230331. JWT activation in sandbox still needs explicit issuer
and audience; ordinary health/session smoke does not prove it.

#152 implements the framework-independent client under spec #150/ADR-0013.
The hosted implementation (38721979686) timed out at 30 minutes before any
commit/PR. Artifact 11967362570 preserved 27 eligible files; its generated
api.d.ts was truncated and the baseline OpenAPI artifact was excluded.
Recovery used a fresh worktree at the exact recorded base, applied the complete
tracked patch, restored the 22 eligible untracked files, regenerated the
client types and restored the baseline byte-identically from a88774e. This
preserves partial progress; it does not classify the timeout as a provider
failure or a PASS. The prior #151-active checkpoint text is historical.

Supplementary local Standards/Spec reviews found stale renewal denials clearing
new logins, rollover JWKS outages becoming anonymous, response compatibility
gaps and incomplete browser verification. These were fixed with regression
coverage; the browser fixture now injects only captured mail at the public
AuthMailer seam and drives both users through the public verify-email API.
These local reviews do not replace the configured independent reviews.

Local tests can run the Worker/D1 seam. The whole-browser Wrangler boot is
blocked here by uv_interface_addresses (system error 1), so genuine browser
acceptance and full CI remain required on the published recovery HEAD.
Configured Standards and Spec must independently approve that same HEAD.
Do not rerun /agent-ticket blindly or modify models/timeouts/approval policies.
The maintenance PR #145, billing decision #147, social login, paid Entitlements
and live JWT sandbox configuration remain separate from this client slice.

## Architecture baseline

Canonical detail lives in `GLOSSARY.md`, ADR-0001 through ADR-0011, Wayfinder #1, and spec #8.

Key durable decisions:

- single-client reusable User Service, not multi-tenant SaaS;
- Cloudflare Workers + Hono;
- contract-first vertical slices under `/v1`;
- Zod + `@hono/zod-openapi`; generated OpenAPI and generated consumer TypeScript contracts;
- RFC 9457-compatible Problem Details with stable machine codes;
- D1 initial relational store; persistence representations stay out of domain/public contracts;
- object storage for binary files;
- Better Auth behind application-owned identity/session boundaries;
- deployment-owned `AuthPolicy`;
- verified email required before initial email/password login/session;
- application-owned `AuthMailer`, with production transport hidden behind an adapter;
- local / sandbox / production are isolated operational contexts; sandbox and production never share mutable resources or credentials;
- production is an explicit promotion step;
- D1 migrations use rollback-compatible evolution and D1 Time Travel for emergency recovery;
- Cloudflare-native logs/traces/metrics are the initial observability baseline;
- credentials, cookies, session tokens, verification/reset secrets/action URLs, and email bodies are excluded from ordinary logs.

ADR-0008 is authoritative for environment naming. Historical `staging` references in spec #8 are superseded by the terminology amendment comment and should be read as `sandbox`.

## Toolchain and TypeScript guidance

ADR-0006 is authoritative:

- Node.js 24 LTS; `.nvmrc` currently pins 24.21.0.
- TypeScript 6.x.
- ESLint flat config + `typescript-eslint`.
- Prettier is the sole formatter.
- Semicolons, single quotes, two-space indentation, 100-column print width.
- npm.
- Drizzle preferred for D1, subject to Better Auth/Workers compatibility gates.

Project-local `.agents/skills/better-typescript/` is the shared TypeScript design/reference skill for local and GitHub-hosted OpenCode runs. Agents writing or reviewing TypeScript should consult its router and load only applicable technique sections.

Concrete model assignments are deliberately not duplicated here; read live `.opencode/agents/*`, `.opencode/commands/*`, and `docs/agents/opencode.md`.

## Product frontier

Verified on 2026-10-06 against live GitHub state; main is `e885e1c84460b2af6c7aeceac156314645febba1`:

- #9 health endpoint: closed/completed.
- #10 register + verify email: closed/completed.
- #11 sign in/current User: closed/completed; PR #43 squash-merged.
- #12 password recovery: closed/completed. PR #46 was accepted on exact HEAD `6e3430d8a924d6b271c0aaa2463f9f167e7d9cd2` after Standards, Spec, repository gates, and exact-HEAD CI all passed, then ChatGPT performed the final squash merge with expected-head protection. Main commit: `588d7e653daf00c7c9e209cc6295f7843c56b359`.
- #13 production auth email: closed/completed. PR #53 passed Standards, Spec, repository gates, and exact-HEAD CI on `364bc5afddb93bdbfd4aedf6dd7b2c9b63228943`; ChatGPT performed the final squash merge with expected-head protection. Main commit: `66cc6fe85f12dae516d7226abb5867acce0ed823`.
- #14 sandbox promotion: closed/completed. Canonical target is sandbox, not staging.
- #78 client-aware deployer/target registry, #104 required-secret declarations, and #106 rejection of plaintext required-secret bindings: closed/completed. Their isolation and secret-binding contracts govern provisioning.
- #82 Actions noise/trusted-handoff CI provenance: closed/completed. PR #109 squash-merged as main commit `1244fd71885acea3fff4a274deda8e7e78a683cd`; main CI `37332657770`, sandbox `37332657707`, Pages `37332655536` — all SUCCESS.
- #80 unified target provisioning: closed/completed. PR #110 squash-merged as main commit `350d38f946f62353e735f3fca1f86f39a782efa3`; main CI `37332977075`, sandbox `37332976990`, Pages `37332975575` — all SUCCESS. No live provisioning was performed or authorized.
- #111 Matt skills v1.3/glossary migration: closed/completed. PR #112 squash-merged as main commit `48f7fecbb31680f9d9d1b188ee974c8e27eea28f`; main CI `37333302162`, sandbox `37333302192`, Pages `37333300942` — all SUCCESS. It preserves glossary content, updates all consumers and three skill hashes, and records the tagged upstream comparison in [the audit](../research/matt-skills-v1.3-audit.md).
- Integration-only PR #113 closed without merging; CI `37316405798` passed 142 Workers + 643 harness tests at combined tree `3685d7f1eaa376588909ae5133ac754b6bdd12e3`.
- #114 complete local Matt skill dependencies and reconcile post-merge checkpoint: closed/completed. PR #115 squash-merged as main commit `e885e1c84460b2af6c7aeceac156314645febba1`.
- #116 skill-evidence parent specification: completed through #117 / PR #118.
- #117 attributable remote skill evidence: completed through PR #118.

GitHub-only skill-usage audit (25 worker runs: 16 fix-cycle + 9 ticket executions; 19 runs belong to #82; not productivity comparisons) is recorded separately from unavailable ChatGPT conversation data — no ChatGPT session dataset exists and none is inferred. Observed skill-tool minima: implement 17, code-review 13, tdd 10, custom better-typescript 5.

Administration milestone snapshot (verified 2026-10-12 against live GitHub state;
main is `9a5e0c75717a6e4707e9964aa550ffbd9a091f52`):

```text
#123 read-only administration parent spec (closed/completed)
  -> #127 recovery evidence: completed through PR #128
  -> #124 sign-in/authorize/sign-out: completed through PR #129
  -> #125 User search/pagination: completed through PR #130
  -> #126 User detail: completed through PR #131
```

#124 is accepted and closed after PR #129 was merged into main as
`c24215b84019f8b42887854a3a9559399d33c3a9` (both independent reviews and
exact-HEAD CI passed). Main CI 38057103931 and the sandbox deployment, run
38057103943, completed with `success` on that main commit. The sandbox
allowlist has three approved recipients: stable smoke `jonatangarbuyo@gmail.com`,
regular QA `cronistadev@gmail.com`, administrator QA `ingaladev@gmail.com`.
#125 is accepted and closed after PR #130 was squash-merged into main as
`324933913cff9100bedd1d2d80b39740a72b1429`. Configured Standards and Spec
both PASS on the exact accepted HEAD `e9191c0df0024a5ace52da345a4c658e3c36142e`;
CI 38249267972 passed all gates including genuine isolated Worker/D1 Chromium
acceptance. The accepted merge was deployed to sandbox: deployment and the
configured automated smoke both completed successfully in run
38249656941 (owner-reported on the ticket; verified successful). #126 (real
read-only User detail with safe deep links and matched-route telemetry) is
accepted and closed after PR #131 was squash-merged into main as
`9a5e0c75717a6e4707e9964aa550ffbd9a091f52`. Configured Standards PASS
([comment 6125453202](https://github.com/JonatanGarbuyo/user-service-platform/pull/131#issuecomment-6125453202))
and Spec PASS
([comment 6125480704](https://github.com/JonatanGarbuyo/user-service-platform/pull/131#issuecomment-6125480704))
on the exact reviewed HEAD `62e174d9ed0ca73733a9e69e18b26b4ecd6506e1`;
[exact-HEAD CI 38251894375](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38251894375)
passed all gates including genuine isolated Worker/D1 Chromium acceptance, and
[recovery cycle 38255595340](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38255595340)
completed READY on that unchanged reviewed HEAD. The accepted product source is
deployed to sandbox: [main CI 38258618931](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38258618931)
and [sandbox deployment/automated smoke 38258618860](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38258618860)
both succeeded on `9a5e0c75717a6e4707e9964aa550ffbd9a091f52`. Parent spec #123
is closed/completed by operator acceptance
([comment 6126035306](https://github.com/JonatanGarbuyo/user-service-platform/issues/123#issuecomment-6126035306),
2026-10-12, 11:09 America/Buenos_Aires; see the completed-panel checklist
below). There is no other accepted administration UI change beyond
#124/#125/#126, and no production promotion was performed or authorized.

The earlier #125 remote-implement timeout (run 38057127365) and its recovery
reapplication, and the #126 review-cycle timeout (run 38249742354) with its
READY recovery reapplication through run 38255595340, are historical and
superseded by the accepted PR #131 merge above; they must not be treated as
current blockers.

## Local execution and deterministic CI

GitHub Actions contains only `.github/workflows/ci.yml`, triggered by pushes
to `main` and pull requests. It runs pinned dependency installation, lint,
format, typecheck, OpenAPI drift, Worker tests, and harness tests with
read-only repository permissions and no Cloudflare credentials. There are no
agent, approval, deployment, or promotion workflows.

Implementation and review agents run locally through OpenCode/Herdr in
isolated ticket worktrees. Preserve approved-ticket scope, TDD where possible,
repository gates, and independent exact-HEAD Standards and Spec reviews.
Sandbox and production release commands are local, explicit operator actions;
production retains its explicit confirmation boundary. See
`docs/agents/opencode.md` and `docs/operations/sandbox-release-runbook.md`.

The former hosted agent/deployment workflows and their approval automation
were retired by implementation ticket #171. Their historical run evidence
does not describe the current execution path. Local agent, review, deploy, and
provision scripts remain available where used by local operations.

### Current orchestration state

The [bounded startup diagnosis](https://github.com/JonatanGarbuyo/user-service-platform/pull/109#issuecomment-5944424053) is historical. The maintainer approved the Standards model recovery in [source-ticket decision5952117927](https://github.com/JonatanGarbuyo/user-service-platform/issues/82#issuecomment-5952117927). Main commit `9cc8e30d0d5ac002d0b5a82d2ff9863b1bc56d88` adopts only the independently reviewed and exact-HEAD-CI-tested operational configuration, matching marker identity, provenance instructions and regression fixtures. Read live reviewer configuration rather than copying model assignments from this checkpoint.

The former Standards startup and trusted-approval blockers are resolved and merged on main through PR #109. The temporary runner probes were removed in main commit `3ed03977cce66bdd4029f7eddc93b0fa8d138440`; the agent workflows reinstall dependencies deterministically (`npm ci`) before quality gates, so no dependency-restoration blocker remains. The extra Standards-looking report emitted by Spec in run `36954225501` has an invalidated marker and remains informational. Every configured reviewer must publish only its own axis; legacy model identities never satisfy the recovered configuration.

#114 (local Matt skill dependencies) and #115 (its publication) are closed/completed on main at `e885e1c84460b2af6c7aeceac156314645febba1`. The 25-GitHub-run skill-usage audit is complete and recorded in the Product frontier section above; no ChatGPT conversation dataset exists and none is inferred. Skill-evidence work (#116/#117, PR #118) and the manual-QA mailbox slice (#119, PR #120) are closed/merged. #121 (release reconciliation for the operator-authorized three-recipient sandbox configuration plus the 2026-10-07 manual Identity acceptance) is closed/completed via PR #122. Recovery #127 is completed via merged PR #128 (main `87fe7c15770835d7b03f511868262d0c66e80d94`; CI 37853951844 and sandbox deploy 37853951800 succeeded). #124 is accepted and closed via merged PR #129 (main `c24215b84019f8b42887854a3a9559399d33c3a9`); sandbox deploy run 38057103943 succeeded on that commit. #125 is accepted and closed via merged PR #130 (main `324933913cff9100bedd1d2d80b39740a72b1429`; CI 38249267972, sandbox deploy run 38249656941 succeeded). #126 is accepted and closed via merged PR #131 (main `9a5e0c75717a6e4707e9964aa550ffbd9a091f52`; reviewed HEAD `62e174d9ed0ca73733a9e69e18b26b4ecd6506e1` with Standards PASS 6125453202, Spec PASS 6125480704, exact-HEAD CI 38251894375, READY recovery 38255595340; main CI 38258618931 and sandbox deploy/smoke 38258618860 succeeded). Parent spec #123 is closed/completed by operator acceptance comment 6126035306. At that time, current work was ticket #132 (release-state reconciliation of this checkpoint and checklist); it introduced no product, architecture, or deployment change. That #132-active status is historical and superseded by the Reviewer lifecycle section below (#132 closed via PR #133; diagnostics #140/#141 completed; current backend product planning is map #146). Run the configured review cycle on the published HEAD, preserve independent reviewer identities and exact-HEAD evidence, and reconcile any new finding or moved HEAD against live GitHub.

### Administration UI checkpoint (2026-10-09)

The earlier recovery HEAD `1b5728efcafd3b198c4c8e9d7f3eebd2cef926ec`
lacked the `admin/` workspace, and fix-cycle run 37934380444 timed out without
publishing a correction. Those implementation failures are historical: the
separately authorized ChatGPT operator completed the genuine pinned Marmelab
kit workspace directly on the same PR, preserving approved contracts.

Real browser CI exposed a conditional-asset regression: a `304` from the SPA
entry fallback became JSON `404` because `Response.ok` excludes revalidation.
The HTTP regression reproduced that failure and the correction preserves the
`304` and ETag. Temporary routing diagnostics were removed.
[CI 38005945830](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38005945830)
passed on executable HEAD `00b516c8d90b3545d756041e9cc913b972ddc238`:
156 Workers tests and 752 harness tests, including the complete real browser
acceptance against isolated temporary D1. This covers administrative login,
reload/logout, regular-User denial with its session preserved, service retry,
expiry, routing and keyboard/mobile behavior.

PR #129 is merged and issue #124 is accepted and closed; the first-slice panel
described above is deployed to sandbox (run 38057103943, success). PR #130
is merged and issue #125 is accepted and closed; the protected User listing
with literal email search and bounded server pagination is deployed to
sandbox on main `324933913cff9100bedd1d2d80b39740a72b1429` (deploy run
38249656941, success). PR #131 is merged and issue #126 is accepted and
closed; the real read-only User detail with safe deep links and
matched-route telemetry is deployed to sandbox on main
`9a5e0c75717a6e4707e9964aa550ffbd9a091f52` (main CI 38258618931 and sandbox
deployment/automated smoke 38258618860, both success). The former "#126
active on its isolated ticket branch" text is historical and superseded by
that merge. Local listeners are
restricted in the ChatGPT execution environment, so remote CI is the authority
for full browser/Worker execution. GitHub/OpenCode evidence is not a ChatGPT
conversation or evidence of private conversation content.

### Completed read-only panel sandbox acceptance checklist (2026-10-12)

Source evidence: accepted product main `9a5e0c75717a6e4707e9964aa550ffbd9a091f52`
(#124 via PR #129, #125 via PR #130, #126 via PR #131). Final #126 reviewed
HEAD `62e174d9ed0ca73733a9e69e18b26b4ecd6506e1` passed configured Standards
([6125453202](https://github.com/JonatanGarbuyo/user-service-platform/pull/131#issuecomment-6125453202)),
configured Spec
([6125480704](https://github.com/JonatanGarbuyo/user-service-platform/pull/131#issuecomment-6125480704)),
[exact-HEAD CI 38251894375](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38251894375)
including genuine isolated Worker/D1 Chromium acceptance, and
[READY recovery cycle 38255595340](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38255595340).
[Main CI 38258618931](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38258618931)
and [sandbox deployment/automated smoke 38258618860](https://github.com/JonatanGarbuyo/user-service-platform/actions/runs/38258618860)
both succeeded on the accepted product source. Operator acceptance is
([#123 comment 6126035306](https://github.com/JonatanGarbuyo/user-service-platform/issues/123#issuecomment-6126035306),
2026-10-12, 11:09 America/Buenos_Aires): user-reported observations, not
ChatGPT browser observations.

- [x] Sandbox deployment of the accepted main reports success (run 38258618860).
- [x] Configured automated sandbox smoke reports success (same run).
- [x] Operator as administrator (`ingaladev@gmail.com`): search -> open real User detail -> reload -> back -> sign out — observed OK per user report.
- [x] Operator as regular User (`cronistadev@gmail.com`): administrative access denied — observed OK per user report.
- [x] Missing-User URL, clear and multi-page pagination: automated validation evidence only (reviewed real Worker/D1 browser/HTTP suite on PR #131); not individually reported manually and not marked as manually observed.
- [x] No production promotion is authorized by this checklist; none was performed.

## Reviewer lifecycle and structured error diagnostics (2026-10-14)

Spec #134 and slice #135 are accepted and closed via merged PR #136
(`5eee5bacc41d0f5db5050e233312757f7a5c5ad6`). Configured Standards PASS
`6131563456` and Spec PASS `6131587502`; exact-HEAD CI `38299332952`
succeeded after maintainer approval; post-merge main CI `38489267066`,
sandbox deployment/automated smoke `38489267070` and Pages `38489266293`
succeeded. Completion record:
https://github.com/JonatanGarbuyo/user-service-platform/issues/134#issuecomment-6158017483.

The additive `lifecycle` summary reuses the shared safe worker lifecycle
summarizer and is persisted alongside the existing skill-evidence record. It
distinguishes zero captured lines (`unavailable`) from recognized protocol
progress such as `step_start` without tool calls; protocol progress does not
imply skill invocation, session attribution, reviewer success, or approval.
Ticket #138 adds the additive structured `errors` summary on the same shared
projection: exact permitted protocol error names, validated APIError HTTP
status (finite integer 100..599) and literal boolean retryability only.
Missing/unsupported/invalid metadata stays explicitly unknown/unclassified;
raw names outside the whitelist, messages, stacks, headers/bodies,
metadata/cause, provider identifiers, prompts, reasoning, tool input/output,
commands, recipient data and credentials are never stored or logged. Reported
retryability has no execution authority. Raw event fields are not persisted,
and truncation/malformed input is reported honestly. Collection remains
best-effort on success, failure and timeout and never masks the original
outcome, termination, review approval, READY or CI gates.

Spec #140 and implementation ticket #141 are accepted and closed via PR #142
at main `a88774e6b5a7433c0c185b0152a5c10c634f2728`. Main CI 38626007788,
sandbox deployment/automated smoke 38626007604 and Pages 38626006600
succeeded; completion record is #140 comment 6176933913. Spec #137 and
slice #138 are completed via merged PR #139 at
`23c81a21529381598aba692fbf96e84535a46c4c` (main CI 38500280946 and
sandbox deployment/automated smoke 38500281039 succeeded, per the #141
ticket record); the prior #138-active status is historical. #140 recovers
bounded exact-HEAD CI read failures without rerunning agents: up to two
consecutive failed check-run reads recover in the same review cycle against
the existing 72-attempt/10-second budget, the third consecutive failure stops
BLOCKED, and any successful read resets the consecutive-error state. The two
historical implement failures (runs `38265600704` and `38267513787`) retain
only one error event with no tools; their cause remains unproven, as does any
live failure-rate improvement. Do not launch an identical third execution of
#135, change model, timeout, retry, permission, workflow, or gate
configuration, or infer provider/CLI cause without new evidence and
authorization. When GitHub approval is needed, give the user the exact run
link and let them approve; use the integration, no browser login.

Current diagnostic frontier is parent spec #143 (remove wall-clock CI
polling waits from the real review-cycle regression tests) plus
implementation ticket #144 (implemented by PR #145, pending final operator
acceptance). Ticket #144 keeps the real review-cycle CLI as the highest test
seam and confines accelerated time to its spawned test child; production
polling policy, workflow, approval, model and gate configuration stay
unchanged.

## Maintenance debt

- #38 `Audit deprecated transitive dependencies and npm security findings`: closed/completed.
- The read-only administration increment is closed/completed: #123 (admin parent spec) is closed, #124 is closed (PR #129 merged), #125 is closed (PR #130 merged), #126 is closed (PR #131 merged) and #127 is completed via PR #128. #121 is closed (PR #122 merged), and #116 (skill-evidence parent spec), #117 (its implementation slice), and #119 (manual-QA mailbox) are closed with PRs #118 and #120 merged alongside the earlier #109, #110, #112 and #115. Checkpoint reconciliation #132 is closed/completed via PR #133 (main `6ce361f488d8fd6e295abfb41c78a200d31953b1`), reviewer diagnostics #134/#135 are closed/completed via PR #136 (main `5eee5bacc41d0f5db5050e233312757f7a5c5ad6`), reviewer error diagnostics #137/#138 are completed via PR #139 (main `23c81a21529381598aba692fbf96e84535a46c4c`), and CI read recovery #140/#141 is completed via PR #142 (main `a88774e6b5a7433c0c185b0152a5c10c634f2728`). The current product route is map #146; maintenance #143/#144 is implemented by PR #145, pending final operator inspection. Query live GitHub before selecting work.

- #114 vendored the missing local `grilling` and `codebase-design` dependencies identified by the v1.3 audit. Retro/pr adoption and an implement-spec integration workflow remain follow-up decisions, not part of this maintenance task.

## Maintaining this checkpoint

Update this file when product frontier, execution/review workflow, environment terminology, final-operator authority, or a cross-session blocker changes materially. Do not duplicate volatile model assignments or full ADR/spec/ticket bodies here.
