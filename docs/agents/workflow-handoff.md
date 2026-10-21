# Pane handoff

The repository uses explicit local pane responsibilities rather than an
automated reviewer/correction loop:

```text
p2 implements or corrects -> p3 reviews directly -> p1 coordinates and decides
```

P2 hands the exact branch, commit, ticket acceptance evidence, changed-file
summary, and gate results to P3. P3 reports Standards and Spec findings
directly against that exact commit; P2 applies valid corrections and reruns the
repository gates. P1 resolves escalation, inspects CI, merges, and operates
releases.

GitHub Actions remains a quality-gates boundary only. It has read-only
repository permissions and does not run agents, reviewers, correction loops,
approval automation, deployments, or promotions.

`review:safe-push` remains available as an independently tested, narrow branch
publication guard. It is not a review orchestrator and never merges or deploys.

When a change touches workflow files, P1 performs any separately authorized
publication step. No automated workflow-file handoff or reviewer marker is
required.
