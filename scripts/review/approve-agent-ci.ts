import { runCommand, type CommandExecutor } from './runner.js';
import {
  TRUSTED_PUBLISHER_APP_SLUG,
  findMatchingHandoffMarker,
  isWorkflowFile,
  parseTrustedHandoffMarker,
  type TrustedHandoffMarker,
} from './workflow-handoff.js';

// Deterministic provenance guards for auto-approving exact-HEAD CI on trusted
// agent-created PRs (ticket #44). The separate trusted approver workflow is
// driven by `workflow_run` for the `ci` workflow and approves only runs that
// prove every guard below from GitHub-owned metadata. It never checks out or
// executes PR code, and workflow-file PR changes stay governed by the #36
// trusted-publication policy. Ticket #82 adds a narrow trusted-handoff
// exception: a workflow-file correction published through the separately
// authorized trusted publisher (`chatgpt-codex-connector`) may qualify only
// with a matching `github-actions[bot]` handoff marker on the source ticket,
// full workflow-file coverage, and independent exact-HEAD equality. All
// refusals fail closed with concise evidence.
export const APPROVE_TRUSTED_WORKFLOW_NAME = 'ci';
export const APPROVE_REQUIRED_CONCLUSION = 'action_required';
export const APPROVE_BOT_LOGIN = 'github-actions[bot]';
export const APPROVE_READY_LABEL = 'ready-for-agent';
export const APPROVE_TRUSTED_PUBLISHER_APP_SLUG = TRUSTED_PUBLISHER_APP_SLUG;

const TICKET_BRANCH_PATTERN = /^ticket\/([1-9]\d*)-[^/]+$/;
const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

export function parseTicketBranch(branch: string | undefined | null): number | null {
  if (typeof branch !== 'string') {
    return null;
  }
  const match = TICKET_BRANCH_PATTERN.exec(branch.trim());
  const ticketText = match?.[1];
  if (ticketText === undefined) {
    return null;
  }
  const ticket = Number.parseInt(ticketText, 10);
  if (!Number.isInteger(ticket) || ticket <= 0) {
    return null;
  }
  return ticket;
}

export function prTitleIdentifiesTicket(title: string | undefined | null, ticket: number): boolean {
  if (typeof title !== 'string') {
    return false;
  }
  return title.endsWith(` (#${String(ticket)})`);
}

export function prBodyIdentifiesTicket(body: string | undefined | null, ticket: number): boolean {
  if (typeof body !== 'string') {
    return false;
  }
  return body.includes(`Automated implementation of #${String(ticket)}`);
}

export function prIdentifiesTicket(
  title: string | undefined | null,
  body: string | undefined | null,
  ticket: number,
): boolean {
  return prTitleIdentifiesTicket(title, ticket) && prBodyIdentifiesTicket(body, ticket);
}

export interface AgentCiProvenance {
  workflowName: string;
  runConclusion: string | null;
  associatedPrCount: number;
  prNumber: number;
  prState: string;
  prBaseRef: string;
  prHeadRef: string;
  prHeadSha: string;
  prAuthorLogin: string;
  prHeadRepo: string;
  prBaseRepo: string;
  prTitle: string;
  prBody: string;
  runHeadSha: string;
  issueNumber: number;
  issueState: string;
  issueLabels: readonly string[];
  issueIsPullRequest: boolean;
  changedFiles: readonly string[];
  // Ticket #82 trusted-handoff provenance. Only the PR issue representation
  // (`issues/{prNumber}`) carries the publisher app slug; the source ticket
  // (`issues/{ticket}`) never proves publication provenance. Handoff markers
  // are parsed from `github-actions[bot]` comments on the source ticket.
  // Absent for normal bot PRs.
  prPerformedViaAppSlug?: string;
  handoffMarkers?: readonly TrustedHandoffMarker[];
}

export type AgentCiDecision =
  | { approved: true; ticket: number; reason: string }
  | { approved: false; ticket?: number; reason: string };

function isExactSha(sha: string | undefined | null): boolean {
  return typeof sha === 'string' && EXACT_SHA_PATTERN.test(sha.trim());
}

function checkExactHeadEquality(
  runHeadSha: string,
  prHeadSha: string,
  ticket: number,
): AgentCiDecision | null {
  if (!isExactSha(runHeadSha) || !isExactSha(prHeadSha)) {
    return {
      approved: false,
      ticket,
      reason:
        'refusing: run HEAD or PR HEAD SHA is missing or ambiguous; cannot prove exact-HEAD equality',
    };
  }
  if (runHeadSha.toLowerCase() !== prHeadSha.toLowerCase()) {
    return {
      approved: false,
      ticket,
      reason: `refusing: run HEAD ${runHeadSha} does not equal PR HEAD ${prHeadSha}`,
    };
  }
  return null;
}

export function decideAgentCiApproval(provenance: AgentCiProvenance): AgentCiDecision {
  if (provenance.workflowName !== APPROVE_TRUSTED_WORKFLOW_NAME) {
    return {
      approved: false,
      reason: `refusing: triggering workflow is ${provenance.workflowName || '(missing)'}, expected ${APPROVE_TRUSTED_WORKFLOW_NAME}`,
    };
  }
  if (provenance.runConclusion !== APPROVE_REQUIRED_CONCLUSION) {
    return {
      approved: false,
      reason: `refusing: run conclusion is ${provenance.runConclusion ?? '(missing)'}, expected ${APPROVE_REQUIRED_CONCLUSION}`,
    };
  }
  if (provenance.associatedPrCount !== 1) {
    return {
      approved: false,
      reason: `refusing: expected exactly one associated PR, got ${String(provenance.associatedPrCount)}`,
    };
  }
  if (provenance.prState.toLowerCase() !== 'open') {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} state is ${provenance.prState || '(missing)'}, expected OPEN`,
    };
  }
  if (provenance.prBaseRef !== 'main') {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} base must be main, got ${provenance.prBaseRef || '(missing)'}`,
    };
  }
  if (provenance.prHeadRepo !== provenance.prBaseRepo) {
    return {
      approved: false,
      reason: `refusing: PR #${String(provenance.prNumber)} is not same-repository (head ${provenance.prHeadRepo || '(missing)'} vs base ${provenance.prBaseRepo || '(missing)'}); fork PRs are not supported`,
    };
  }
  const ticket = parseTicketBranch(provenance.prHeadRef);
  if (ticket === null) {
    return {
      approved: false,
      reason: `refusing: PR head branch ${provenance.prHeadRef || '(missing)'} does not match the ticket/<number>-... convention`,
    };
  }
  if (provenance.issueIsPullRequest) {
    return {
      approved: false,
      ticket,
      reason: `refusing: corresponding #${String(provenance.issueNumber)} is a pull request, expected an issue`,
    };
  }
  if (provenance.issueNumber !== ticket) {
    return {
      approved: false,
      ticket,
      reason: `refusing: corresponding issue #${String(provenance.issueNumber)} does not match the branch ticket #${String(ticket)}; PR must identify the same ticket`,
    };
  }
  if (provenance.issueState.toLowerCase() !== 'open') {
    return {
      approved: false,
      ticket,
      reason: `refusing: issue #${String(provenance.issueNumber)} state is ${provenance.issueState || '(missing)'}, expected OPEN`,
    };
  }
  if (!provenance.issueLabels.includes(APPROVE_READY_LABEL)) {
    return {
      approved: false,
      ticket,
      reason: `refusing: issue #${String(provenance.issueNumber)} lacks the ${APPROVE_READY_LABEL} label`,
    };
  }
  if (!prIdentifiesTicket(provenance.prTitle, provenance.prBody, ticket)) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR title/body do not identify it as the automated implementation of #${String(ticket)}`,
    };
  }
  const workflowFiles = provenance.changedFiles.filter((file) => isWorkflowFile(file));
  const isBotPr = provenance.prAuthorLogin === APPROVE_BOT_LOGIN;
  if (isBotPr) {
    if (workflowFiles.length > 0) {
      return {
        approved: false,
        ticket,
        reason: `refusing: PR touches workflow files (${workflowFiles.join(', ')}); workflow-file corrections remain governed by trusted publication and must not be auto-approved`,
      };
    }
    const headCheck = checkExactHeadEquality(provenance.runHeadSha, provenance.prHeadSha, ticket);
    if (headCheck !== null) {
      return headCheck;
    }
    return {
      approved: true,
      ticket,
      reason: `approved: trusted agent PR #${String(provenance.prNumber)} for issue #${String(ticket)} at exact HEAD ${provenance.prHeadSha}`,
    };
  }
  // Ticket #82 trusted-handoff path for non-bot PRs. Trust is never inferred
  // from author login, owner association, title/body, branch naming, or a
  // user-copyable label: it requires the separately authorized trusted
  // publisher app on the PR issue representation plus a matching bot handoff
  // marker on the source ticket covering every workflow file. Only a
  // workflow-file correction may use this path.
  if (workflowFiles.length === 0) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR #${String(provenance.prNumber)} author is ${provenance.prAuthorLogin || '(missing)'}, expected ${APPROVE_BOT_LOGIN}; non-bot PRs qualify only as workflow-file trusted handoffs`,
    };
  }
  const markers = provenance.handoffMarkers ?? [];
  const matching = findMatchingHandoffMarker(markers, {
    ticket,
    branch: provenance.prHeadRef,
    workflowFiles,
  });
  if (matching === null) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR #${String(provenance.prNumber)} has no matching trusted-workflow-handoff marker for ticket #${String(ticket)} covering (${workflowFiles.join(', ')})`,
    };
  }
  if ((provenance.prPerformedViaAppSlug ?? '') !== APPROVE_TRUSTED_PUBLISHER_APP_SLUG) {
    return {
      approved: false,
      ticket,
      reason: `refusing: PR #${String(provenance.prNumber)} publisher is ${provenance.prPerformedViaAppSlug ?? '(missing)'}, expected ${APPROVE_TRUSTED_PUBLISHER_APP_SLUG} with a matching handoff marker`,
    };
  }
  const handoffHeadCheck = checkExactHeadEquality(
    provenance.runHeadSha,
    provenance.prHeadSha,
    ticket,
  );
  if (handoffHeadCheck !== null) {
    return handoffHeadCheck;
  }
  // Trust attaches to the original publication provenance + handoff marker;
  // the current HEAD is still gated exactly, so later exact-HEAD corrections
  // pushed through agent-fix-cycle/safe-push remain eligible.
  return {
    approved: true,
    ticket,
    reason: `approved: trusted handoff PR #${String(provenance.prNumber)} for issue #${String(ticket)} at exact HEAD ${provenance.prHeadSha}`,
  };
}

export function buildApproveRunArgs(repoSlug: string, runId: number): readonly string[] {
  return ['api', `repos/${repoSlug}/actions/runs/${String(runId)}/approve`, '--method', 'POST'];
}

export interface PolledAgentCiRun {
  runId: number;
  headSha: string;
  workflowName: string;
  prNumbers: number[];
}

// Scheduled fallback for ticket #47: GitHub does not emit a `workflow_run`
// event for the `action_required` CI run observed on PR #46 (run
// 34698820348), so the event-driven approver never runs for exactly the case
// it must handle. The trusted poll queries the narrow awaiting set for the
// `ci` workflow only. `--paginate` pages concatenate safely because `--jq`
// emits one line per run; the parser below never parses pages as one JSON
// object. The documented list-runs shape exposes `workflow_runs`, not `runs`.
export function buildPollRunsArgs(repoSlug: string): readonly string[] {
  return [
    'api',
    `repos/${repoSlug}/actions/workflows/ci.yml/runs?status=action_required&per_page=50`,
    '--paginate',
    '--jq',
    '.workflow_runs[] | "\\(.id) \\(.head_sha) \\(.name) \\([.pull_requests[].number] | map(tostring) | join(","))"',
  ];
}

export function parsePollRunsOutput(stdout: string): PolledAgentCiRun[] {
  const runs: PolledAgentCiRun[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length < 3 || parts.length > 4) {
      continue;
    }
    const [idText, headSha, workflowName, prCsv] = [
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts[3] ?? '',
    ];
    const runId = Number.parseInt(idText, 10);
    if (!Number.isInteger(runId) || runId <= 0) {
      continue;
    }
    if (!isExactSha(headSha)) {
      continue;
    }
    if (workflowName === '') {
      continue;
    }
    const prNumbers: number[] = [];
    let valid = true;
    if (prCsv !== '') {
      for (const entry of prCsv.split(',')) {
        const pr = Number.parseInt(entry, 10);
        if (!Number.isInteger(pr) || pr <= 0) {
          valid = false;
          break;
        }
        prNumbers.push(pr);
      }
    }
    if (!valid) {
      continue;
    }
    runs.push({ runId, headSha, workflowName, prNumbers });
  }
  return runs;
}

// Exact-HEAD workflow-run observation for ticket #47 corrected-HEAD
// regression (live #60/PR #68 evidence): a zero-job `action_required` ci run
// is visible through the Actions workflow-runs API but surfaces no commit
// check-run, so `fetchCommitCheckRuns()` returns `[]` and the review cycle
// never requests trusted approval. Querying the canonical `ci` workflow runs
// filtered by exact HEAD closes that blind spot. The payload shape follows the
// documented list-runs response (`workflow_runs`, not `runs`); `--jq` emits
// one line per run so `--paginate` pages concatenate safely.
export interface HeadWorkflowRun {
  runId: number;
  headSha: string;
  workflowName: string;
  status: string;
  conclusion: string | null;
}

export function buildHeadRunsArgs(repoSlug: string, headSha: string): readonly string[] {
  return [
    'api',
    `repos/${repoSlug}/actions/workflows/ci.yml/runs?head_sha=${headSha}&per_page=20`,
    '--paginate',
    '--jq',
    '.workflow_runs[] | "\\(.id) \\(.head_sha) \\(.name) \\(.status) \\(.conclusion // "null")"',
  ];
}

export function parseHeadRunsOutput(stdout: string): HeadWorkflowRun[] {
  const runs: HeadWorkflowRun[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') {
      continue;
    }
    const parts = trimmed.split(/\s+/);
    if (parts.length !== 5) {
      continue;
    }
    const [idText, headSha, workflowName, status, conclusionText] = [
      parts[0] ?? '',
      parts[1] ?? '',
      parts[2] ?? '',
      parts[3] ?? '',
      parts[4] ?? '',
    ];
    const runId = Number.parseInt(idText, 10);
    if (!Number.isInteger(runId) || runId <= 0) {
      continue;
    }
    if (!isExactSha(headSha)) {
      continue;
    }
    if (workflowName === '' || status === '') {
      continue;
    }
    runs.push({
      runId,
      headSha,
      workflowName,
      status,
      conclusion: conclusionText === 'null' || conclusionText === '' ? null : conclusionText,
    });
  }
  return runs;
}

export function hasApprovalWaitingWorkflowRuns(runs: readonly HeadWorkflowRun[]): boolean {
  return runs.some((run) => run.conclusion === APPROVE_REQUIRED_CONCLUSION);
}

export async function fetchHeadWorkflowRuns(
  repoSlug: string,
  headSha: string,
  execute: CommandExecutor = runCommand,
): Promise<HeadWorkflowRun[]> {
  const { stdout } = await execute('gh', buildHeadRunsArgs(repoSlug, headSha));
  return parseHeadRunsOutput(stdout);
}

// Narrow repository_dispatch event type for ticket #47 liveness. The
// originating `agent-ticket`/review-cycle flow emits this event immediately
// (it already holds `contents: write`, which is sufficient to create a
// repository dispatch) so the trusted approver wakes without waiting for the
// 10-minute scheduled backstop (ticket #82). The payload is only a hint: the trusted job must
// still fetch canonical GitHub state and rerun the deterministic
// provenance/exact-HEAD/no-workflow-change evaluator before any approval.
export const APPROVE_DISPATCH_EVENT = 'approve-agent-ci-request';

export interface ApprovalDispatchHint {
  pr: number;
  headSha: string;
  ticket?: number;
  runId?: number;
}

export interface ParsedDispatchHint {
  pr?: number;
  headSha?: string;
  ticket?: number;
  runId?: number;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === 'string' && /^[1-9]\d*$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }
  return undefined;
}

export function buildApprovalDispatchArgs(
  repoSlug: string,
  hint: ApprovalDispatchHint,
): readonly string[] {
  const args: string[] = [
    'api',
    `repos/${repoSlug}/dispatches`,
    '--method',
    'POST',
    '-F',
    `event_type=${APPROVE_DISPATCH_EVENT}`,
    '-F',
    `client_payload[pr]=${String(hint.pr)}`,
    '-F',
    `client_payload[head_sha]=${hint.headSha}`,
  ];
  if (hint.ticket !== undefined) {
    args.push('-F', `client_payload[ticket]=${String(hint.ticket)}`);
  }
  if (hint.runId !== undefined) {
    args.push('-F', `client_payload[run_id]=${String(hint.runId)}`);
  }
  return args;
}

// Fail-closed hint parsing for the trusted dispatch job: only validated
// fields survive; malformed payloads yield an empty hint so the job falls
// back to the full narrow awaiting set instead of trusting attacker-shaped
// data. Accepts the `client_payload` object (snake_case keys) directly.
export function parseDispatchHint(payload: unknown): ParsedDispatchHint {
  if (typeof payload !== 'object' || payload === null) {
    return {};
  }
  const record = payload as Record<string, unknown>;
  const hint: ParsedDispatchHint = {};
  const pr = parsePositiveInt(record.pr);
  if (pr !== undefined) {
    hint.pr = pr;
  }
  const ticket = parsePositiveInt(record.ticket);
  if (ticket !== undefined) {
    hint.ticket = ticket;
  }
  const runId = parsePositiveInt(record.run_id ?? record.runId);
  if (runId !== undefined) {
    hint.runId = runId;
  }
  const rawHead = record.head_sha ?? record.headSha;
  if (typeof rawHead === 'string' && isExactSha(rawHead)) {
    hint.headSha = rawHead.trim().toLowerCase();
  }
  return hint;
}

// Narrow the canonical awaiting set to the hinted PR/HEAD/run when the hint
// carries validated fields. An empty hint returns every candidate so a
// malformed hint can never suppress the scheduled backstop.
export function filterPolledRunsForHint(
  runs: readonly PolledAgentCiRun[],
  hint: ParsedDispatchHint,
): PolledAgentCiRun[] {
  return runs.filter((run) => {
    if (hint.runId !== undefined && run.runId !== hint.runId) {
      return false;
    }
    if (hint.pr !== undefined && !run.prNumbers.includes(hint.pr)) {
      return false;
    }
    if (hint.headSha !== undefined && run.headSha.toLowerCase() !== hint.headSha.toLowerCase()) {
      return false;
    }
    return true;
  });
}

// Immediate liveness signal for ticket #47: best-effort only. Callers swallow
// failures and keep polling, so a dispatch outage degrades to the scheduled
// 10-minute backstop (ticket #82) instead of failing the delivery flow.
export async function requestApprovalDispatch(
  execute: CommandExecutor,
  repoSlug: string,
  hint: ApprovalDispatchHint,
): Promise<void> {
  await execute('gh', buildApprovalDispatchArgs(repoSlug, hint));
}

export function buildPrFetchArgs(repoSlug: string, prNumber: number): readonly string[] {
  return ['api', `repos/${repoSlug}/pulls/${String(prNumber)}`];
}

export function buildIssueFetchArgs(repoSlug: string, issueNumber: number): readonly string[] {
  return ['api', `repos/${repoSlug}/issues/${String(issueNumber)}`];
}

// Ticket #82: the PR issue representation (`issues/{prNumber}`) proves
// publication provenance via `performed_via_github_app.slug`. It is a
// distinct object from the source ticket (`issues/{ticket}`) in GitHub's
// shared numbering namespace; querying the ticket number for publisher
// provenance is a coverage failure. Named distinctly so tests pin the
// correct variable.
export function buildPrIssueFetchArgs(repoSlug: string, prNumber: number): readonly string[] {
  return ['api', `repos/${repoSlug}/issues/${String(prNumber)}`];
}

// Ticket #82: handoff markers live in `github-actions[bot]` comments on the
// source ticket. The trusted approver reads metadata/comments only and never
// checks out or executes PR code. `--paginate --jq '.[] | ... | @json'`
// emits one compact JSON value per comment per page, so paginated pages
// concatenate safely (the same pattern as the poll-runs `--jq` line output).
// The parser below accepts those newline-delimited values (objects or
// `@json`-encoded strings) as well as a single API array for back-compat.
export function buildTicketCommentsArgs(repoSlug: string, ticket: number): readonly string[] {
  return [
    'api',
    `repos/${repoSlug}/issues/${String(ticket)}/comments`,
    '--paginate',
    '--jq',
    '.[] | {body: .body, user: {login: .user.login}} | @json',
  ];
}

export interface TicketCommentView {
  body: string;
  authorLogin: string;
}

function toTicketCommentView(entry: unknown): TicketCommentView | null {
  if (typeof entry === 'string') {
    // `@json` emits one JSON-encoded string per comment; unwrap it.
    try {
      const inner: unknown = JSON.parse(entry);
      if (typeof inner === 'object' && inner !== null && !Array.isArray(inner)) {
        return toTicketCommentView(inner);
      }
      return null;
    } catch {
      return null;
    }
  }
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    return null;
  }
  const record = entry as { body?: unknown; user?: { login?: unknown } };
  return {
    body: typeof record.body === 'string' ? record.body : '',
    authorLogin: typeof record.user?.login === 'string' ? record.user.login : '',
  };
}

function collectCommentEntries(value: unknown, views: TicketCommentView[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const view = toTicketCommentView(entry);
      if (view !== null) {
        views.push(view);
      }
    }
    return;
  }
  const view = toTicketCommentView(value);
  if (view !== null) {
    views.push(view);
  }
}

export function parseTicketCommentsOutput(stdout: string): TicketCommentView[] {
  const trimmed = stdout.trim();
  if (trimmed === '') {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    const views: TicketCommentView[] = [];
    collectCommentEntries(parsed, views);
    // A single parsed value handles one page/array/object. When `--paginate`
    // concatenates several single-line page arrays, the whole-stdout parse
    // fails and the line fallback below flattens each page array instead of
    // degrading to empty body/author records.
    if (
      views.length > 0 ||
      trimmed.startsWith('[') ||
      trimmed.startsWith('{') ||
      trimmed.startsWith('"')
    ) {
      return views;
    }
  } catch {
    // Fall through to newline-delimited values.
  }
  // Newline-delimited JSON values: one comment object (or `@json` string, or
  // single-line page array) per line. Page arrays flatten so a marker on a
  // later page is preserved.
  const views: TicketCommentView[] = [];
  for (const line of trimmed.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const entry: unknown = JSON.parse(line);
      collectCommentEntries(entry, views);
    } catch {
      continue;
    }
  }
  return views;
}

export function parsePrIssueAppSlug(stdout: string): string {
  try {
    const parsed = JSON.parse(stdout) as {
      performed_via_github_app?: { slug?: unknown } | null;
    };
    const slug = parsed.performed_via_github_app?.slug;
    return typeof slug === 'string' ? slug : '';
  } catch {
    return '';
  }
}

export function collectBotHandoffMarkers(
  comments: readonly TicketCommentView[],
): TrustedHandoffMarker[] {
  const markers: TrustedHandoffMarker[] = [];
  for (const comment of comments) {
    if (comment.authorLogin !== APPROVE_BOT_LOGIN) {
      continue;
    }
    const marker = parseTrustedHandoffMarker(comment.body);
    if (marker !== null) {
      markers.push(marker);
    }
  }
  return markers;
}

export function buildPrFilesArgs(repoSlug: string, prNumber: number): readonly string[] {
  return [
    'api',
    `repos/${repoSlug}/pulls/${String(prNumber)}/files`,
    '--paginate',
    '--jq',
    '.[].filename',
  ];
}

interface RestPullRequest {
  state?: unknown;
  title?: unknown;
  body?: unknown;
  user?: { login?: unknown };
  base?: { ref?: unknown; repo?: { full_name?: unknown } };
  head?: { ref?: unknown; sha?: unknown; repo?: { full_name?: unknown } };
}

interface RestIssue {
  state?: unknown;
  labels?: unknown;
  number?: unknown;
}

function parsePrResponse(stdout: string): RestPullRequest {
  return JSON.parse(stdout) as RestPullRequest;
}

function stringField(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function parseIssueLabels(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const labels: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') {
      labels.push(entry);
    } else if (
      typeof entry === 'object' &&
      entry !== null &&
      'name' in entry &&
      typeof (entry as { name?: unknown }).name === 'string'
    ) {
      labels.push((entry as { name: string }).name);
    }
  }
  return labels;
}

function parseFilenamesOutput(stdout: string): string[] {
  const files: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      files.push(trimmed);
    }
  }
  return files;
}

export interface WorkflowRunApprovalInput {
  repoSlug: string;
  runId: number;
  workflowName: string;
  runConclusion: string | null;
  runHeadSha: string;
  pullRequestNumbers: readonly number[];
}

// Repository-owned evaluation for the trusted approver workflow: every guard
// is proven from GitHub-owned API reads through the injected executor. Any
// fetch or parse failure refuses closed with evidence instead of guessing.
export async function evaluateAgentCiApproval(
  execute: CommandExecutor,
  input: WorkflowRunApprovalInput,
): Promise<AgentCiDecision> {
  if (input.workflowName !== APPROVE_TRUSTED_WORKFLOW_NAME) {
    return {
      approved: false,
      reason: `refusing: triggering workflow is ${input.workflowName || '(missing)'}, expected ${APPROVE_TRUSTED_WORKFLOW_NAME}`,
    };
  }
  if (input.runConclusion !== APPROVE_REQUIRED_CONCLUSION) {
    return {
      approved: false,
      reason: `refusing: run conclusion is ${input.runConclusion ?? '(missing)'}, expected ${APPROVE_REQUIRED_CONCLUSION}`,
    };
  }
  if (input.pullRequestNumbers.length !== 1 || input.pullRequestNumbers[0] === undefined) {
    return {
      approved: false,
      reason: `refusing: expected exactly one associated PR, got ${String(input.pullRequestNumbers.length)}`,
    };
  }
  const prNumber = input.pullRequestNumbers[0];

  let pr: RestPullRequest;
  try {
    const { stdout } = await execute('gh', buildPrFetchArgs(input.repoSlug, prNumber));
    pr = parsePrResponse(stdout);
  } catch (error) {
    return {
      approved: false,
      reason: `refusing: cannot prove PR provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const prHeadRef = stringField(pr.head?.ref);
  const ticket = parseTicketBranch(prHeadRef);
  if (ticket === null) {
    return {
      approved: false,
      reason: `refusing: PR head branch ${prHeadRef || '(missing)'} does not match the ticket/<number>-... convention`,
    };
  }

  let issue: RestIssue;
  let issueIsPullRequest: boolean;
  try {
    const { stdout } = await execute('gh', buildIssueFetchArgs(input.repoSlug, ticket));
    const parsed = JSON.parse(stdout) as RestIssue & { pull_request?: unknown };
    issue = parsed;
    issueIsPullRequest = parsed.pull_request !== undefined;
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove issue provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let changedFiles: string[];
  try {
    const { stdout } = await execute('gh', buildPrFilesArgs(input.repoSlug, prNumber));
    changedFiles = parseFilenamesOutput(stdout);
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove the PR is free of workflow files: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const prAuthorLogin = typeof pr.user?.login === 'string' ? pr.user.login : '';
  // Bot PRs keep the existing path without extra reads. Non-bot PRs may
  // qualify only through the #82 trusted-handoff exception, which requires
  // the PR issue publisher provenance plus a matching bot marker on the
  // source ticket. Fetches below fail closed.
  if (prAuthorLogin === APPROVE_BOT_LOGIN) {
    return decideAgentCiApproval({
      workflowName: input.workflowName,
      runConclusion: input.runConclusion,
      associatedPrCount: input.pullRequestNumbers.length,
      prNumber,
      prState: stringField(pr.state),
      prBaseRef: stringField(pr.base?.ref),
      prHeadRef,
      prHeadSha: stringField(pr.head?.sha),
      prAuthorLogin,
      prHeadRepo: stringField(pr.head?.repo?.full_name),
      prBaseRepo: stringField(pr.base?.repo?.full_name),
      prTitle: stringField(pr.title),
      prBody: pr.body === null || pr.body === undefined ? '' : stringField(pr.body),
      runHeadSha: input.runHeadSha,
      issueNumber: typeof issue.number === 'number' ? issue.number : ticket,
      issueState: stringField(issue.state),
      issueLabels: parseIssueLabels(issue.labels),
      issueIsPullRequest,
      changedFiles,
    });
  }

  let prPerformedViaAppSlug: string;
  try {
    const { stdout } = await execute('gh', buildPrIssueFetchArgs(input.repoSlug, prNumber));
    prPerformedViaAppSlug = parsePrIssueAppSlug(stdout);
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove PR publication provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  let handoffMarkers: TrustedHandoffMarker[];
  try {
    const { stdout } = await execute('gh', buildTicketCommentsArgs(input.repoSlug, ticket));
    handoffMarkers = collectBotHandoffMarkers(parseTicketCommentsOutput(stdout));
  } catch (error) {
    return {
      approved: false,
      ticket,
      reason: `refusing: cannot prove trusted handoff provenance: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  return decideAgentCiApproval({
    workflowName: input.workflowName,
    runConclusion: input.runConclusion,
    associatedPrCount: input.pullRequestNumbers.length,
    prNumber,
    prState: stringField(pr.state),
    prBaseRef: stringField(pr.base?.ref),
    prHeadRef,
    prHeadSha: stringField(pr.head?.sha),
    prAuthorLogin,
    prHeadRepo: stringField(pr.head?.repo?.full_name),
    prBaseRepo: stringField(pr.base?.repo?.full_name),
    prTitle: stringField(pr.title),
    prBody: pr.body === null || pr.body === undefined ? '' : stringField(pr.body),
    runHeadSha: input.runHeadSha,
    issueNumber: typeof issue.number === 'number' ? issue.number : ticket,
    issueState: stringField(issue.state),
    issueLabels: parseIssueLabels(issue.labels),
    issueIsPullRequest,
    changedFiles,
    prPerformedViaAppSlug,
    handoffMarkers,
  });
}

export async function approveWorkflowRun(
  execute: CommandExecutor,
  repoSlug: string,
  runId: number,
): Promise<void> {
  await execute('gh', buildApproveRunArgs(repoSlug, runId));
}
