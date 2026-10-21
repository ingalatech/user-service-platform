# Diagnostic: repeated Standards review timeout blocking PR #154

> Historical research record only. This retired workflow is not operational guidance.

Date: 2026-10-15. Source ticket: #158 (`ready-for-agent`, bounded
research/diagnostic slice). Base: main at
`805b3629aa20e0bf0e437fd24c9271635ede39d9` (includes PR #157).

Scope: determine why configured Standards review repeatedly exhausts its
20-minute bound on PR #154, using actual workflow jobs/logs, durable
status, review summaries and per-worker lifecycle/skill artifacts.
Separate observed facts from hypotheses below.

Non-goals for this slice (per ticket): no rerun of PR #154, no replay of
full product suites for diagnosis, no model/bound/retry/approval change,
no fabricated PASS, no merge/deploy, no runtime/workflow/command/model
configuration edits. Any behavior or policy fix needs a separately
scoped follow-up.

## Pinned references

- PR #154 (`ticket/152-recovery-consumer-client` -> `main`, OPEN):
  HEAD `93171c25ecc6d2f360d94c8d02af5e773b65defa` (commits `7439225` +
  `93171c2`); base `f8785394810203cd76f663997be3074fe4e73ef8`.
  Diff at HEAD: 32 files, +6634/-5 (per Spec report), purely additive
  plus required config exclusions.
- Parent spec #150, implementation ticket #152, decision #149,
  ADR-0013; predecessor slice #151. Standards remains 20 minutes by
  approved scope (PR #157 raised only implementation to 60 minutes).
- Inspected fix-cycle runs (all `agent-fix-cycle`, conclusion `failure`
  via Standards TIMEOUT):
  - `38731980384` at HEAD `7439225` (previous HEAD).
  - `38740905612` at HEAD `93171c2` (current HEAD).
  - `38759201551` at HEAD `93171c2` (current HEAD).
- Exact-HEAD CI `38742149831` at unchanged HEAD `93171c2`: SUCCESS
  (operator record, PR #154 comment 2026-10-15T15:18:44Z).
- Comparison: PR #157 run `38759200656` at HEAD `420325af`
  (7-file workflow/test/docs diff): review cycle success in ~11 min,
  Standards PASS in 5m41s with the same reviewer model.

## Attempt 1 — run 38731980384 (HEAD 7439225)

Review cycle `12:11:01Z`–`12:33:54Z` (22m53s):

| Phase            | Window (UTC)      | Duration      | Outcome / evidence                                                                                                         |
| ---------------- | ----------------- | ------------- | -------------------------------------------------------------------------------------------------------------------------- |
| address-review   | 12:05:37–12:07:22 | ~1m45s        | success, no HEAD change (reviewed HEAD `7439225` unchanged; `93171c2` landed later at `2026-10-15T13:18:11Z` in Attempt 2) |
| quality gates    | 12:07:36–12:10:59 | 3m23s         | success                                                                                                                    |
| Standards worker | 12:11:03–12:31:03 | 1200s (bound) | TIMEOUT; zero parent-stdout lines, only `still running (waiting for output)` every 30s                                     |
| Spec worker      | 12:31:04–12:33:52 | 2m48s, exit 0 | PASS published 12:33:31Z                                                                                                   |

Actual progress evidence (this attempt only):

- Standards published a detailed FAIL at 12:25:39Z (14m36s into its
  window): 2 blocking findings (missing `GLOSSARY.md` consumer-client
  vocabulary; three handoff/comment accuracy defects), plus re-ran
  `check`, `typecheck` and `test` 261/261 and verified the pinned
  baseline byte-identical. Publication proves productive work
  mid-window; the worker still never exited before the kill.
- Skill-evidence artifact (`review-cycle-review-standards-standards-1.json`):
  62 captured lines, 26 `tool_use` (12 bash, 5 read, 1 glob, 1 grep,
  6 edit, 1 task), window 12:25:57Z–12:30:29Z (last activity ~35s
  before termination), no errors. Coverage is `incomplete` (child
  session export missing), so the first ~14 minutes have no captured
  lifecycle lines. No evidence of a repeated test loop in parent logs.

## Attempt 2 — run 38740905612 (HEAD 93171c2)

Review cycle `13:22:28Z`–`13:46:37Z` (24m09s):

| Phase            | Window (UTC)      | Duration       | Outcome / evidence                                                                |
| ---------------- | ----------------- | -------------- | --------------------------------------------------------------------------------- |
| address-review   | 13:14:35–13:18:23 | 3m48s          | success; correction pushed `93171c2` (`2026-10-15T13:18:11Z` per commit metadata) |
| quality gates    | 13:18:40–13:22:25 | 3m45s          | success                                                                           |
| Standards worker | 13:22:32–13:42:32 | 1200s (bound)  | TIMEOUT; zero parent-stdout lines; no PR comment published                        |
| Spec worker      | 13:42:32–13:46:34 | ~4m02s, exit 0 | PASS published 13:45:45Z                                                          |

Actual progress evidence: none observable. Standards lifecycle in the
artifact is `unavailable` (`no worker events captured`, primary session
unknown). Parent log shows uninterrupted 30s heartbeats for the full
20 minutes. Whether the worker was productively slow or stalled cannot
be distinguished from available data for this attempt.

## Attempt 3 — run 38759201551 (HEAD 93171c2)

Review cycle `15:25:31Z`–`15:48:39Z` (23m08s):

| Phase            | Window (UTC)      | Duration       | Outcome / evidence                                         |
| ---------------- | ----------------- | -------------- | ---------------------------------------------------------- |
| address-review   | 15:19:21–15:22:01 | 2m40s          | success, no HEAD change (no-code outcome)                  |
| quality gates    | 15:22:12–15:25:29 | 3m17s          | success                                                    |
| Standards worker | 15:25:33–15:45:33 | 1200s (bound)  | TIMEOUT; zero parent-stdout lines; no PR comment published |
| Spec worker      | 15:45:33–15:48:37 | ~3m04s, exit 0 | PASS published 15:48:05Z                                   |

Actual progress evidence: none observable — identical gap as attempt 2
(lifecycle `unavailable`, primary session unknown, no published
comment). Same honest limit applies.

## Comparison evidence (same runner shape, same models)

- Spec (Muse Spark) on the identical large #154 diff completes in
  2m48s / ~4m02s / ~3m04s across the three runs. Runner, checkout
  and dependencies are healthy for that path, and the failure is
  Standards-specific rather than a generic outage; because Spec
  uses a different model, this does not by itself rule out
  Standards-specific model transport delay.
- Standards (MiMo) on the small 7-file PR #157 diff completes in 5m41s
  (run `38759200656`, exit 0, PASS), with the same silent-parent-stdout
  pattern until exit. Silence alone is normal for these `--format json`
  workers (JSON lines are captured, not echoed); the differentiator is
  duration against diff size (7 files vs 32 files, +6634 lines
  including generated types, examples and the browser fixture).
- Exact-HEAD CI `38742149831` SUCCESS plus in-run gates passing in
  ~3–4 minutes each time rules out a gate hang as the cause.
- Launch lag is 1–4s in every run (review-cycle start to worker
  start), proving prompt subprocess launch, not time to first model
  response; it does not rule out Standards-specific model transport
  delay. Sequential scheduling (Standards then Spec) worked as
  designed in all three runs.

## Cause assessment (facts first)

- Launch delay (subprocess start): not supported. All workers start
  within seconds, proving prompt subprocess launch.
- Standards-specific model transport delay: cannot be ruled out on
  available evidence. Worker/phase start does not measure time to
  first model response, and Spec success uses a different model.
- Nested delegation runaway: not supported. Only observed delegation
  is the single `task` tool_use inside attempt 1's partial capture;
  no evidence of repeated or nested worker launches.
- Repeated tests: not supported as a loop. Attempt 1's reviewer
  re-ran verification suites once as documented in-scope work; parent
  logs show no repeated gate/test cycles.
- Productive review exceeding the bound: best-supported. Attempt 1
  proves the Standards workload on this diff is productive well past
  14 minutes (published FAIL) and active to 35s before the kill, yet
  still exceeds 20 minutes. The small-diff comparison completing in
  5m41s with the same model is consistent with diff size/complexity as
  the driver. Attempts 2–3 are consistent with the same cause but,
  honestly, their missing lifecycle capture means a silent stall
  cannot be excluded for those two.
- Unavailable events are not proof of inactivity or provider failure:
  attempts 2–3 have zero captured events, so no stall/provider claim
  is made for them. Maintenance PR #145's independent conflict is not
  evidence of this failure's cause (per ticket).

## Best-supported cause and evidence gap

Best-supported: the Standards review workload for the 32-file #154
diff exceeds the approved 20-minute bound while productively working
(proven once by attempt 1). For attempts 2–3 at HEAD `93171c2`,
lifecycle capture is `unavailable`, so the report explicitly records
insufficient evidence to separate slow-productive from stalled — the
smallest useful diagnostic probe is a single configured Standards
execution at the unchanged HEAD that preserves command, model, bound
and exact-HEAD marker semantics while persisting a timeout-resilient
progress signal (session export / incremental tool heartbeat) to the
run evidence. That probe needs a separately scoped follow-up because
this slice forbids workflow edits.

## Recommended one bounded next step

Do not issue another blind `/agent-fix-cycle` retry: three identical
20-minute Standards timeouts already exist at two HEADs. Open one
narrowly scoped follow-up ticket to (a) add a secret-safe,
timeout-resilient Standards progress probe without changing the
20-minute bound, models, retry/approval policy or exact-HEAD marker
rule, then (b) run a single configured Standards attempt at unchanged
HEAD `93171c2` under that probe through the normal cycle path. If the
probe shows productive work passing 20 minutes, escalate the bound
question to the operator as a policy decision; if it shows a stall,
investigate the Standards worker transport. No PASS fabrication, no
weakening of independent/exact-HEAD acceptance.

## Evidence links

- Ticket #158; PR #154 (HEAD `93171c2`); spec #150; ticket #152;
  decision #149; ADR-0013.
- Runs: `38731980384`, `38740905612`, `38759201551`; CI
  `38742149831`; comparison run `38759200656` (PR #157).
- Review comments: Standards FAIL + Spec PASS on run `38731980384`;
  Spec PASS on runs `38740905612` / `38759201551`; CI SUCCESS record
  (PR #154 comment 15:18:44Z).
- Config inspected as needed only: `.opencode/commands/review-standards.md`,
  `.opencode/agents/reviewer-standards.md`,
  `scripts/review-cycle.ts`, `scripts/review/worker-stream.ts`,
  `scripts/review/worker-timeout.ts`,
  `scripts/review/evidence-streaming-executor.ts`,
  `.github/workflows/agent-fix-cycle.yml`, `docs/adr/0013-reusable-consumer-jwt-snapshots.md`.
- Per-run artifacts used above: `agent-fix-cycle-evidence-154` from
  each run (`.review-cycle/latest.json` plus `review-cycle-review-standards-*.json`
  / `review-cycle-review-spec-*.json` skill evidence).

Secret-safety: this report cites only timestamps, durations, tool
counts, file paths and outcome markers. No credentials, tokens,
prompts, reasoning, tool I/O, email bodies or customer data are
included; unavailable data is reported as unavailable.
