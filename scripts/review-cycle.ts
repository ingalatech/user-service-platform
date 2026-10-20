import { notifyTerminalBell } from './review/bell.js';
import { parseNoBellFlag, runWithFatalBoundary } from './review/fatal.js';
import {
  DEFAULT_MAX_CORRECTION_CYCLES,
  DEFAULT_MAX_MARKER_RETRIES,
  axesEligibleForMarkerRetry,
  decideNextStep,
  decideStartSync,
  formatReadySummary,
  type MarkerRetries,
} from './review/cycle-policy.js';
import { qualityGatesPass, runQualityGates, type GateResult } from './review/gates.js';
import {
  fetchCommitCheckRuns,
  fetchHeadWorkflowRequiresApproval,
  getRepoSlug,
  pollCommitCheckRunsWithReadRecovery,
  type CheckPollDecision,
  type CommitCheckRun,
} from './review/pr-checks.js';
import { parseReviewMarkers, selectCurrentHeadReports } from './review/result-marker.js';
import {
  getCurrentHead,
  getPrForBranch,
  listPrComments,
  reviewAxisWorker,
  runAddressReview,
  runCommand,
  runReviewAxis,
  type CommandResult,
} from './review/runner.js';
import {
  createRunSummaryRecorder,
  formatSummaryPathMessage,
  persistRunSummary,
  type CiDecision,
  type RunSummaryRecorder,
  type TerminalOutcome,
  type WorkerAttemptResult,
} from './review/run-summary.js';
import { safePushBranch } from './review/safe-push.js';
import { publishStageStatus, readStatusEnv, type RunStatusOutcome } from './review/run-status.js';
import {
  HANDOFF_PATCH_PATH,
  HANDOFF_RECORD_PATH,
  TRUSTED_PUBLICATION_MARKER,
  buildHandoffRecord,
  getWorkflowPatch,
  listChangedWorkflowFiles,
  persistWorkflowHandoffBundle,
} from './review/workflow-handoff.js';
import { isWorkerTimeout, timeoutDetails, timeoutForWorker } from './review/worker-timeout.js';
import { runWorkerStream } from './review/worker-stream.js';
import { runReviewAxesSequentially } from './review/review-scheduling.js';
import { evidenceStreamingWorkerExecutor } from './review/evidence-streaming-executor.js';

interface CycleOptions {
  maxCycles: number;
  prArg?: string;
  push: boolean;
  noBell: boolean;
}

class HelpRequested extends Error {}

const PR_REFRESH_ATTEMPTS = 5;
const PR_REFRESH_DELAY_MS = 5000;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function refreshPrUntilHead(
  prArg: string | undefined,
  localHead: string,
): Promise<Awaited<ReturnType<typeof getPrForBranch>> | null> {
  for (let attempt = 0; attempt < PR_REFRESH_ATTEMPTS; attempt += 1) {
    const pr = await getPrForBranch(prArg);
    if (pr.headRefOid.toLowerCase() === localHead.toLowerCase()) {
      return pr;
    }
    if (attempt < PR_REFRESH_ATTEMPTS - 1) {
      await sleep(PR_REFRESH_DELAY_MS);
    }
  }
  return null;
}

// Quality gates run on the same bounded streaming path as OpenCode workers
// (ticket #31): a hung gate command terminates with a distinguishable
// TIMEOUT instead of stalling the cycle with no output. Short git/gh
// inspection commands stay on the buffered `runCommand` path.
function boundedGatesExecutor(command: string, args: readonly string[]): Promise<CommandResult> {
  return runWorkerStream(command, args, { label: 'gates', timeoutMs: timeoutForWorker('gates') });
}

function parseArgs(argv: readonly string[]): CycleOptions {
  let maxCycles = DEFAULT_MAX_CORRECTION_CYCLES;
  let prArg: string | undefined;
  let push = true;
  let noBell = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--max-cycles') {
      const raw = argv[index + 1];
      const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error(`--max-cycles requires a non-negative integer, got ${raw ?? '(missing)'}`);
      }
      maxCycles = parsed;
      index += 1;
    } else if (arg === '--pr') {
      const raw = argv[index + 1];
      if (raw === undefined || raw === '') {
        throw new Error('--pr requires a PR number or URL');
      }
      prArg = raw;
      index += 1;
    } else if (arg === '--no-push') {
      push = false;
    } else if (arg === '--push') {
      push = true;
    } else if (arg === '--no-bell') {
      noBell = true;
    } else if (arg === '--bell') {
      noBell = false;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push] [--no-bell|--bell]',
      );
      throw new HelpRequested();
    } else {
      throw new Error(`unknown argument: ${arg ?? '(missing)'}`);
    }
  }

  return { maxCycles, prArg, push, noBell };
}

function syncPrIntoRecorder(
  recorder: RunSummaryRecorder,
  pr: Awaited<ReturnType<typeof getPrForBranch>>,
): void {
  recorder.setPr({
    number: pr.number,
    ...(pr.url === undefined ? {} : { url: pr.url }),
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
  });
  recorder.setBranch(pr.headRefName, pr.baseRefName);
}

// Structured run summaries (ticket #22) are best-effort: a persistence
// failure is reported on stderr but never changes the terminal outcome or
// exit code of the review cycle itself.
async function concludeWithSummary(
  recorder: RunSummaryRecorder,
  outcome: TerminalOutcome,
  detail?: string,
): Promise<void> {
  const summary = recorder.finish(outcome, detail);
  try {
    const { latestPath } = await persistRunSummary(summary);
    console.log(formatSummaryPathMessage(latestPath));
  } catch (error) {
    console.error(
      `Run summary persistence failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  // Durable status publication (ticket #31) is best-effort like persistence:
  // the single status comment owned by the calling workflow always receives
  // the terminal state when routing is configured (remote runs), and local
  // runs stay silent.
  await publishTerminalStatus(recorder, outcome, detail);
}

function statusOutcomeFor(outcome: TerminalOutcome): RunStatusOutcome {
  if (outcome === 'STOPPED') {
    return 'BLOCKED';
  }
  return outcome;
}

function workerForCycleStage(stage: string): string | undefined {
  if (stage === 'Standards review') {
    return 'standards';
  }
  if (stage === 'Spec review') {
    return 'spec';
  }
  if (stage === 'address-review') {
    return 'address-review';
  }
  return undefined;
}

function actionForCycleOutcome(outcome: RunStatusOutcome): string | undefined {
  if (outcome === 'NEEDS-DECISION') {
    return 'A product, architecture, or contract decision is required before automation can continue.';
  }
  if (outcome === 'TIMEOUT') {
    return 'A review worker exceeded its bound; rerun review:cycle once the runner is free.';
  }
  if (outcome === 'BLOCKED' || outcome === 'FATAL') {
    return 'Inspect the review-cycle output and .review-cycle/latest.json, then rerun review:cycle.';
  }
  return undefined;
}

async function publishCycleStatus(
  recorder: RunSummaryRecorder,
  stage: string,
  terminal?: { outcome: TerminalOutcome; detail?: string },
): Promise<void> {
  try {
    const status = readStatusEnv();
    const snap = recorder.snapshot();
    if (status === undefined || snap.pr === undefined) {
      return;
    }
    const outcome = terminal === undefined ? undefined : statusOutcomeFor(terminal.outcome);
    const worker = workerForCycleStage(stage);
    const actionRequired = outcome === undefined ? undefined : actionForCycleOutcome(outcome);
    await publishStageStatus(runCommand, status, {
      target: `PR #${String(snap.pr.number)}`,
      branch: snap.branch ?? '(unknown)',
      head: snap.reviewedHead === '' ? '(unknown)' : snap.reviewedHead,
      currentStage: stage,
      completedStages: [...snap.completedStages],
      startedAt: snap.startedAt,
      ...(worker === undefined ? {} : { worker }),
      ...(outcome === undefined ? {} : { outcome }),
      ...(terminal?.detail === undefined || terminal.detail === ''
        ? {}
        : { reason: terminal.detail }),
      ...(actionRequired === undefined ? {} : { actionRequired }),
    });
  } catch {
    // Best-effort: status publication never changes the terminal outcome.
  }
}

async function publishTerminalStatus(
  recorder: RunSummaryRecorder,
  outcome: TerminalOutcome,
  detail?: string,
): Promise<void> {
  const snap = recorder.snapshot();
  await publishCycleStatus(recorder, snap.stage ?? '(unknown)', { outcome, detail });
}

// Stage changes update the durable status surface (ticket #31) alongside the
// structured summary so GitHub shows the current stage without log polling.
async function setCycleStage(recorder: RunSummaryRecorder, stage: string): Promise<void> {
  recorder.setStage(stage);
  await publishCycleStatus(recorder, stage);
}

function fatalDetail(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 300);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Trusted-publication handoff (ticket #36): corrections touching
// `.github/workflows/**` must never attempt the doomed generic push with the
// least-privilege credential. Detection runs over the exact known range and
// stops with a distinguishable BLOCKED reason while persisting the patch plus
// exact base/head metadata for the trusted publisher. Returns true when the
// caller must stop instead of pushing.
async function blockOnWorkflowHandoff(
  recorder: RunSummaryRecorder,
  noBell: boolean,
  range: { branch: string; base: string; head: string },
): Promise<boolean> {
  let files: string[];
  try {
    files = await listChangedWorkflowFiles(runCommand, range.base, range.head);
  } catch (error) {
    const reason =
      `${TRUSTED_PUBLICATION_MARKER}: cannot prove the correction is free of workflow files: ` +
      errorMessage(error);
    console.error(`REVIEW-CYCLE BLOCKED: ${reason}`);
    process.exitCode = 1;
    await concludeWithSummary(recorder, 'BLOCKED', reason);
    notifyTerminalBell(noBell);
    return true;
  }
  if (files.length === 0) {
    return false;
  }
  const record = buildHandoffRecord({
    branch: range.branch,
    base: range.base,
    head: range.head,
    files,
  });
  let patch: string;
  try {
    patch = await getWorkflowPatch(runCommand, range.base, range.head);
  } catch (error) {
    patch = `# workflow handoff patch unavailable: ${errorMessage(error)}\n`;
  }
  try {
    await persistWorkflowHandoffBundle(record, patch);
  } catch (error) {
    console.error(`Handoff persistence failed: ${errorMessage(error)}`);
  }
  console.error(`REVIEW-CYCLE BLOCKED: ${record.reason}`);
  console.error(`Handoff evidence: ${HANDOFF_PATCH_PATH} ${HANDOFF_RECORD_PATH}`);
  process.exitCode = 1;
  await concludeWithSummary(recorder, 'BLOCKED', record.reason);
  notifyTerminalBell(noBell);
  return true;
}

// Repository-owned deterministic orchestration for the dual review loop
// (ticket #16). This command is not an LLM agent: it invokes the existing
// OpenCode review commands as workers, reads only machine-readable markers,
// keeps both axes independent, bounds corrections, and escalates decisions.
// Headless agents do not depend on interactive questions: human-required
// decisions are surfaced as explicit NEEDS-DECISION/BLOCKED escalation output,
// never as hidden stdin prompts.
async function main(): Promise<void> {
  const recorder = createRunSummaryRecorder();
  try {
    await runCycle(recorder);
  } catch (error) {
    // Unhandled rejection/exception (e.g. a failed OpenCode worker): persist
    // a summary with the final known state, then rethrow so the fatal-error
    // boundary still reports and rings once. A bounded worker timeout is a
    // TIMEOUT with stage/timeout evidence — never a FATAL — and exits
    // non-zero so local runs cannot sit at `still running` indefinitely.
    // Persistence itself is best-effort inside concludeWithSummary.
    if (isWorkerTimeout(error)) {
      const details = timeoutDetails(error);
      if (details !== undefined) {
        recorder.recordTimeout(details.workerLabel, details.timeoutMs);
      }
      await concludeWithSummary(recorder, 'TIMEOUT', fatalDetail(error));
    } else {
      await concludeWithSummary(recorder, 'FATAL', fatalDetail(error));
    }
    throw error;
  }
}

async function runCycle(recorder: RunSummaryRecorder): Promise<void> {
  let options: CycleOptions;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof HelpRequested) {
      return;
    }
    console.error(error instanceof Error ? error.message : String(error));
    console.error(
      'usage: review-cycle [--max-cycles N] [--pr <number|url>] [--no-push|--push] [--no-bell|--bell]',
    );
    process.exitCode = 1;
    await concludeWithSummary(recorder, 'BLOCKED', 'invalid arguments');
    notifyTerminalBell(parseNoBellFlag(process.argv.slice(2)));
    return;
  }

  let pr: Awaited<ReturnType<typeof getPrForBranch>>;
  try {
    pr = await getPrForBranch(options.prArg);
  } catch {
    console.error('REVIEW-CYCLE ABORTED: no pull request found for the current ticket branch.');
    console.error(
      'Push the ticket branch and open a draft PR before running npm run review:cycle.',
    );
    process.exitCode = 1;
    await concludeWithSummary(recorder, 'BLOCKED', 'no pull request for the ticket branch');
    notifyTerminalBell(options.noBell);
    return;
  }
  syncPrIntoRecorder(recorder, pr);

  let head = await getCurrentHead();
  recorder.setInitialHead(head);
  recorder.setReviewedHead(head);
  console.log(
    `Review cycle: PR #${String(pr.number)} (${pr.headRefName} -> ${pr.baseRefName}), HEAD ${head}`,
  );

  // Blocker 2 (PR #17): markers are matched against the local HEAD, so refuse
  // to review while the PR still points at an older SHA.
  const startSync = decideStartSync({
    localHead: head,
    prHeadOid: pr.headRefOid,
    push: options.push,
  });
  if (startSync.kind === 'abort-diverged') {
    console.error(
      'REVIEW-CYCLE ABORTED: local HEAD differs from the PR head and --no-push was passed.',
    );
    console.error('Push the ticket branch first, then rerun npm run review:cycle.');
    process.exitCode = 1;
    await concludeWithSummary(recorder, 'BLOCKED', 'local HEAD diverged under --no-push');
    notifyTerminalBell(options.noBell);
    return;
  }
  if (startSync.kind === 'push-and-refresh') {
    console.log(`Local HEAD ${head} is ahead of the PR; pushing via safe-push.`);
    const handoffBlocked = await blockOnWorkflowHandoff(recorder, options.noBell, {
      branch: pr.headRefName,
      base: pr.headRefOid,
      head,
    });
    if (handoffBlocked) {
      return;
    }
    const pushed = await safePushBranch(options.prArg);
    if (!pushed.ok) {
      console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'BLOCKED', `push refused: ${pushed.reason}`);
      notifyTerminalBell(options.noBell);
      return;
    }
    const refreshed = await refreshPrUntilHead(options.prArg, head);
    if (refreshed === null) {
      console.error(
        'REVIEW-CYCLE ABORTED: the PR head did not catch up with the local HEAD after push.',
      );
      process.exitCode = 1;
      await concludeWithSummary(
        recorder,
        'BLOCKED',
        'PR head did not catch up with the local HEAD after push',
      );
      notifyTerminalBell(options.noBell);
      return;
    }
    pr = refreshed;
    syncPrIntoRecorder(recorder, pr);
  }

  for (
    let cycles = 0,
      markerRetries: MarkerRetries = { standards: 0, spec: 0 },
      pendingAxes: ('standards' | 'spec')[] | null = null,
      standardsInvocations = 0,
      specInvocations = 0;
    ;
  ) {
    recorder.setMarkerRetries({ ...markerRetries });
    const justRan: ('standards' | 'spec')[] =
      pendingAxes === null ? ['standards', 'spec'] : [...pendingAxes];
    const timings = new Map<'standards' | 'spec', { start: number; end: number }>();
    await setCycleStage(
      recorder,
      pendingAxes === null
        ? 'Standards review'
        : pendingAxes
            .map((axis) => (axis === 'standards' ? 'Standards review' : 'Spec review'))
            .join(', '),
    );
    try {
      if (pendingAxes === null) {
        // Sequential initial reviewers (ticket #127 bounded execution-blocker
        // amendment): Standards and Spec stay independent with their own
        // commands, evidence, bounds and exact-HEAD markers, but launch one
        // after the other under the shared OpenCode profile so two workers
        // never hold its local store concurrently. A logical FAIL on the
        // first axis never skips the second; an infrastructure error is
        // surfaced unchanged after the other axis is attempted.
        const firstError = await runReviewAxesSequentially(
          ['standards', 'spec'],
          async (axis) => {
            if (axis === 'standards') {
              standardsInvocations += 1;
              await runReviewAxis(
                'review-standards',
                pr.number,
                [],
                evidenceStreamingWorkerExecutor(
                  'standards',
                  {
                    command: 'review-standards',
                    axis: 'standards',
                    attempt: standardsInvocations,
                    workerStartHead: head,
                  },
                  recorder,
                ),
              );
            } else {
              specInvocations += 1;
              await runReviewAxis(
                'review-spec',
                pr.number,
                [],
                evidenceStreamingWorkerExecutor(
                  'spec',
                  {
                    command: 'review-spec',
                    axis: 'spec',
                    attempt: specInvocations,
                    workerStartHead: head,
                  },
                  recorder,
                ),
              );
            }
          },
          timings,
        );
        if (firstError !== undefined) {
          throw firstError as Error;
        }
      } else {
        // Blocker 1 (PR #17): a reviewer published without its marker — retry
        // only the missing axis instead of demanding manual intervention.
        for (const axis of pendingAxes) {
          const worker = reviewAxisWorker(axis);
          const startedAt = Date.now();
          if (axis === 'standards') {
            standardsInvocations += 1;
          } else {
            specInvocations += 1;
          }
          await runReviewAxis(
            worker.command,
            pr.number,
            [],
            evidenceStreamingWorkerExecutor(
              axis,
              {
                command: worker.command,
                axis,
                attempt: axis === 'standards' ? standardsInvocations : specInvocations,
                workerStartHead: head,
              },
              recorder,
            ),
          );
          timings.set(axis, { start: startedAt, end: Date.now() });
          markerRetries[axis] += 1;
        }
        pendingAxes = null;
      }
    } catch (workerError) {
      const failedAt = Date.now();
      for (const axis of justRan) {
        const timing = timings.get(axis);
        recorder.recordWorkerAttempt(
          axis,
          'ERROR',
          timing?.start ?? failedAt,
          timing?.end ?? failedAt,
        );
      }
      recorder.setMarkerRetries({ ...markerRetries });
      throw workerError;
    }

    const comments = await listPrComments(pr.number);
    const markerCount = comments.reduce((total, comment) => {
      return total + parseReviewMarkers(comment.body).length;
    }, 0);
    console.log(
      `Collected ${String(comments.length)} PR comments (${String(markerCount)} markers).`,
    );
    const reports = selectCurrentHeadReports(comments, head);
    for (const axis of justRan) {
      const report = axis === 'standards' ? reports.standards : reports.spec;
      const timing = timings.get(axis);
      const result: WorkerAttemptResult = report?.result ?? 'MISSING';
      recorder.recordWorkerAttempt(
        axis,
        result,
        timing?.start ?? Date.now(),
        timing?.end ?? Date.now(),
      );
    }
    recorder.setMarkerRetries({ ...markerRetries });
    recorder.setReviewedHead(head);
    // Dual-review completion (ticket #40). The initial reviewers run
    // sequentially under a single stage transition, so the transition alone can
    // only record one axis. Mark each axis completed only from its
    // exact-HEAD validated marker — a missing or stale marker never counts.
    // Reviewers stay independent; only the launch order is sequential and only
    // completion bookkeeping is explicit.
    if (reports.standards !== undefined) {
      recorder.markCompleted('Standards review');
    }
    if (reports.spec !== undefined) {
      recorder.markCompleted('Spec review');
    }

    const decision = decideNextStep({
      standards: reports.standards,
      spec: reports.spec,
      cycles,
      maxCycles: options.maxCycles,
    });

    if (decision.kind === 'ready-for-acceptance') {
      await setCycleStage(recorder, 'gates');
      let gates: GateResult[];
      try {
        gates = await runQualityGates(boundedGatesExecutor);
      } catch (error) {
        if (!isWorkerTimeout(error)) {
          throw error;
        }
        const details = timeoutDetails(error);
        if (details !== undefined) {
          recorder.recordTimeout(details.workerLabel, details.timeoutMs);
        }
        console.error('REVIEW-CYCLE TIMEOUT: quality gates exceeded their bound.');
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'TIMEOUT', 'quality gates timed out');
        notifyTerminalBell(options.noBell);
        return;
      }
      recorder.setQualityGates(gates.map((gate) => ({ name: gate.name, ok: gate.ok })));
      const pass = qualityGatesPass(gates);
      for (const gate of gates) {
        console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
      }
      if (!pass) {
        console.error('REVIEW-CYCLE BLOCKED: quality gates failed for the reviewed HEAD.');
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', 'quality gates failed');
        notifyTerminalBell(options.noBell);
        return;
      }
      // Blocker 2 (PR #17): confirm the PR still points at the reviewed HEAD
      // and CI checks for that exact commit are green before claiming READY.
      const finalPr = await getPrForBranch(options.prArg);
      if (finalPr.headRefOid.toLowerCase() !== head.toLowerCase()) {
        console.error(
          'REVIEW-CYCLE BLOCKED: the PR head moved away from the reviewed HEAD. Rerun npm run review:cycle.',
        );
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', 'PR head moved away from the reviewed HEAD');
        notifyTerminalBell(options.noBell);
        return;
      }
      const repoSlug = await getRepoSlug();
      await setCycleStage(recorder, 'exact-HEAD CI');
      // `action_required` has no local approval route after hosted agent and
      // approval workflows were retired. Fail clearly rather than waiting on
      // a deleted listener or scheduled backstop.
      // Ticket #141: the shipped poll below recovers from up to two
      // consecutive failed check-run reads inside this same cycle and stops
      // unreadable on the third consecutive failure. Every failed read consumes
      // the same 72-attempt/10-second budget, a successful read clears the
      // error state, and recovery never reruns reviewers, gates, or
      // corrections.
      const poll = await pollCommitCheckRunsWithReadRecovery({
        fetchChecks: async () => {
          const runs = await fetchCommitCheckRuns(repoSlug, head);
          try {
            if (await fetchHeadWorkflowRequiresApproval(repoSlug, head, runCommand)) {
              return [
                ...runs,
                { name: 'ci workflow', status: 'completed', conclusion: 'action_required' },
              ];
            }
          } catch (error) {
            console.log(
              `Exact-HEAD workflow-run observation failed (check-runs remain authoritative): ${errorMessage(error)}`,
            );
          }
          return runs;
        },
        sleep: (milliseconds) => sleep(milliseconds),
        onChecksObserved: ({ runs, decision, attempt, totalAttempts }) => {
          for (const run of runs) {
            console.log(`check ${run.name}: ${run.status}/${run.conclusion ?? 'none'}`);
          }
          if (decision === 'pending' && attempt < totalAttempts - 1) {
            console.log(`CI checks for ${head} are pending; waiting before rechecking.`);
          }
        },
      });
      const lastRuns: CommitCheckRun[] = poll.runs;
      // The poll outcome is authoritative: a recovered `pass`/`fail` reflects
      // the last successful read, while `pending`/`unreadable` never becomes a
      // pass — unreadable exhaustion stays distinguishable below.
      const checkDecision: CheckPollDecision =
        poll.outcome === 'pass' ? 'pass' : poll.outcome === 'fail' ? 'fail' : 'pending';
      const ciDecision: CiDecision =
        checkDecision === 'pass' ? 'pass' : checkDecision === 'fail' ? 'fail' : 'pending';
      recorder.setCi(
        ciDecision,
        lastRuns.map((run) => ({ name: run.name, status: run.status, conclusion: run.conclusion })),
      );
      if (poll.outcome === 'unreadable') {
        console.error(
          `REVIEW-CYCLE BLOCKED: cannot prove CI checks for the exact reviewed HEAD: ${poll.readError ?? '(unknown read error)'}`,
        );
        process.exitCode = 1;
        await concludeWithSummary(
          recorder,
          'BLOCKED',
          'cannot prove CI checks for the reviewed HEAD',
        );
        notifyTerminalBell(options.noBell);
        return;
      }
      if (checkDecision !== 'pass') {
        const detail = lastRuns.some((run) => run.conclusion === 'action_required')
          ? 'CI checks for the reviewed HEAD require an unavailable hosted approval (action_required); resolve the run outside the local review flow and rerun review:cycle'
          : 'CI checks for the reviewed HEAD are not successful';
        console.error(`REVIEW-CYCLE BLOCKED: ${detail}.`);
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', detail);
        notifyTerminalBell(options.noBell);
        return;
      }
      console.log('');
      console.log(formatReadySummary({ head, cycles, gates: 'PASS' }));
      await setCycleStage(recorder, 'final acceptance-ready');
      await concludeWithSummary(recorder, 'READY', 'ready for final acceptance');
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'awaiting-reviews') {
      const retryAxes = axesEligibleForMarkerRetry(
        decision.missing,
        markerRetries,
        DEFAULT_MAX_MARKER_RETRIES,
      );
      if (retryAxes.length > 0) {
        console.log(
          `Missing current-HEAD markers for: ${retryAxes.join(', ')}. Retrying only those reviewers (bounded to ${String(DEFAULT_MAX_MARKER_RETRIES)} attempts per axis).`,
        );
        pendingAxes = retryAxes;
        continue;
      }
      console.error(
        `REVIEW-CYCLE INCOMPLETE: missing current-HEAD reports for: ${decision.missing.join(', ')} after ${String(DEFAULT_MAX_MARKER_RETRIES)} retries.`,
      );
      console.error('Inspect the reviewer output on the PR; markers may be malformed.');
      process.exitCode = 1;
      await concludeWithSummary(
        recorder,
        'BLOCKED',
        `missing current-HEAD reports for: ${decision.missing.join(', ')}`,
      );
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'needs-decision') {
      console.error(
        `REVIEW-CYCLE ESCALATED: the ${decision.axis} axis reported NEEDS-DECISION for ${head}.`,
      );
      console.error(
        'Product, architecture, public-contract, infrastructure-provider, or security-policy decisions belong to planning — not to this loop. Stopping without code changes.',
      );
      process.exitCode = 2;
      await concludeWithSummary(
        recorder,
        'NEEDS-DECISION',
        `${decision.axis} reported NEEDS-DECISION`,
      );
      notifyTerminalBell(options.noBell);
      return;
    }

    if (decision.kind === 'cycle-limit-reached') {
      console.error(
        `REVIEW-CYCLE STOPPED: ${String(decision.cycles)} correction cycles reached the bound of ${String(decision.maxCycles)}. Escalating to a human.`,
      );
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'STOPPED', 'correction-cycle bound reached');
      notifyTerminalBell(options.noBell);
      return;
    }

    // decision.kind === 'address-review'
    cycles += 1;
    await setCycleStage(recorder, 'address-review');
    console.log(
      `Blocking findings for ${head}: invoking /address-review (correction cycle ${String(cycles)}).`,
    );
    const addressStartedAt = Date.now();
    try {
      await runAddressReview(
        pr.number,
        evidenceStreamingWorkerExecutor(
          'address-review',
          {
            command: 'address-review',
            axis: 'address-review',
            attempt: cycles,
            workerStartHead: head,
          },
          recorder,
        ),
      );
    } catch (addressError) {
      recorder.recordAddressReviewAttempt('error', addressStartedAt, Date.now());
      throw addressError;
    }
    const addressEndedAt = Date.now();
    const newHead = await getCurrentHead();
    if (newHead === head) {
      recorder.recordAddressReviewAttempt('unchanged', addressStartedAt, addressEndedAt);
      console.error(
        'REVIEW-CYCLE STOPPED: /address-review left HEAD unchanged while blocking findings remain. Escalating to a human.',
      );
      process.exitCode = 1;
      await concludeWithSummary(recorder, 'STOPPED', '/address-review left HEAD unchanged');
      notifyTerminalBell(options.noBell);
      return;
    }
    recorder.recordAddressReviewAttempt('advanced', addressStartedAt, addressEndedAt);
    const previousHead = head;
    head = newHead;
    recorder.setReviewedHead(head);
    markerRetries = { standards: 0, spec: 0 };

    if (options.push) {
      const handoffBlocked = await blockOnWorkflowHandoff(recorder, options.noBell, {
        branch: pr.headRefName,
        base: previousHead,
        head,
      });
      if (handoffBlocked) {
        return;
      }
      const pushed = await safePushBranch(options.prArg);
      if (!pushed.ok) {
        console.error(`REVIEW-CYCLE PUSH REFUSED: ${pushed.reason}`);
        process.exitCode = 1;
        await concludeWithSummary(recorder, 'BLOCKED', `push refused: ${pushed.reason}`);
        notifyTerminalBell(options.noBell);
        return;
      }
      console.log(`Pushed correction commit via safe-push: origin/${pushed.branch} @ ${head}`);
    }
  }
}

// Fatal-error boundary (final acceptance on PR #19): handled terminal paths
// above return normally with their own notification, so this catch fires only
// for unhandled rejections/exceptions such as a failed OpenCode worker. It
// reports REVIEW-CYCLE FATAL, sets a non-zero exit code, and rings the bell
// once per the TTY/CI/--no-bell policy — never twice for one terminal state.
await runWithFatalBoundary(main, process.argv.slice(2));
