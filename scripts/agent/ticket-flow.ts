import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import { qualityGatesPass, runQualityGates, type GateResult } from '../review/gates.js';
import {
  HANDOFF_PATCH_PATH,
  HANDOFF_RECORD_PATH,
  TRUSTED_PUBLICATION_MARKER,
  buildHandoffRecord,
  formatHandoffAction,
  getWorkflowPatch,
  listChangedWorkflowFiles,
  persistWorkflowHandoffBundle,
  type WorkflowHandoffRecord,
} from '../review/workflow-handoff.js';
import {
  getCurrentBranch,
  getCurrentHead,
  getPrForBranch,
  isWorktreeClean,
  runBoundedCommand,
  runCommand,
  withJsonFormat,
  type CommandExecutor,
} from '../review/runner.js';
import { checkSafePush, type SafePushCheck } from '../review/safe-push.js';
import {
  buildEvidenceInvocation,
  commandSessionExporter,
  createEvidenceCapture,
  finalizeSkillEvidence,
  suppressJsonWorkerLines,
} from '../review/evidence-worker.js';
import {
  captureImplementationRecovery,
  createUnavailableRecovery,
  formatRecoverySummary,
  RECOVERY_COMMAND_TIMEOUT_MS,
  RECOVERY_MAX_TOTAL_BYTES,
  summarizeWorkerLifecycle,
  type ImplementationRecoveryRecord,
  type RecoveryCaptureInput,
} from '../review/implementation-recovery.js';
import { runWorkerStream } from '../review/worker-stream.js';
import { isWorkerTimeout, timeoutForWorker, type WorkerLabel } from '../review/worker-timeout.js';
import { publishStageStatus, type RunStatusOutcome, type StatusEnv } from '../review/run-status.js';

// Headroom above the snapshot byte bound for a single bounded Git command:
// the patch itself is capped at RECOVERY_MAX_TOTAL_BYTES inside the capture,
// while command output may carry bounded framing around it.
const RECOVERY_GIT_OUTPUT_CAP_BYTES = RECOVERY_MAX_TOTAL_BYTES + 65_536;

// Shared operator next-action tail for implement recovery terminals (ticket #127):
// a recovery record is preserved evidence, not a defect diagnosis, and reuse is
// operator-driven on a fresh isolated worktree — never a blind rerun.
const RECOVERY_ACTION_TAIL =
  'this is a recovery record, not a diagnosis of an application defect. ' +
  'Inspect .agent-ticket/outcome.json recovery evidence and ' +
  'docs/agents/implementation-recovery.md, then reapply eligible changes on a fresh ' +
  'isolated worktree — do not blindly rerun /agent-ticket.';

// Explicit stage names for the durable run-status surface (ticket #31).
// One status comment per agent run is updated as these stages advance so the
// current stage and terminal outcome are visible from GitHub mobile/web
// without terminal polling.
export const TICKET_STAGE_NAMES = [
  'validation',
  'implementation',
  'gates',
  'push',
  'PR creation',
  'review',
  'final acceptance-ready',
] as const;

export type TicketStageName = (typeof TICKET_STAGE_NAMES)[number];

// Terminal outcome record (ticket #31). Every terminal state — including
// pre-review failures where `review:cycle` never ran and no
// `.review-cycle/latest.json` exists — records its outcome, stage, and
// reason at this path so the workflow terminal step can distinguish TIMEOUT
// from generic BLOCKED without log polling. Deterministic
// repository-owned metadata only, never transcripts or secrets.
export const AGENT_TICKET_OUTCOME_PATH = '.agent-ticket/outcome.json';

export type AgentTicketStatusOutcome = 'READY' | 'BLOCKED' | 'NEEDS-DECISION' | 'TIMEOUT';

export interface AgentTicketOutcome {
  outcome: AgentTicketStatusOutcome;
  stage: string;
  reason: string;
  startedAt: string;
  completedStages: string[];
  actionRequired?: string;
  // Additive skill-evidence pointer (ticket #116): the normalized evidence
  // path for the initial implementation worker when collection succeeded.
  // Absent when collection was unavailable; never affects outcome semantics.
  skillEvidencePath?: string;
  // Additive bounded recovery record (ticket #127): the portable
  // secret-safe snapshot of the actual failed-worktree state after an
  // `/implement` timeout/failure, embedded in this already-uploaded outcome
  // artifact so no workflow-file edit is needed. Absent on paths that never
  // ran the implement worker to failure; never affects outcome semantics.
  recovery?: ImplementationRecoveryRecord;
}

export interface AgentTicketTerminal {
  exitCode: number;
  failedStage?: string;
  timedOut?: boolean;
}

function stageForFailedStage(failedStage: string | undefined): string {
  if (failedStage === 'implement') {
    return 'implementation';
  }
  if (failedStage === 'gates') {
    return 'gates';
  }
  if (failedStage === 'push') {
    return 'push';
  }
  if (failedStage === 'pr') {
    return 'PR creation';
  }
  if (failedStage === 'review-cycle') {
    return 'review';
  }
  if (
    failedStage === 'validate' ||
    failedStage === 'start-state' ||
    failedStage === 'ticket' ||
    failedStage === 'branch'
  ) {
    return 'validation';
  }
  return 'run';
}

export function terminalOutcomeFor(result: AgentTicketTerminal): {
  outcome: AgentTicketStatusOutcome;
  stage: string;
} {
  if (result.exitCode === 0) {
    return { outcome: 'READY', stage: 'final acceptance-ready' };
  }
  // A timeout stays a timeout regardless of the accompanying exit code.
  if (result.timedOut === true) {
    return { outcome: 'TIMEOUT', stage: stageForFailedStage(result.failedStage) };
  }
  if (result.exitCode === 2) {
    return { outcome: 'NEEDS-DECISION', stage: stageForFailedStage(result.failedStage) };
  }
  return { outcome: 'BLOCKED', stage: stageForFailedStage(result.failedStage) };
}

export interface OutcomePersistDeps {
  mkdir?: (dir: string, options: { recursive: boolean }) => Promise<unknown>;
  writeFile?: (path: string, contents: string) => Promise<unknown>;
  path?: string;
}

export async function writeAgentTicketOutcome(
  input: Omit<AgentTicketOutcome, 'startedAt' | 'completedStages'> & {
    startedAt?: string;
    completedStages?: readonly string[];
  },
  deps: OutcomePersistDeps = {},
): Promise<string> {
  const path = deps.path ?? AGENT_TICKET_OUTCOME_PATH;
  const mkdir =
    deps.mkdir ?? ((dir: string, options: { recursive: boolean }) => fs.mkdir(dir, options));
  const writeFile =
    deps.writeFile ?? ((file: string, contents: string) => fs.writeFile(file, contents, 'utf8'));
  const record: AgentTicketOutcome = {
    outcome: input.outcome,
    stage: input.stage,
    reason: input.reason,
    startedAt: input.startedAt ?? new Date().toISOString(),
    completedStages: input.completedStages === undefined ? [] : [...input.completedStages],
  };
  if (input.actionRequired !== undefined) {
    record.actionRequired = input.actionRequired;
  }
  if (input.skillEvidencePath !== undefined) {
    record.skillEvidencePath = input.skillEvidencePath;
  }
  if (input.recovery !== undefined) {
    record.recovery = input.recovery;
  }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

// Deterministic ticket orchestration for `npm run agent:ticket -- <issue>`
// (ticket #23). One repository-owned command drives a clean `main` worktree
// through branch creation -> `/implement` -> quality gates -> safe push ->
// draft PR -> the existing `review:cycle`, stopping at READY FOR FINAL
// ACCEPTANCE. This module never merges, deploys, publishes, mutates
// Cloudflare resources, or handles secrets: the only remote writes are a
// ticket-branch push and a draft PR creation. Existing behaviour is reused,
// not reimplemented: safe-push guards, the repository gate list, and the
// review:cycle command (including its #22 run evidence) stay authoritative.
export function parseTicketArg(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `agent:ticket requires a positive integer issue number, got ${raw ?? '(missing)'}`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

export function slugifyTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 60)
    .replace(/-+$/, '');
  return slug === '' ? 'ticket' : slug;
}

export function ticketBranchName(ticket: number, title: string): string {
  return `ticket/${String(ticket)}-${slugifyTitle(title)}`;
}

// `/implement` runs headlessly with `opencode run --auto --command implement`.
// No `--agent` flag is passed: the implement command frontmatter remains the
// single source of truth for the implementer model, mirroring the review
// workers in `scripts/review/runner.ts`. `--format json` streams real pinned
// CLI tool records so attributable skill evidence can be collected
// (ticket #116); live streaming, heartbeats and timeout bounds are unchanged.
export function buildImplementArgs(ticket: number): string[] {
  return withJsonFormat(['run', '--auto', '--command', 'implement', String(ticket)]);
}

// The existing `review:cycle` stays separately usable; the wrapper invokes it
// unchanged rather than duplicating its review/correction logic.
export function buildReviewCycleArgs(): string[] {
  return ['run', 'review:cycle'];
}

export function formatPrTitle(title: string, ticket: number): string {
  return `${title} (#${String(ticket)})`;
}

export function formatPrBody(ticket: number): string {
  return `Automated implementation of #${String(ticket)} via \`npm run agent:ticket\`.`;
}

export interface PrCreateOptions {
  branch: string;
  title: string;
  ticket: number;
}

export function buildPrCreateArgs(options: PrCreateOptions): string[] {
  return [
    'pr',
    'create',
    '--base',
    'main',
    '--head',
    options.branch,
    '--draft',
    '--title',
    formatPrTitle(options.title, options.ticket),
    '--body',
    formatPrBody(options.ticket),
  ];
}

export interface StartState {
  currentBranch: string;
  worktreeClean: boolean;
}

export type StartStateCheck = { ok: true } | { ok: false; reason: string };

// Unsafe or ambiguous starting states are refused, never repaired: the
// wrapper must start from a clean `main` worktree so it cannot absorb or
// mutate unrelated work.
export function checkStartState(state: StartState): StartStateCheck {
  if (state.currentBranch !== 'main') {
    return {
      ok: false,
      reason: `refusing to start from ${state.currentBranch}: run npm run agent:ticket from a clean main worktree`,
    };
  }
  if (!state.worktreeClean) {
    return {
      ok: false,
      reason: 'refusing to start with a dirty worktree: commit or stash first so it is clean',
    };
  }
  return { ok: true };
}

export interface MainCurrency {
  localHead: string;
  remoteHead: string;
}

export type MainCurrencyCheck = { ok: true } | { ok: false; reason: string };

// Ticket #23 requires starting from a *current* main, not just a clean one:
// a stale local main would silently base the ticket branch on outdated code.
// The remote is only inspected (`ls-remote`); local refs and the worktree are
// never mutated here, and nothing is rebased or merged automatically.
export function checkMainCurrency(currency: MainCurrency): MainCurrencyCheck {
  if (currency.localHead.toLowerCase() === currency.remoteHead.toLowerCase()) {
    return { ok: true };
  }
  return {
    ok: false,
    reason:
      `local main (${currency.localHead}) is not current with origin/main ` +
      `(${currency.remoteHead}): update local main (e.g. git pull --ff-only on main) and ` +
      'rerun; refusing to branch from a stale base',
  };
}

export async function getRemoteMainHead(execute: CommandExecutor = runCommand): Promise<string> {
  const { stdout } = await execute('git', ['ls-remote', 'origin', 'refs/heads/main']);
  const head = stdout.split(/\s+/)[0] ?? '';
  if (!/^[0-9a-fA-F]{40}$/.test(head)) {
    throw new Error(
      `cannot resolve origin/main HEAD from git ls-remote output: ${stdout.trim().slice(0, 120)}`,
    );
  }
  return head;
}

export interface TicketIssue {
  number: number;
  title: string;
  state: string;
  labels: string[];
}

interface GhIssueView {
  number?: unknown;
  title?: unknown;
  state?: unknown;
  labels?: unknown;
}

function parseIssueLabels(labels: unknown): string[] {
  if (!Array.isArray(labels)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of labels) {
    if (typeof entry === 'string') {
      names.push(entry);
    } else if (typeof entry === 'object' && entry !== null && 'name' in entry) {
      const name: unknown = (entry as { name?: unknown }).name;
      if (typeof name === 'string') {
        names.push(name);
      }
    }
  }
  return names;
}

export function parseIssueView(stdout: string): TicketIssue {
  const parsed = JSON.parse(stdout) as GhIssueView;
  if (typeof parsed.number !== 'number' || typeof parsed.title !== 'string') {
    throw new Error('agent:ticket could not parse the ticket issue (expected number and title)');
  }
  return {
    number: parsed.number,
    title: parsed.title,
    state: typeof parsed.state === 'string' ? parsed.state : '',
    labels: parseIssueLabels(parsed.labels),
  };
}

export type TicketIssueCheck = { ok: true } | { ok: false; reason: string };

// Only approved `ready-for-agent` tickets from the dependency frontier are
// implemented; anything else is a planning/triage matter, not an agent run.
export function checkTicketIssue(issue: TicketIssue): TicketIssueCheck {
  if (issue.state !== 'OPEN') {
    return {
      ok: false,
      reason: `refusing ticket #${String(issue.number)}: state is ${issue.state}, expected OPEN`,
    };
  }
  if (!issue.labels.includes('ready-for-agent')) {
    return {
      ok: false,
      reason: `refusing ticket #${String(issue.number)}: missing the ready-for-agent label`,
    };
  }
  return { ok: true };
}

// The initial push happens before the PR exists, so it cannot go through the
// PR-bound `safePushBranch`; it reuses the same `checkSafePush` guards with
// the intended PR shape (head is this branch, base is `main`) instead of
// reimplementing push safety inconsistently. Later pushes go through
// `review:cycle` and its safe-push path.
export function checkInitialPush(state: StartState): SafePushCheck {
  return checkSafePush({
    currentBranch: state.currentBranch,
    prHead: state.currentBranch,
    prBase: 'main',
    pushTarget: 'origin',
    worktreeClean: state.worktreeClean,
  });
}

export function extractSummaryPath(output: string): string | undefined {
  let found: string | undefined;
  for (const line of output.split('\n')) {
    const path = /Run summary:\s*(\S+)/.exec(line)?.[1];
    if (path !== undefined) {
      found = path;
    }
  }
  return found;
}

export interface WorkerOutput {
  stdout: string;
  stderr: string;
}

export type WorkerRunner = (
  command: string,
  args: readonly string[],
  label: string,
) => Promise<WorkerOutput>;

function defaultWorkerRunner(
  command: string,
  args: readonly string[],
  label: WorkerLabel,
): Promise<WorkerOutput> {
  // Bounded execution (ticket #31): implement and review-cycle workers share
  // the same timeout semantics as local orchestration so a hung worker is
  // terminated with a distinguishable TIMEOUT instead of hanging the runner.
  return runWorkerStream(command, args, { label, timeoutMs: timeoutForWorker(label) });
}

export interface AgentTicketDeps {
  execute?: CommandExecutor;
  runWorker?: WorkerRunner;
  runGates?: (execute: CommandExecutor) => Promise<GateResult[]>;
  // Attributable skill-evidence finalizer (ticket #116). Defaults to the
  // deterministic evidence-capable seam over the worker's real stdout lines;
  // tests inject a captor so unit runs never touch the filesystem. Failures
  // are best-effort and never change the orchestration outcome.
  finalizeEvidence?: EvidenceFinalizer;
  // Bounded recovery capturer (ticket #127). Defaults to the read-only
  // bounded capture over the actual failed worktree; tests inject a captor
  // so unit runs never touch the filesystem. Failures are best-effort and
  // never change the orchestration outcome.
  captureRecovery?: RecoveryCapturer;
  // Stage reporter for the durable run-status surface (ticket #31). Called
  // once per reached stage, in order; defaults to silence so local runs stay
  // quiet and existing callers are unaffected.
  onStage?: (stage: TicketStageName) => void;
  // Durable status comment owned by the calling workflow (ticket #31). When
  // present, each reached stage and the terminal outcome PATCH that single
  // comment; when absent, status stays silent. Publication is best-effort and
  // never changes the orchestration outcome.
  status?: StatusEnv;
  // Terminal outcome recording (ticket #31). Defaults to silence; the CLI
  // entrypoint wires the repository-local outcome file read by the workflow
  // terminal step, and tests inject a captor.
  recordOutcome?: (record: AgentTicketOutcome) => Promise<void> | void;
  // Trusted-publication handoff writer (ticket #36). Persists the
  // patch/metadata bundle when the correction touches `.github/workflows/**`;
  // defaults to the repository-local handoff paths, tests inject a captor.
  writeHandoff?: (input: { record: WorkflowHandoffRecord; patch: string }) => Promise<void> | void;
}

export type EvidenceFinalizer = (input: {
  worker: 'agent-ticket';
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
  lines: readonly string[];
  truncatedStream?: boolean;
}) => Promise<string | undefined>;

export type RecoveryCapturer = (
  input: RecoveryCaptureInput,
) => Promise<ImplementationRecoveryRecord>;

// Bounded recovery capture (ticket #127). Runs only after bounded worker
// termination has been established by the worker-stream handshake.
// Read-only Git/filesystem operations through the bounded command seam with a
// finite capture deadline; every failure degrades to honest
// incomplete/unavailable metadata and never replaces the original
// TIMEOUT/BLOCKED result.
async function defaultCaptureRecovery(
  input: RecoveryCaptureInput,
): Promise<ImplementationRecoveryRecord> {
  try {
    return await captureImplementationRecovery(
      { base: input.base, branch: input.branch, lines: input.lines },
      {
        execute: (command, args) =>
          runBoundedCommand(command, args, {
            timeoutMs: RECOVERY_COMMAND_TIMEOUT_MS,
            maxBufferBytes: RECOVERY_GIT_OUTPUT_CAP_BYTES,
          }),
      },
    );
  } catch {
    return createUnavailableRecovery({
      base: input.base,
      branch: input.branch,
      head: '(unknown)',
      reasons: ['recovery capture failed'],
      diagnostics: summarizeWorkerLifecycle(input.lines),
    });
  }
}

async function defaultFinalizeEvidence(input: {
  worker: 'agent-ticket';
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
  lines: readonly string[];
  truncatedStream?: boolean;
}): Promise<string | undefined> {
  try {
    const result = await finalizeSkillEvidence({
      invocation: buildEvidenceInvocation({
        worker: input.worker,
        command: input.command,
        axis: input.axis,
        attempt: input.attempt,
        workerStartHead: input.workerStartHead,
      }),
      lines: input.lines,
      exporter: commandSessionExporter(),
      ...(input.truncatedStream === undefined ? {} : { truncatedStream: input.truncatedStream }),
    });
    return result.evidencePath;
  } catch {
    return undefined;
  }
}

export interface AgentTicketResult {
  exitCode: number;
  branch?: string;
  prNumber?: number;
  prUrl?: string;
  summaryPath?: string;
  failedStage?: string;
  reason?: string;
  // True when the failure was a bounded worker timeout, distinct from model,
  // gate, CI, human-decision, stale-HEAD, or cancellation failures.
  timedOut?: boolean;
  // Bounded recovery record (ticket #127) for implement worker timeouts and
  // failures. Carried through to the outcome record; never changes the
  // terminal TIMEOUT/BLOCKED semantics.
  recovery?: ImplementationRecoveryRecord;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorExitCode(error: unknown): number {
  const code: unknown = (error as { code?: unknown }).code;
  return code === 2 ? 2 : 1;
}

function reportDurableState(partial: { branch?: string; prNumber?: number; prUrl?: string }): void {
  const parts: string[] = [];
  if (partial.branch !== undefined) {
    parts.push(`branch=${partial.branch}`);
  }
  if (partial.prNumber !== undefined) {
    parts.push(`pr=#${String(partial.prNumber)}`);
  }
  if (partial.prUrl !== undefined) {
    parts.push(`prUrl=${partial.prUrl}`);
  }
  parts.push('run summary: .review-cycle/latest.json (once review:cycle has run)');
  console.error(`Durable state: ${parts.join(' ')}`);
}

function failResult(
  stage: string,
  reason: string,
  branch?: string,
  timedOut?: boolean,
): AgentTicketResult {
  const base =
    branch === undefined
      ? { exitCode: 1, failedStage: stage, reason }
      : { exitCode: 1, failedStage: stage, reason, branch };
  return timedOut ? { ...base, timedOut: true } : base;
}

async function defaultWriteHandoff(input: {
  record: WorkflowHandoffRecord;
  patch: string;
}): Promise<void> {
  await persistWorkflowHandoffBundle(input.record, input.patch);
}

export async function runAgentTicket(
  rawTicket: string | undefined,
  deps: AgentTicketDeps = {},
): Promise<AgentTicketResult> {
  const execute = deps.execute ?? runCommand;
  const runWorker = deps.runWorker ?? defaultWorkerRunner;
  const runGates = deps.runGates ?? runQualityGates;
  const reportStage = (stage: TicketStageName): void => {
    deps.onStage?.(stage);
  };

  // Durable status publication (ticket #31): the calling workflow owns one
  // status comment per run and passes its routing here. Each reached stage
  // and the terminal outcome PATCH that same comment with deterministic
  // repository-owned metadata. Absent routing means a local run: silent.
  const startedAtIso = new Date().toISOString();
  const completedStages: string[] = [];
  const statusTarget = deps.status;

  // Attributable skill evidence for the initial implementation worker
  // (ticket #116). Persisted best-effort on success, error and timeout
  // finalization; the pointer rides the existing outcome record additively
  // and never changes orchestration semantics.
  let skillEvidencePath: string | undefined;
  const finalizeEvidence: EvidenceFinalizer =
    deps.finalizeEvidence ?? ((input) => defaultFinalizeEvidence(input));

  async function settleImplementEvidence(
    lines: readonly string[],
    workerStartHead: string,
    truncatedStream?: boolean,
  ): Promise<void> {
    try {
      const path = await finalizeEvidence({
        worker: 'agent-ticket',
        command: 'implement',
        axis: 'implement',
        attempt: 1,
        workerStartHead,
        lines,
        ...(truncatedStream === undefined ? {} : { truncatedStream }),
      });
      if (path !== undefined) {
        skillEvidencePath = path;
      }
    } catch {
      // Best-effort: evidence collection never changes the outcome.
    }
  }

  // Worker failures carry no stdout through the `WorkerRunner` seam, but an
  // injected runner may attach the partial stream it observed. The default
  // streaming route below always has its capture instead.
  function partialStdoutLines(error: unknown): readonly string[] {
    const stdout: unknown = (error as { stdout?: unknown }).stdout;
    if (typeof stdout !== 'string' || stdout === '') {
      return [];
    }
    return stdout.split('\n');
  }

  function workerForStage(stage: TicketStageName): string | undefined {
    if (stage === 'implementation') {
      return 'implement';
    }
    if (stage === 'review') {
      return 'review-cycle';
    }
    return undefined;
  }

  async function publishStage(
    stage: TicketStageName,
    options: {
      branch: string;
      head?: string;
      outcome?: RunStatusOutcome;
      reason?: string;
      actionRequired?: string;
    },
  ): Promise<void> {
    if (statusTarget === undefined || ticketNumber === undefined) {
      return;
    }
    let head = options.head;
    if (head === undefined) {
      try {
        head = await getCurrentHead(execute);
      } catch {
        head = '(unknown)';
      }
    }
    const worker = workerForStage(stage);
    await publishStageStatus(execute, statusTarget, {
      target: `issue #${String(ticketNumber)}`,
      branch: options.branch,
      head,
      currentStage: stage,
      completedStages: [...completedStages],
      startedAt: startedAtIso,
      ...(worker === undefined ? {} : { worker }),
      ...(options.outcome === undefined ? {} : { outcome: options.outcome }),
      ...(options.reason === undefined ? {} : { reason: options.reason }),
      ...(options.actionRequired === undefined ? {} : { actionRequired: options.actionRequired }),
    });
  }

  // Terminal outcome recording (ticket #31): every terminal state is recorded
  // best-effort through the injected recorder so the workflow terminal step
  // can report the exact outcome even when `review:cycle` never ran. The CLI
  // entrypoint wires the repository-local outcome file; tests inject a captor
  // or stay silent. Recording never changes the result itself.
  async function recordTerminal(result: AgentTicketResult, actionRequired?: string): Promise<void> {
    try {
      const mapped = terminalOutcomeFor(result);
      await deps.recordOutcome?.({
        outcome: mapped.outcome,
        stage: mapped.stage,
        reason: result.reason ?? 'terminal state',
        startedAt: startedAtIso,
        completedStages: [...completedStages],
        ...(actionRequired === undefined ? {} : { actionRequired }),
        ...(skillEvidencePath === undefined ? {} : { skillEvidencePath }),
        ...(result.recovery === undefined ? {} : { recovery: result.recovery }),
      });
    } catch {
      // Best-effort: recording never changes the terminal outcome.
    }
  }

  // Terminal publication always carries an attention outcome except READY:
  // BLOCKED, NEEDS-DECISION, and TIMEOUT mention the owner with stage, reason,
  // and the exact action required so GitHub Mobile pushes.
  async function terminal(
    result: AgentTicketResult,
    stage: TicketStageName,
    branch: string,
    outcome: RunStatusOutcome,
    actionRequired: string,
    head?: string,
  ): Promise<AgentTicketResult> {
    if (result.reason !== undefined) {
      await publishStage(stage, { branch, head, outcome, reason: result.reason, actionRequired });
    }
    await recordTerminal(result, actionRequired);
    return result;
  }

  reportStage('validation');
  let ticket: number;
  let ticketNumber: number | undefined;
  try {
    ticket = parseTicketArg(rawTicket);
    ticketNumber = ticket;
  } catch (error) {
    const reason = errorMessage(error);
    console.error(`AGENT-TICKET BLOCKED (validate): ${reason}`);
    console.error('usage: agent-ticket <issue-number>');
    const result = failResult('validate', reason);
    await recordTerminal(
      result,
      'Provide a single positive integer issue number: npm run agent:ticket -- <issue>.',
    );
    return result;
  }

  const earlyTerminal = async (
    result: AgentTicketResult,
    actionRequired: string,
  ): Promise<AgentTicketResult> =>
    terminal(result, 'validation', '(starting)', 'BLOCKED', actionRequired, '(starting)');

  let start: StartState;
  try {
    start = {
      currentBranch: await getCurrentBranch(execute),
      worktreeClean: await isWorktreeClean(execute),
    };
  } catch (error) {
    const reason = `cannot validate the starting worktree: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (start-state): ${reason}`);
    return earlyTerminal(
      failResult('start-state', reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }
  const startCheck = checkStartState(start);
  if (!startCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${startCheck.reason}`);
    return earlyTerminal(
      failResult('start-state', startCheck.reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }

  let mainHead: string;
  let originHead: string;
  try {
    mainHead = await getCurrentHead(execute);
    originHead = await getRemoteMainHead(execute);
  } catch (error) {
    const reason =
      `cannot prove local main is current with origin/main: ${errorMessage(error)}; ` +
      'refusing to start from an unverifiable base';
    console.error(`AGENT-TICKET BLOCKED (start-state): ${reason}`);
    return earlyTerminal(
      failResult('start-state', reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }
  const currencyCheck = checkMainCurrency({ localHead: mainHead, remoteHead: originHead });
  if (!currencyCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (start-state): ${currencyCheck.reason}`);
    return earlyTerminal(
      failResult('start-state', currencyCheck.reason),
      'Start from a clean, current main worktree, then rerun /agent-ticket.',
    );
  }

  let issue: TicketIssue;
  try {
    const { stdout } = await execute('gh', [
      'issue',
      'view',
      String(ticket),
      '--json',
      'number,title,state,labels',
    ]);
    issue = parseIssueView(stdout);
  } catch (error) {
    const reason = `cannot read ticket #${String(ticket)}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (ticket): ${reason}`);
    return earlyTerminal(
      failResult('ticket', reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }
  if (issue.number !== ticket) {
    const reason = `ticket mismatch: requested #${String(ticket)} but gh returned #${String(issue.number)}`;
    console.error(`AGENT-TICKET BLOCKED (ticket): ${reason}`);
    return earlyTerminal(
      failResult('ticket', reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }
  const issueCheck = checkTicketIssue(issue);
  if (!issueCheck.ok) {
    console.error(`AGENT-TICKET BLOCKED (ticket): ${issueCheck.reason}`);
    return earlyTerminal(
      failResult('ticket', issueCheck.reason),
      'Use an OPEN ready-for-agent ticket, then rerun /agent-ticket.',
    );
  }

  const branch = ticketBranchName(ticket, issue.title);
  try {
    await execute('git', ['show-ref', '--verify', `refs/heads/${branch}`]);
    const reason = `${branch} already exists; refusing to reuse or repair an existing branch`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return await earlyTerminal(
      failResult('branch', reason, branch),
      'Remove or rename the conflicting branch, then rerun /agent-ticket.',
    );
  } catch {
    // Absent locally: the expected case, continue.
  }
  try {
    await execute('git', ['checkout', '-b', branch]);
  } catch (error) {
    const reason = `cannot create ticket branch ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (branch): ${reason}`);
    return earlyTerminal(
      failResult('branch', reason, branch),
      'Remove or rename the conflicting branch, then rerun /agent-ticket.',
    );
  }
  console.log(`Created ticket branch ${branch} from main.`);

  // `git checkout -b` does not move HEAD, so the pre-checkout main tip is the
  // baseline the implementation must advance.
  const headBefore = mainHead;
  reportStage('implementation');
  await publishStage('implementation', { branch, head: headBefore });
  // The default route streams worker stdout through an evidence capture so
  // events observed before an error or timeout survive with the original
  // outcome. Injected runners (tests) report their own completed stdout, or
  // partial stdout attached to a thrown error.
  const implementCapture = deps.runWorker === undefined ? createEvidenceCapture() : null;
  try {
    if (runWorker === defaultWorkerRunner) {
      const capture = implementCapture ?? createEvidenceCapture();
      await runWorkerStream(
        'opencode',
        buildImplementArgs(ticket),
        {
          label: 'implement',
          timeoutMs: timeoutForWorker('implement'),
          stdoutLogFilter: suppressJsonWorkerLines,
        },
        undefined,
        {
          onStdoutLine: (line) => {
            capture.pushLine(line);
          },
        },
      );
      await settleImplementEvidence([...capture.lines], headBefore, capture.wasTruncated());
    } else {
      const output = await runWorker('opencode', buildImplementArgs(ticket), 'implement');
      await settleImplementEvidence(output.stdout.split('\n'), headBefore);
    }
  } catch (error) {
    // Error/timeout finalization still persists useful minimal evidence
    // without masking the original exit or timeout (ticket #116).
    const recoveryLines =
      implementCapture !== null ? [...implementCapture.lines] : partialStdoutLines(error);
    if (implementCapture !== null) {
      await settleImplementEvidence(
        [...implementCapture.lines],
        headBefore,
        implementCapture.wasTruncated(),
      );
    } else {
      await settleImplementEvidence(partialStdoutLines(error), headBefore);
    }
    // Bounded recovery capture (ticket #127): runs only after bounded worker
    // termination has been established by the worker-stream handshake (SIGTERM,
    // SIGKILL escalation, finite termination deadline, process-group exit
    // verification) for both timeout and non-timeout implement failures.
    // When termination is unconfirmed the worktree may still be changing, so no
    // snapshot is read: honest unavailable evidence is retained instead.
    // Capture failures keep honest unavailable metadata and never replace the
    // original TIMEOUT/BLOCKED result.
    let recovery: ImplementationRecoveryRecord | undefined;
    // Unconfirmed termination skips the worktree read conservatively: honest
    // unavailable evidence instead of a potentially torn snapshot. Timeout
    // duck-types without an explicit terminated=true fail closed, as does any
    // real-stream failure without explicit confirmation; the injected test seam
    // (no evidence capture) has no process group, so only explicit false blocks.
    const terminatedFlag = (error as { terminated?: unknown }).terminated;
    const terminationUnconfirmed = isWorkerTimeout(error)
      ? terminatedFlag !== true
      : implementCapture !== null
        ? terminatedFlag !== true
        : terminatedFlag === false;
    if (terminationUnconfirmed) {
      recovery = createUnavailableRecovery({
        base: headBefore,
        branch,
        reasons: ['worker termination unconfirmed within bound; snapshot skipped'],
        diagnostics: summarizeWorkerLifecycle(recoveryLines),
      });
    } else {
      try {
        const captureRecovery = deps.captureRecovery ?? defaultCaptureRecovery;
        recovery = await captureRecovery({ base: headBefore, branch, lines: recoveryLines });
      } catch {
        recovery = undefined;
      }
    }
    const timedOut = isWorkerTimeout(error);
    const reason = timedOut
      ? `/implement timed out for ticket #${String(ticket)}: ${errorMessage(error)}`
      : `/implement failed for ticket #${String(ticket)}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET ${timedOut ? 'TIMEOUT' : 'FAILED'} (implement): ${reason}`);
    // Safe console surface: fixed summary with presence/completeness/counts
    // only; source patch content stays in the uploaded outcome record.
    if (recovery !== undefined) {
      console.error(formatRecoverySummary(recovery));
    }
    reportDurableState({ branch });
    const recoveryHead =
      recovery !== undefined && recovery.head !== '(unknown)' ? recovery.head : headBefore;
    const result = failResult('implement', reason, branch, timedOut ? true : undefined);
    return terminal(
      recovery === undefined ? result : { ...result, recovery },
      'implementation',
      branch,
      timedOut ? 'TIMEOUT' : 'BLOCKED',
      timedOut
        ? `The implement worker exceeded its bound; ${RECOVERY_ACTION_TAIL}`
        : `The implement worker failed; ${RECOVERY_ACTION_TAIL}`,
      recoveryHead,
    );
  }
  const headAfter = await getCurrentHead(execute);
  if (headAfter === headBefore) {
    const reason = `/implement produced no local commits on ${branch}`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('implement', reason, branch),
      'implementation',
      branch,
      'BLOCKED',
      'Inspect the ticket branch state, then rerun /agent-ticket.',
      headBefore,
    );
  }
  if (!(await isWorktreeClean(execute))) {
    const reason = `/implement left uncommitted changes on ${branch}; refusing to push a dirty worktree`;
    console.error(`AGENT-TICKET FAILED (implement): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('implement', reason, branch),
      'implementation',
      branch,
      'BLOCKED',
      'Inspect the ticket branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(`Implementation advanced ${branch}: ${headBefore} -> ${headAfter}.`);
  completedStages.push('implementation');

  reportStage('gates');
  await publishStage('gates', { branch, head: headAfter });
  const gates = await runGates(execute);
  for (const gate of gates) {
    console.log(`gate ${gate.name}: ${gate.ok ? 'PASS' : 'FAIL'}`);
  }
  if (!qualityGatesPass(gates)) {
    const reason = 'repository quality gates failed for the implementation HEAD';
    console.error(`AGENT-TICKET BLOCKED (gates): ${reason}.`);
    reportDurableState({ branch });
    return terminal(
      failResult('gates', reason, branch),
      'gates',
      branch,
      'BLOCKED',
      'Fix the failing gate locally, then rerun /agent-ticket.',
      headAfter,
    );
  }
  completedStages.push('gates');

  // Trusted-publication handoff (ticket #36): a correction touching
  // `.github/workflows/**` must never attempt the doomed generic push with
  // the least-privilege credential. Detection runs over the exact known range
  // (origin/main at start through the implementation HEAD) and stops with a
  // distinguishable BLOCKED reason while persisting the patch plus exact
  // base/head metadata for the trusted publisher.
  let workflowFiles: string[];
  try {
    workflowFiles = await listChangedWorkflowFiles(execute, originHead, headAfter);
  } catch (error) {
    const reason =
      `${TRUSTED_PUBLICATION_MARKER}: cannot prove the correction is free of workflow files: ` +
      errorMessage(error);
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', reason, branch),
      'push',
      branch,
      'BLOCKED',
      formatHandoffAction(),
      headAfter,
    );
  }
  if (workflowFiles.length > 0) {
    const record = buildHandoffRecord({
      branch,
      base: originHead,
      head: headAfter,
      files: workflowFiles,
    });
    let patch: string;
    try {
      patch = await getWorkflowPatch(execute, originHead, headAfter);
    } catch (error) {
      patch = `# workflow handoff patch unavailable: ${errorMessage(error)}\n`;
    }
    const writeHandoff = deps.writeHandoff ?? defaultWriteHandoff;
    try {
      await writeHandoff({ record, patch });
    } catch (error) {
      console.error(`AGENT-TICKET handoff persistence failed: ${errorMessage(error)}`);
    }
    console.error(`AGENT-TICKET BLOCKED (push): ${record.reason}`);
    console.error(`Handoff evidence: ${HANDOFF_PATCH_PATH} ${HANDOFF_RECORD_PATH}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', record.reason, branch),
      'push',
      branch,
      'BLOCKED',
      formatHandoffAction(),
      headAfter,
    );
  }

  reportStage('push');
  await publishStage('push', { branch, head: headAfter });
  const pushCheck = checkInitialPush({ currentBranch: branch, worktreeClean: true });
  if (!pushCheck.ok) {
    const reason = `initial push refused: ${pushCheck.reason}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', reason, branch),
      'push',
      branch,
      'BLOCKED',
      'Inspect push permissions and branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  try {
    await execute('git', ['push', '-u', 'origin', branch]);
  } catch (error) {
    const reason = `initial push of ${branch} failed: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (push): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('push', reason, branch),
      'push',
      branch,
      'BLOCKED',
      'Inspect push permissions and branch state, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(`Pushed ticket branch: origin/${branch}`);
  completedStages.push('push');

  reportStage('PR creation');
  await publishStage('PR creation', { branch, head: headAfter });
  try {
    await execute('gh', buildPrCreateArgs({ branch, title: issue.title, ticket }));
  } catch (error) {
    const reason = `draft PR creation failed for ${branch}: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (pr): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('pr', reason, branch),
      'PR creation',
      branch,
      'BLOCKED',
      'Inspect PR creation permissions, then rerun /agent-ticket.',
      headAfter,
    );
  }
  let prNumber: number;
  let prUrl: string | undefined;
  try {
    const pr = await getPrForBranch(undefined, execute);
    prNumber = pr.number;
    prUrl = pr.url;
  } catch (error) {
    const reason = `draft PR was created but cannot be resolved: ${errorMessage(error)}`;
    console.error(`AGENT-TICKET BLOCKED (pr): ${reason}`);
    reportDurableState({ branch });
    return terminal(
      failResult('pr', reason, branch),
      'PR creation',
      branch,
      'BLOCKED',
      'Inspect PR creation permissions, then rerun /agent-ticket.',
      headAfter,
    );
  }
  console.log(
    `Draft PR #${String(prNumber)}${prUrl === undefined ? '' : `: ${prUrl}`} (base main).`,
  );
  completedStages.push('PR creation');

  let review: WorkerOutput;
  reportStage('review');
  await publishStage('review', { branch, head: headAfter });
  try {
    review = await runWorker('npm', buildReviewCycleArgs(), 'review-cycle');
  } catch (error) {
    const exitCode = errorExitCode(error);
    const timedOut = isWorkerTimeout(error);
    const reason = timedOut
      ? `review:cycle timed out: ${errorMessage(error)}`
      : `review:cycle did not reach READY: ${errorMessage(error)}`;
    console.error(
      `AGENT-TICKET ${timedOut ? 'TIMEOUT' : exitCode === 2 ? 'ESCALATED' : 'BLOCKED'} (review-cycle): ${reason}`,
    );
    reportDurableState({ branch, prNumber, prUrl });
    const outcome: RunStatusOutcome = timedOut
      ? 'TIMEOUT'
      : exitCode === 2
        ? 'NEEDS-DECISION'
        : 'BLOCKED';
    const actionRequired =
      outcome === 'NEEDS-DECISION'
        ? 'A product, architecture, or contract decision is required before automation can continue.'
        : outcome === 'TIMEOUT'
          ? 'The review worker exceeded its bound; rerun once the runner is free.'
          : 'Inspect .review-cycle/latest.json, then rerun.';
    return terminal(
      {
        exitCode,
        failedStage: 'review-cycle',
        reason,
        branch,
        prNumber,
        prUrl,
        ...(timedOut ? { timedOut: true } : {}),
      },
      'review',
      branch,
      outcome,
      actionRequired,
    );
  }
  const summaryPath = extractSummaryPath(review.stdout) ?? '.review-cycle/latest.json';
  reportStage('final acceptance-ready');
  completedStages.push('review');
  await publishStage('final acceptance-ready', {
    branch,
    outcome: 'READY',
    reason: 'ready for final acceptance',
  });
  console.log('');
  console.log(`READY FOR FINAL ACCEPTANCE\nBranch: ${branch}\nPR: #${String(prNumber)}`);
  console.log(`Run summary: ${summaryPath}`);
  const success: AgentTicketResult = { exitCode: 0, branch, prNumber, prUrl, summaryPath };
  await recordTerminal(success);
  return success;
}
