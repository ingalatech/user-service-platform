# Automated dual-review cycle

One deterministic command runs the complete Standards + Spec review and
correction loop from a ticket branch with an open pull request:

```text
npm run review:cycle
```

The orchestrator (`scripts/review-cycle.ts`) is deterministic repository code,
not another LLM agent. It invokes the existing OpenCode commands as workers,
reads only machine-readable review markers, and never infers pass/fail from
prose.

## Prerequisites

- Work on an isolated ticket branch (`ticket/<number>-...`, or
  `feat|fix|chore/<number>-...`).
- Push the branch and open a draft PR before running the cycle.
- Start from the worktree root.

## Usage

```text
npm run review:cycle
npm run review:cycle -- --max-cycles 3
npm run review:cycle -- --pr 42 --no-push
npm run review:cycle -- --no-bell
```

Options:

- `--max-cycles N` bounds correction cycles (default 3).
- `--pr <number|url>` reviews a PR other than the current branch's PR.
- `--no-push` skips the safe-push after a correction commit (pushing is on by
  default so the PR tracks the corrected HEAD).
- `--no-bell` disables the audible terminal notification for terminal states
  (`--bell` re-enables it; the bell is on by default in interactive TTY use).

A successful run ends with:

```text
READY FOR FINAL ACCEPTANCE
HEAD: <sha>
Standards: PASS — MiMo
Spec: PASS — Muse Spark
CI/local gates: PASS
Cycles: <n>
```

## How one cycle works

1. Resolve the PR for the current ticket branch and compare the PR head with
   the local HEAD. If they diverge, push the local HEAD through the
   deterministic safe-push path and wait for the PR head to catch up (or
   abort under `--no-push`). The loop never reviews a SHA the PR does not
   point at.
2. Run both axes sequentially as `opencode run --auto` workers:
   `/review-standards` (MiMo-V2.6-Flash) then `/review-spec` (Muse Spark 1.3 Contributor Free). Both axes stay independent with their own exact-HEAD markers, evidence, and bounds; only the launch order is sequential so two workers never hold the shared OpenCode profile store concurrently. A valid `FAIL` on the first axis never skips the second, and an infrastructure error is surfaced unchanged after the other axis is attempted. Each
   custom command's frontmatter is the single source of truth for its
   configured subagent/model, so no `--agent` flag is passed. Explicit `deny`
   rules remain effective under `--auto`. Workers stream stdout/stderr live
   with `[standards]`, `[spec]`, and `[address-review]` prefixes plus
   `started`/`completed`/`failed` lifecycle lines and a silence heartbeat,
   so the long-running command never looks frozen; short git/gh/npm
   commands stay on the buffered path.
3. Collect PR comments and keep only the latest machine-readable marker per
   axis for the exact current HEAD SHA, and only from the configured model
   family for that axis (Standards is MiMo, Spec is Muse Spark). Stale markers
   from older HEADs are ignored when a newer report for that axis exists.
   Results are never inferred from prose: if an axis published without its
   marker, only that axis's worker is retried (bounded to 2 attempts per
   axis) before escalating.
4. If both axes report `PASS` for the current HEAD, run the repository
   quality gates (lint, formatting, typecheck, OpenAPI drift, Workers tests,
   Node/harness tests), then verify the PR still points at the reviewed HEAD
   and poll CI checks for that exact commit until they succeed, fail, or
   time out (an empty check list never counts as success) before finishing
   ready for final acceptance. Check-run read recovery (ticket #141) applies
   inside this poll: the first and second consecutive failed check-run reads
   wait 10 seconds and reobserve the same SHA in the same cycle, and the
   third consecutive failure stops `BLOCKED`.
5. If a valid blocking `FAIL` exists, invoke Muse through the existing
   `/address-review` workflow for the smallest in-scope correction, commit
   locally, then rerun both axes against the new HEAD.
6. Stop after the bounded number of correction cycles instead of looping
   indefinitely, and stop immediately when a finding reports `NEEDS-DECISION`.

## Exact-HEAD CI read recovery

CI observation reads the authoritative commit check-runs for the reviewed
SHA, plus a read-only exact-HEAD CI workflow observation for zero-job runs. A failed read is not a
worker failure and never becomes `FATAL` or a fabricated `PASS`:

- Up to two consecutive failed check-run reads recover in the same cycle:
  each failed read consumes one of the existing 72 total poll attempts and
  waits the existing 10 seconds before the next observation. There is no
  nested retry budget, and no wait happens after the final allowed
  observation or after the third consecutive failure.
- Any successful fetch clears the consecutive-error state, even when the
  checks are still pending or empty. The final
  summary reflects the last authoritative result.
- Genuine CI failure and `action_required` both fail fast; the latter has no
  local approval route after hosted approval workflows were retired. Missing
  and pending checks remain non-success and are polled within the existing
  bound. Standards, Spec, correction, and gate invocations are unchanged
  during observation; no approval dispatch is sent.

Operator distinction: an unreadable end (`cannot prove CI checks for the
reviewed HEAD`) means GitHub could not be read — it is not evidence about
the commit. Repeated reads inside the same still-running cycle reobserve
the same SHA without launching additional reviewers, corrections, or
gates; a new invocation after terminal unreadable `BLOCKED` reexecutes
the normal review/gate flow. Unreadable `BLOCKED` leaves CI unproven and
requires operator inspection of the exact-HEAD checks/evidence before
choosing recovery; it does not reuse prior reviews. There is no CI-only
resume mode. An observed nonpass (`CI checks for the reviewed
HEAD are not successful`, including `action_required`) reports what CI
actually said. Resolve approval-required runs outside the local review flow,
then rerun `review:cycle`. No claim is made about why a historical read failed.

Both axes stay independent: one axis never cancels or reranks the other, and
Muse is invoked only when blocking findings require an in-scope code
correction. Findings that need a product, architecture, public-contract,
infrastructure-provider, or security-policy decision escalate to planning
instead of changing code.

## Lifecycle diagnostics in skill evidence

Finalized review/correction workers add an optional `lifecycle` summary to the existing skill-evidence JSON. It reuses the implementation-recovery summarizer and records bounded captured-line counts, allowlisted event/tool counts, validated timestamps/duration, last status, malformed/unknown counts, coverage reasons, and capture truncation.

The same `lifecycle` record carries an additive bounded `errors` summary from
the single shared projection (`summarizeWorkerErrors`). It counts top-level
`error` events by exact permitted protocol name (`APIError`,
`ProviderAuthError`, `MessageOutputLengthError`, `MessageAbortedError`,
`StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`,
`UnknownError`; missing/unsupported names use the fixed `unknown` bucket) and,
for recognized `APIError` only, validated HTTP status (finite integer
100..599) and literal boolean retryability. Missing/invalid metadata stays
explicitly unknown/unclassified with no coercion. No raw names outside the
whitelist, messages, stacks, headers/bodies, metadata/cause, provider
identifiers, prompts, reasoning, tool inputs/outputs, commands, recipient data
or credentials enter the summary or logs, and reported retryability has no
execution authority.

This describes only the captured stdout stream, not worker success. Zero captured lines means `unavailable`; a recognized `step_start` without tool calls counts as protocol progress but creates no skill invocation or session attribution. Truncated or malformed capture is marked incomplete. Raw fields, prompts, reasoning, text, tool inputs/outputs, commands, payloads, personal data and credentials are not persisted.

Collection is best-effort on success, failure and timeout. It cannot change the original outcome, process-group termination, review approval, READY status, or CI gates. Historical failure causes and any live failure-rate improvement remain unproven.

## Review markers

Each review report ends with exactly one marker line:

```text
<!-- review-result: axis=standards model=mimo-v2.6-flash head=<sha> result=PASS|FAIL|NEEDS-DECISION -->
<!-- review-result: axis=spec model=muse-spark-1.3-contributor-free head=<sha> result=PASS|FAIL|NEEDS-DECISION -->
```

`PASS` means no blocking findings for the reviewed HEAD, `FAIL` means valid
blocking findings need correction, and `NEEDS-DECISION` escalates. The
`head` must be the exact reviewed HEAD SHA. Marker parsing and policy live
in `scripts/review/result-marker.ts` and `scripts/review/cycle-policy.ts`
with Node-seam tests under `test/node/review-*.test.ts`.

## Push safety

Models keep their explicit deny rules: no generic `git push`, no merge, no
deploy, no publishing, no secret mutation, and no destructive Cloudflare
operations. The only automated push path is the deterministic
`scripts/safe-push.ts` (also runnable as `npm run review:safe-push`), which
verifies the current branch is a ticket branch, the PR head matches it, the
base is `main`, the worktree is clean, and the push cannot target `main`.
It refuses otherwise and never merges.

## Workflow-file corrections (trusted handoff)

Corrections that touch `.github/workflows/**` stop at the trusted-publication
boundary defined in `docs/agents/workflow-handoff.md` instead of widening
model credentials. Repository-owned detection refuses the ordinary push with a
distinguishable `trusted-publication-required` `BLOCKED` state and persists a
patch/metadata bundle under `.agent-ticket/`; a trusted human or separately
authorized ChatGPT GitHub operation publishes the reviewed change, after which
review resumes against the newly published exact HEAD.

## Terminal notification and headless use

Terminal states (`READY`, `NEEDS-DECISION`, and blocked/fatal stops) emit one
audible notification only when stdout is an interactive TTY and the run
is not in CI. The notification writes BEL as an always-on baseline and
additionally plays a local sound where a supported mechanism exists
(`afplay` on macOS, desktop-theme notification sound via `canberra-gtk-play`
then `paplay` with a system sound on Linux); sound
playback is best-effort and never fails the cycle. CI and other non-TTY runs
never emit bell control characters or play sounds.
Pass `--no-bell` to disable the notification.

Headless agents do not depend on interactive questions. Human-required
decisions are surfaced as explicit escalation output (`NEEDS-DECISION`,
`BLOCKED`, or `STOPPED` lines with a non-zero exit code) rather than hidden
stdin prompts, so unattended runs can detect them without a terminal.
An unhandled failure (for example a crashed review worker) surfaces as
`REVIEW-CYCLE FATAL` with a non-zero exit code and the same bell policy.

## Unattended usage (OpenCode v1.18.x)

```bash
cd "$(git rev-parse --show-toplevel)"
opencode --auto
```

`--auto` auto-approves operations that would otherwise ask, while explicit
`deny` rules still apply. Unattended runs must still use an isolated
worktree/container/account with no production credentials, API keys,
customer data, `.env` files, `.dev.vars`, or production Cloudflare
authorization available. See `docs/agents/opencode.md` and
`docs/agents/opencode-permissions.md`.
