# Probe report: safe reviewer-progress capture + one Standards attempt for PR #154

> Historical research record only. This retired workflow is not operational guidance.

Date: 2026-10-15. Source ticket: #161 (`ready-for-agent`), parent spec #160,
diagnostic evidence #158 / PR #159. Ticket branch:
`ticket/161-implement-safe-reviewer-progress-capture-and-one-standards-p`.

Target (pinned): PR #154
(`ticket/152-recovery-consumer-client` -> `main`, OPEN) at HEAD
`93171c25ecc6d2f360d94c8d02af5e773b65defa`. Verified unchanged immediately
before the live attempt and again after; no substitution of another revision.

## What was built (committed before the live attempt)

Commit `64b50f0` on the ticket branch (recoverable before any live observation):

- `scripts/review/reviewer-progress.ts` (new): timeout-resilient progress
  projection reusing the shared `summarizeWorkerLifecycle` seam, plus an
  incremental probe with injectable clock/filesystem. Only allowlisted
  timestamps, event/tool counts and names, lineage, status and completeness
  enter durable evidence. Observer cadence (`sequence`, `observedAt`) is
  labeled observer metadata and never counts as reviewer progress; zero
  captured worker lines stays `unavailable`. Persistence failures log a fixed
  metadata-only message and never throw, so capture can never mask the worker
  outcome or timeout classification.
- `scripts/review/evidence-streaming-executor.ts` (additive): the shipped
  executor used by review-cycle Standards/Spec/correction workers now starts
  the probe (60 s cadence, `.review-cycle/progress/`, git-ignored) and stops
  it on settle. Enabled by default with an explicit `{ enabled: false }`
  opt-out. No model, bound, retry, permission, approval, marker or CI change.
- `test/node/review-reviewer-progress.test.ts` (new, 13 tests): projection
  literals, unavailable-on-empty, heartbeat-is-not-progress, secret-safety
  (fake `sk-ant-`/`ghp_` markers never persist), and shipped-executor tests
  with real subprocesses under controlled short bounds proving incremental
  snapshots survive timeout, silent timeouts stay explicitly unavailable, and
  probe failures never mask worker success/failure.

Verification on the ticket branch: 13/13 new tests pass; `tsc --noEmit`,
`npm run check` (ESLint + Prettier) clean; neighboring suites pass
(`review-worker-error-metadata`, `review-skill-evidence-routing`,
`review-run-summary`).

## The one live Standards attempt

Exactly one normal configured command, launched 16:45:43Z from the ticket
worktree through the shipped executor with default probe settings:

```text
opencode run --auto --format json --command review-standards 154
```

Bound: `REVIEWER_TIMEOUT_MS` = 20 minutes, unchanged. Model: the configured
Standards reviewer (MiMo). No product, workflow, command, retry, approval,
marker or CI edits. Observer tooling (throwaway driver) stayed in
git-ignored worktree paths; nothing entered PR #154 contents or HEAD.
No second attempt was launched.

## Honest limitation: supervision was lost, incremental capture did not run live

The background driver was reaped by the tool-call shell ~30-60 s after
launch (log shows start plus one 30 s heartbeat, then nothing); the
`detached: true` opencode worker survived — the known orphan pattern from
the ticket #31 context. The first 60 s probe tick therefore never fired:
no `.review-cycle/progress/` snapshot and no skill-evidence finalization
exist for this attempt. The probe's capture mechanics stand on the 13
controlled-bounds regression tests above, not on this run. Future probes
must run in the foreground with an explicit call timeout so supervision
survives the full bound.

## Actual configured outcome (durable, on PR #154)

The single worker completed inside its bound and published its report at
16:59:30Z (~13m45s wall time):

- `## Standards review — MiMo-V2.6-Flash`, reviewed HEAD exactly
  `93171c25ecc6d2f360d94c8d02af5e773b65defa`.
- Marker: `<!-- review-result: axis=standards model=mimo-v2.6-flash
head=93171c25ecc6d2f360d94c8d02af5e773b65defa result=NEEDS-DECISION -->`.
- 0 hard documented-standard violations; 7 judgement-call smell findings
  (worst: duplicated browser-fixture helpers); 2 decision items: ratify the
  ADR-0007-deferred distribution (`docs/operations/consumer-client.md`
  vendoring) and compat-tool choices, and the TypeScript 5 codegen exception
  against ADR-0006.

## Diagnostic reading (facts first, no new cause claimed)

- The identical command that timed out twice at this exact HEAD (runs
  `38740905612`, `38759201551`) completed in ~14 minutes this time with a
  verdict. Attempt 1 (run `38731980384`) showed productive work to ~35 s
  before its kill. One sample cannot separate intermittent stall from
  workload variance; attempts 2-3 capture remains honestly `unavailable`.
- A subprocess start or another model's success was not equated with
  Standards transport health at any point.

## Recommended one next step

Run ONE more single-axis Standards probe in the foreground (explicit
~25-minute call timeout so supervision survives) with the now-committed
incremental capture active, to obtain minute-level progress snapshots on
this HEAD. Then decide bound-vs-stall on evidence. Do not blind-retry the
fix-cycle. Independently, PR #154's NEEDS-DECISION now needs operator
decisions on the two ADR records regardless of any probe.

## Scope respected

No deadline/model/retry/approval/marker/CI changes; no product edits; no
second attempt; no merge, deploy, push, package publication, or secret
mutation. This branch's PR publication, configured independent reviews and
exact-HEAD CI remain for the operator path (this environment does not push).
