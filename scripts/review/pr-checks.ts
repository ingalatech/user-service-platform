import { runCommand, type CommandExecutor } from './runner.js';

export interface CommitCheckRun {
  name: string;
  status: string;
  conclusion: string | null;
}

// Exact-SHA CI verification (PR #17 final acceptance blockers). The READY
// path must confirm the checks attached to the reviewed commit itself — the
// PR rollup alone cannot prove the local HEAD is what CI ran. An empty run
// list (checks not registered yet) is never a pass.
export function commitChecksPass(runs: CommitCheckRun[]): boolean {
  return (
    runs.length > 0 &&
    runs.every((run) => run.status === 'completed' && run.conclusion === 'success')
  );
}

export type CheckPollDecision = 'pass' | 'fail' | 'pending';

export const CHECK_POLL_ATTEMPTS = 72;
export const CHECK_POLL_DELAY_MS = 10000;

// Polling policy for exact-SHA checks: pending/absent/awaiting-approval runs
// wait, completed non-success runs fail fast, and only a non-empty all-success
// set passes. `action_required` cannot be resolved by the local workflow.
export function decideCheckPoll(runs: CommitCheckRun[]): CheckPollDecision {
  if (runs.some((run) => run.status === 'completed' && run.conclusion !== 'success')) {
    return 'fail';
  }
  if (commitChecksPass(runs)) {
    return 'pass';
  }
  return 'pending';
}

interface GhCheckRun {
  name?: unknown;
  status?: unknown;
  conclusion?: unknown;
}

export async function fetchCommitCheckRuns(
  repoSlug: string,
  headSha: string,
  execute: CommandExecutor = runCommand,
): Promise<CommitCheckRun[]> {
  const { stdout } = await execute('gh', [
    'api',
    `repos/${repoSlug}/commits/${headSha}/check-runs`,
    '--jq',
    '.check_runs[] | {name: .name, status: .status, conclusion: .conclusion}',
  ]);
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  const runs: CommitCheckRun[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    const parsed = JSON.parse(line) as GhCheckRun;
    if (typeof parsed.name === 'string' && typeof parsed.status === 'string') {
      runs.push({
        name: parsed.name,
        status: parsed.status,
        conclusion: typeof parsed.conclusion === 'string' ? parsed.conclusion : null,
      });
    }
  }
  return runs;
}

interface GhWorkflowRun {
  head_sha?: unknown;
  conclusion?: unknown;
}

// A zero-job CI run may have no commit check-run to report its terminal
// `action_required` conclusion. Observe the canonical CI workflow for this
// exact SHA so local review can fail clearly in that case too. This is a
// read-only observation; there is deliberately no approval or dispatch path.
export async function fetchHeadWorkflowRequiresApproval(
  repoSlug: string,
  headSha: string,
  execute: CommandExecutor = runCommand,
): Promise<boolean> {
  const { stdout } = await execute('gh', [
    'api',
    `repos/${repoSlug}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=20`,
    '--jq',
    '.workflow_runs[] | {head_sha: .head_sha, conclusion: .conclusion}',
  ]);
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let run: GhWorkflowRun;
    try {
      run = JSON.parse(line) as GhWorkflowRun;
    } catch {
      continue;
    }
    if (run.head_sha === headSha && run.conclusion === 'action_required') {
      return true;
    }
  }
  return false;
}

export async function getRepoSlug(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('gh', [
    'repo',
    'view',
    '--json',
    'nameWithOwner',
    '--jq',
    '.nameWithOwner',
  ]);
  return stdout.trim();
}

// Bounded read recovery for exact-HEAD CI observation (ticket #141). The
// operator-approved policy recovers from up to two consecutive failed
// authoritative check-run reads inside the same polling cycle; the third
// consecutive failure stops as unreadable. Every failed read consumes one of
// the existing total poll attempts and waits the existing interval when
// another observation is allowed — there is no nested retry budget and no
// wait after the final allowed observation or the third consecutive error.
// Any successful fetch clears the consecutive-error state, even for
// pending/empty/approval-waiting checks. Raw error payloads are never logged
// or persisted; only the final error message travels with the result for the
// existing terminal report.
export const MAX_CONSECUTIVE_CHECK_READ_ERRORS = 3;

export type CommitCheckPollOutcome = 'pass' | 'fail' | 'pending' | 'unreadable';

export interface ObservedCheckReads {
  runs: CommitCheckRun[];
  decision: CheckPollDecision;
  attempt: number;
  totalAttempts: number;
}

export interface CommitCheckPollEvents {
  fetchChecks: () => Promise<CommitCheckRun[]>;
  sleep: (milliseconds: number) => Promise<void>;
  onChecksObserved?: (observation: ObservedCheckReads) => void | Promise<void>;
}

export interface CommitCheckPollResult {
  outcome: CommitCheckPollOutcome;
  runs: CommitCheckRun[];
  attemptsUsed: number;
  failedReads: number;
  readError?: string;
}

export async function pollCommitCheckRunsWithReadRecovery(
  events: CommitCheckPollEvents,
): Promise<CommitCheckPollResult> {
  let consecutiveErrors = 0;
  let failedReads = 0;
  let lastRuns: CommitCheckRun[] = [];
  let readError: string | undefined;
  for (let attempt = 0; attempt < CHECK_POLL_ATTEMPTS; attempt += 1) {
    const isLastAttempt = attempt === CHECK_POLL_ATTEMPTS - 1;
    let runs: CommitCheckRun[];
    try {
      runs = await events.fetchChecks();
    } catch (error) {
      consecutiveErrors += 1;
      failedReads += 1;
      readError = error instanceof Error ? error.message : String(error);
      if (consecutiveErrors >= MAX_CONSECUTIVE_CHECK_READ_ERRORS) {
        return {
          outcome: 'unreadable',
          runs: lastRuns,
          attemptsUsed: attempt + 1,
          failedReads,
          readError,
        };
      }
      if (!isLastAttempt) {
        await events.sleep(CHECK_POLL_DELAY_MS);
      }
      continue;
    }
    consecutiveErrors = 0;
    readError = undefined;
    lastRuns = runs;
    const decision = decideCheckPoll(runs);
    await events.onChecksObserved?.({
      runs,
      decision,
      attempt,
      totalAttempts: CHECK_POLL_ATTEMPTS,
    });
    if (decision !== 'pending') {
      return { outcome: decision, runs, attemptsUsed: attempt + 1, failedReads };
    }
    if (!isLastAttempt) {
      await events.sleep(CHECK_POLL_DELAY_MS);
    }
  }
  return {
    outcome: consecutiveErrors > 0 ? 'unreadable' : 'pending',
    runs: lastRuns,
    attemptsUsed: CHECK_POLL_ATTEMPTS,
    failedReads,
    ...(readError === undefined ? {} : { readError }),
  };
}
