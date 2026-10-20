# Local publication handoff for workflow-file corrections

Ticket #36 policy. Local agent corrections may legitimately modify
`.github/workflows/**`, but the ordinary Actions `GITHUB_TOKEN` cannot create
or update workflow files, and model/OpenCode processes must never receive a
broad workflow-write credential. Product-ticket automation keeps the existing
least-privilege token boundary: none of the repository workflows grant
`workflows: write`.

## Handoff instead of privilege

1. Agent/correction work may edit workflow files locally and run the
   deterministic quality gates.
2. Before an ordinary push, repository-owned code detects changes under
   `.github/workflows/**` over the exact known commit range.
3. The local ticket/review flow does not attempt the generic push. It stops
   with a `BLOCKED` state whose reason
   carries the `trusted-publication-required` marker, which is deliberately
   distinct from ordinary safe-push validation failures (wrong branch, PR
   head/base mismatch, dirty worktree, push to `main`).
4. The local run preserves the correction patch and exact base/head metadata
   for the trusted operator who publishes the reviewed workflow change.
5. After publication, rerun `review:cycle` so both review axes report against
   the newly published exact HEAD.

The handoff is resolved by the authorized operator; this local flow does not
publish the workflow-file patch.

## Detection points

Detection lives in deterministic repository-owned TypeScript, tested at the
Node seam:

- `scripts/review/workflow-handoff.ts` — path matching, range-diff/patch
  command builders, handoff record format, and bundle persistence.
- `scripts/agent/ticket-flow.ts` — the initial ticket-branch push is refused
  when the range from `origin/main` at start through the implementation HEAD
  touches workflow files.
- `scripts/review-cycle.ts` — both the start `push-and-refresh` path and the
  post-`address-review` correction push are refused when their exact ranges
  touch workflow files.

## Evidence bundle

A blocked handoff leaves, under `.agent-ticket/`:

- `workflow-handoff.patch` — the full correction diff for the exact range
  (workflow files plus any accompanying scripts/tests/docs), so the trusted
  publisher never needs to reconstruct non-workflow changes from runner logs.
- `workflow-handoff.json` — version, branch, exact base/head SHAs, the
  workflow files that triggered handoff, patch path, and the
  `trusted-publication-required` reason.

The local runner records the outcome alongside `.review-cycle/latest.json`
and `.agent-ticket/outcome.json` for `agent-ticket` runs. There are no hosted
agent workflows or workflow artifacts in the current execution path.

## Historical hosted approval provenance

Ticket #82 added a source-ticket marker
(`<!-- trusted-workflow-handoff:v1 {...} -->`) for hosted approval provenance.
The retired hosted flow treated that marker and GitHub-owned metadata as
approval evidence. The local ticket flow no longer publishes the marker, and
the former provenance checks do not run.

The former hosted trusted approver's provenance checks required:

- an open, same-repository PR against `main`, with matching ticket/branch/title/body;
- the source ticket open and labelled `ready-for-agent`;
- a non-empty workflow-file set fully covered by a matching bot-authored
  source-ticket marker;
- the PR's canonical publication app slug `chatgpt-codex-connector`;
- independent equality between the CI run SHA and the current PR HEAD.

These are historical details only. Current CI requires no approval automation;
if a check nevertheless reports `action_required`, local `review:cycle` stops
immediately with `BLOCKED` and instructs the operator to resolve the run
outside the local flow before retry.

## Operator publication procedure

1. Review the local patch and the exact base/head metadata.
2. Publish the reviewed workflow change to the ticket branch through the
   separately authorized operator publication path.
3. Rerun review on the published HEAD so Standards, Spec, and CI evidence is
   stamped against the exact commit under review.
