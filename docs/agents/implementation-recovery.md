# Implementation recovery evidence after worker timeout/failure

Ticket #127 policy. Two `/implement` executions for the administrator UI
reached the then-current 30-minute bound with no published ticket branch or
PR, and the existing recovery evidence preserved outcome/skill records but
not the unpublished partial source changes. A retry therefore reran
implementation blindly. This record closes that execution gap without
changing product scope, timeout bounds, or publication safeguards.

The active contract is local: `.agent-ticket/outcome.json` remains in the
failed isolated worktree for the operator to inspect and reapply locally.
Older hosted artifact handling is historical only and is not part of the
current execution path.

Current bound (tickets #155/#156): the implementation hard deadline is now
60 minutes, with the ticket workflow backstopped at 150 minutes and the
correction workflow at 120 minutes. The historical 30-minute timeouts above
are preserved as evidence; they are not retroactively reclassified.

## What is captured

When the `agent-ticket` implement worker times out or fails, repository-owned
code captures a bounded secret-safe recovery record **after** bounded worker
termination has been established (SIGTERM, SIGKILL escalation after the kill
grace, process-group exit verification, finite termination deadline; the
original `TIMEOUT`/`BLOCKED` classification is preserved and a plain failure
is never converted to `TIMEOUT`). On both paths a direct-child close
or error alone never establishes termination while the process group stays
alive. When termination cannot be established within its bound, no worktree
snapshot is read: honest `unavailable` evidence is retained instead so the
record never races a still-writing implementer. The record is written
additively to `.agent-ticket/outcome.json` in the failed isolated worktree.
No workflow-file edit or new credential is needed for local recovery.

The record carries the actual failed-worktree state, never the start HEAD
presented as proof of no progress:

- original base SHA, actual local HEAD, ticket branch;
- bounded counts (committed, uncommitted, untracked, included, excluded);
- explicit completeness/truncation/unavailability metadata;
- one bounded combined patch for eligible tracked changes since the base
  (local commits plus uncommitted tracked edits/deletions);
- bounded full contents for eligible untracked source files;
- safe worker-lifecycle diagnostics (allowlisted event/tool names, counts,
  timestamps, last-known status only, plus the additive bounded structured
  `errors` summary from the shared projection: exact permitted protocol error
  names, validated APIError HTTP status and literal boolean retryability;
  missing/invalid metadata stays unknown/unclassified and no raw error content
  is retained);
- workflow-file metadata (paths only) when the failed worktree touches
  `.github/workflows/**`, pointing back to the trusted-publication handoff
  policy instead of carrying workflow patch content.

Capture performs read-only Git/filesystem operations only, within finite
deadlines (30s per Git command, 10s per untracked-file read, 60s overall
capture). Snapshot size limits are enforced as UTF-8 bytes (50 paths, 32 KiB
per file, 256 KiB total; truncation never splits a character) and untracked
reads never load more than the remaining budget into memory. It never stages,
commits, resets, cleans, pushes, opens a PR, merges, or deploys. Its failure
keeps honest incomplete/unavailable metadata and never replaces the original
`TIMEOUT`/`BLOCKED` result. Console and issue-status surfaces expose only a
fixed safe summary (presence, completeness, counts); source patch content
stays in the local outcome record.

## What is deliberately omitted

Eligibility is path-based through an explicit allowlist
(`scripts/review/implementation-recovery.ts`): source, test, docs, migration,
and non-secret build-config roots plus named top-level config files. The
following never enter recovery artifacts, diagnostics, or console output:

- `.env`/`.env.*` including `.env.example` at the root and in nested variants,
  and `.dev.vars`/`.dev.vars.*` variants (a worker-modified copy may carry
  secret values even when the committed template does not);
- logs, local D1/SQLite state, build outputs, `node_modules`, runtime
  data, exports/transcripts, and other secret-bearing runtime files;
- credential/key file extensions (`.pem`, `.key`, `.p12`, `.pfx`, `.jks`);
- symlinks (never followed) and any path outside the worktree;
- workflow-file patch content (metadata only; the trusted-publication
  boundary in `docs/agents/workflow-handoff.md` still applies);
- raw prompts, reasoning, text events, tool inputs/outputs, HTTP payloads,
  shell command strings, recipient addresses, credential values, and
  session/verification tokens.

## Operator recovery procedure (recovery, not a blind rerun)

A `TIMEOUT`/`BLOCKED` implement outcome with recovery evidence is not a
diagnosis of an application defect and does not claim the underlying ticket
work is fixed. It only preserves real partial progress for operator-driven
reuse:

1. Keep the failed isolated worktree intact and read
   `.agent-ticket/outcome.json` from that worktree. Inspect the `recovery`
   field: check `status`, `reasons`, `counts`, `workflowFiles`, and the
   `truncated`/`patchTruncated`/`untrackedTruncated` flags.
2. If `workflowFiles` is non-empty, follow the trusted-publication handoff
   policy first; do not publish workflow changes through ordinary automation.
3. On a fresh isolated worktree checked out at the recorded `base` (never on
   a dirty or unreviewed branch), save `recovery.combinedPatch` from the local
   record to a file and
   run `git apply --check` followed by `git apply`; then create each
   `recovery.untrackedFiles` entry at its recorded `path` with its recorded
   `content`.
4. Treat truncated/incomplete records as partial: missing material was
   deliberately bounded out and must be re-authored, not assumed present.
5. Run the repository quality gates on the recovered worktree and continue
   through the normal implementation/review path; recovered code is still
   unreviewed until Standards, Spec, and exact-HEAD CI pass.

Do not apply recovery output onto a dirty worktree, do not push recovered
code without review, and do not rerun `/agent-ticket` on the failed branch
expecting it to resume: the failed branch was never published, so a fresh
isolated worktree plus explicit reapplication is the only supported reuse.
