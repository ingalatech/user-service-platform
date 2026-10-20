// Bounded local implementation recovery evidence (ticket #127).
//
// When an `/implement` worker times out or fails, the failed ticket branch
// may hold unpublished authored changes. This module captures a small,
// secret-safe, portable recovery record from the actual failed worktree state
// so an operator can inspect the local outcome record and reapply eligible
// source changes on a fresh isolated worktree without rerunning implementation
// blindly.
//
// Safety invariants (all tested):
// - explicit path allowlist for source/docs/non-secret build config;
// - path-based exclusion of nested `.env`/`.dev.vars` variants, logs,
//   runtime state, credentials/key files, build outputs, evidence dirs,
//   workflow files (trusted-publication boundary) and outside-worktree paths;
// - symlinks are never followed;
// - diagnostics carry only allowlisted event/tool names, counts, timestamps,
//   last-known status and the additive bounded structured `errors` summary
//   (exact permitted protocol names, validated APIError status/retryability)
//   — never prompts, reasoning, text, inputs, outputs, shell commands,
//   payloads, recipients, credentials, tokens, raw error messages, stacks,
//   headers/bodies, metadata/cause or provider identifiers;
// - all snapshots are bounded (paths, per-file bytes, total bytes); bound
//   exhaustion and command/filesystem failures report honest
//   incomplete/unavailable status and never replace the original
//   TIMEOUT/BLOCKED result;
// - capture performs only read-only Git/filesystem operations: it never
//   stages, commits, resets, cleans, pushes, opens a PR, merges or deploys.

import * as fs from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { CommandExecutor } from './runner.js';
import { listWorkflowFiles, parseNameOnlyOutput } from './workflow-handoff.js';

export const RECOVERY_VERSION = 1 as const;

// Bounded snapshot limits so the record stays in the local
// `.agent-ticket/outcome.json` outcome file without workflow-file edits.
// `*_BYTES` bounds are enforced as UTF-8 bytes: truncation never splits a
// character (surrogate pair or multi-byte sequence).
export const RECOVERY_MAX_FILES = 50;
export const RECOVERY_MAX_BYTES_PER_FILE = 32 * 1024;
export const RECOVERY_MAX_TOTAL_BYTES = 256 * 1024;
export const RECOVERY_MAX_PATH_LENGTH = 256;

// Bounded read-only Git/filesystem capture so a hung command or stalled read
// becomes an honest unavailable/incomplete record instead of hanging terminal
// reporting.
export const RECOVERY_COMMAND_TIMEOUT_MS = 30_000;
// Finite deadline for a single untracked-file read: a stalled filesystem
// must degrade to an unreadable-file reason, never hang the capture.
export const RECOVERY_FILE_READ_TIMEOUT_MS = 10_000;
// Finite deadline for the whole recovery capture: exceeding it returns honest
// incomplete/unavailable metadata and preserves the original TIMEOUT/BLOCKED.
export const RECOVERY_CAPTURE_TIMEOUT_MS = 60_000;

export type RecoveryStatus = 'complete' | 'incomplete' | 'unavailable';

export interface RecoveryCounts {
  committed: number;
  uncommitted: number;
  untracked: number;
  included: number;
  excluded: number;
}

export interface RecoveryUntrackedFile {
  path: string;
  content: string;
}

export interface RecoveryDiagnostics {
  totalLines: number;
  eventCounts: Record<string, number>;
  toolCounts: Record<string, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  durationMs: number | null;
  lastStatus: string | null;
  malformed: number;
  unknownEvents: number;
  status: RecoveryStatus;
  reasons: string[];
  /**
   * Additive bounded structured-error summary (ticket #138). Older persisted
   * records may lack it; new summaries always set it. Counts only, never raw
   * names outside the whitelist, messages, stacks, headers, bodies,
   * metadata, provider identifiers, prompts, reasoning, tool I/O, commands,
   * recipient data or credentials.
   */
  errors?: WorkerErrorSummary;
}

export interface ImplementationRecoveryRecord {
  version: typeof RECOVERY_VERSION;
  base: string;
  head: string;
  branch: string;
  status: RecoveryStatus;
  reasons: string[];
  counts: RecoveryCounts;
  workflowFiles: string[];
  truncated: boolean;
  combinedPatch: string;
  patchTruncated: boolean;
  untrackedFiles: RecoveryUntrackedFile[];
  untrackedTruncated: boolean;
  diagnostics: RecoveryDiagnostics;
  createdAt: string;
}

const ALLOWED_DIR_PREFIXES = ['src/', 'scripts/', 'test/', 'docs/', 'drizzle/', 'deploy/'];

const ALLOWED_TOP_LEVEL_FILES = new Set([
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'wrangler.jsonc',
  'drizzle.config.ts',
  'vitest.config.ts',
  'vitest.harness.config.ts',
  'eslint.config.mjs',
  '.prettierrc.json',
  '.prettierignore',
  '.editorconfig',
  '.nvmrc',
  // `.npmrc` is deliberately absent: a worker-modified copy commonly carries
  // `_authToken` lines that must never enter the local outcome record.
  'README.md',
  'AGENTS.md',
  'GLOSSARY.md',
  'skills-lock.json',
  // No dotenv-shaped file is admitted, including `.env.example`: a failed
  // worker's modified copy may carry secret values, so the committed template
  // being non-secret does not make the worktree copy safe for the local
  // outcome record. `isDeniedBasename` denies all `.env*` variants by path.
]);

const ALLOWED_EXTENSIONS = new Set([
  '.ts',
  '.mts',
  '.cts',
  '.tsx',
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.json',
  '.jsonc',
  '.md',
  '.sql',
  '.css',
]);

const DENIED_DIR_SEGMENTS = new Set([
  'node_modules',
  'dist',
  'coverage',
  '.wrangler',
  '.git',
  '.review-cycle',
  '.agent-ticket',
  '.github',
  '.opencode',
  '.agents',
]);

const DENIED_EXTENSIONS = new Set([
  '.log',
  '.sqlite',
  '.sqlite3',
  '.db',
  '.pem',
  '.key',
  '.p12',
  '.pfx',
  '.jks',
]);

function normalizeRecoveryPath(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.length > RECOVERY_MAX_PATH_LENGTH) {
    return null;
  }
  if (trimmed.includes('\0')) {
    return null;
  }
  const forward = trimmed.replace(/\\/g, '/');
  let relativePath = forward;
  while (relativePath.startsWith('./')) {
    relativePath = relativePath.slice(2);
  }
  if (relativePath === '' || relativePath.startsWith('/') || /^[A-Za-z]:\//.test(relativePath)) {
    return null;
  }
  const segments = relativePath.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return null;
  }
  return relativePath;
}

function basenameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index >= 0 ? path.slice(index + 1) : path;
}

function extensionOf(basename: string): string {
  const index = basename.lastIndexOf('.');
  return index > 0 ? basename.slice(index).toLowerCase() : '';
}

function isDeniedBasename(basename: string): boolean {
  const lower = basename.toLowerCase();
  if (lower === '.env' || lower.startsWith('.env.')) {
    return true;
  }
  if (lower === '.dev.vars' || lower.startsWith('.dev.vars.')) {
    return true;
  }
  if (lower === '.ds_store' || lower.endsWith('.log')) {
    return true;
  }
  // `.npmrc` commonly carries `_authToken` lines once a worker modifies it, so
  // it is denied by name (not merely by allowlist absence) at every segment.
  if (lower === '.npmrc') {
    return true;
  }
  return false;
}

// Explicit allowlist seam: only known source/docs/non-secret build-config
// paths are eligible for recovery. Everything else — including nested
// `.env`/`.dev.vars` variants, logs, runtime state, credentials/key files,
// build outputs, evidence dirs, workflow files and outside-worktree paths —
// is excluded by path, never by inspecting secret values.
export function isEligibleRecoveryPath(raw: unknown): boolean {
  const path = normalizeRecoveryPath(raw);
  if (path === null) {
    return false;
  }
  // Deny rules apply to every segment, not just the basename: a directory
  // itself named `.env`, `.dev.vars`, `debug.log` or `key.pem` must not admit
  // its children, or `src/.env/foo.ts` would carry secret-named state into the
  // local outcome record.
  const segments = path.split('/');
  for (const segment of segments) {
    if (DENIED_DIR_SEGMENTS.has(segment.toLowerCase())) {
      return false;
    }
    if (isDeniedBasename(segment)) {
      return false;
    }
    if (DENIED_EXTENSIONS.has(extensionOf(segment))) {
      return false;
    }
  }
  // The committed `.env.example` template stays denied like every other
  // `.env*` variant: a worker-modified copy may carry secret values.
  if (ALLOWED_TOP_LEVEL_FILES.has(path)) {
    return true;
  }
  if (path.includes('/')) {
    const hasAllowedPrefix = ALLOWED_DIR_PREFIXES.some((prefix) => path.startsWith(prefix));
    if (!hasAllowedPrefix) {
      return false;
    }
    return ALLOWED_EXTENSIONS.has(extensionOf(basenameOf(path)));
  }
  return false;
}

// Disk-level guard: even an allowlisted relative path is ineligible when it
// resolves outside the worktree, traverses a symlinked directory, or is
// itself a symlink (never followed).
export async function isEligibleRecoveryFile(
  absolutePath: string,
  worktreeRoot: string,
): Promise<boolean> {
  const root = resolve(worktreeRoot);
  const target = resolve(absolutePath);
  const relativePath = relative(root, target);
  if (
    relativePath === '' ||
    relativePath.startsWith('..') ||
    target !== joinRoot(root, relativePath)
  ) {
    return false;
  }
  if (!isEligibleRecoveryPath(relativePath.split(sep).join('/'))) {
    return false;
  }
  // An intermediate symlinked directory would otherwise be followed by
  // `readFile`: resolve the real parent and require it to stay inside the
  // worktree (inputs from `git status` never descend symlinked dirs, but the
  // exported seam must not overstate its guarantee).
  try {
    const realRoot = await fs.realpath(root);
    const realParent = await fs.realpath(dirname(target));
    const parentRel = relative(realRoot, realParent);
    if (parentRel.startsWith('..') || resolve(realRoot, parentRel) !== realParent) {
      return false;
    }
  } catch {
    return false;
  }
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(target);
  } catch {
    return false;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return false;
  }
  return true;
}

function joinRoot(root: string, relativePath: string): string {
  return resolve(root, relativePath);
}

// UTF-8 byte-budget slicing without splitting a character: iterate by code
// point and stop before exceeding `maxBytes`, so surrogate pairs and
// multi-byte sequences stay intact and `Buffer.byteLength` of the result is
// always within budget.
export function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function sliceByUtf8Bytes(value: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }
  let bytes = 0;
  let end = 0;
  for (const char of value) {
    const charBytes = Buffer.byteLength(char, 'utf8');
    if (bytes + charBytes > maxBytes) {
      break;
    }
    bytes += charBytes;
    end += char.length;
  }
  return value.slice(0, end);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`timed out after ${String(timeoutMs)}ms`));
    }, timeoutMs);
    if (typeof (timer as unknown as { unref?: unknown }).unref === 'function') {
      (timer as unknown as { unref: () => void }).unref();
    }
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  });
}

// Decode at most `maxBytes` of `buffer` as UTF-8 without splitting the final
// character: trim trailing bytes that form an incomplete sequence, then
// decode. The result never contains a split-character replacement.
function decodeUtf8AtBoundary(buffer: Buffer, maxBytes: number): string {
  const slice = buffer.subarray(0, Math.min(buffer.length, maxBytes));
  let end = slice.length;
  let continuation = 0;
  for (let i = end - 1; i >= 0; i -= 1) {
    const byte: number = slice[i] ?? 0;
    if ((byte & 0xc0) !== 0x80) {
      const lead: number = slice[i] ?? 0;
      let need = 1;
      if ((lead & 0x80) === 0) {
        need = 1;
      } else if ((lead & 0xe0) === 0xc0) {
        need = 2;
      } else if ((lead & 0xf0) === 0xe0) {
        need = 3;
      } else if ((lead & 0xf8) === 0xf0) {
        need = 4;
      }
      if (continuation + 1 < need) {
        end = i;
      }
      break;
    }
    continuation += 1;
  }
  return slice.subarray(0, end).toString('utf8');
}

// Bounded file read: opens the file and reads at most `maxBytes + 1` bytes so
// a huge file never loads fully into memory. Returns the decoded content
// (at most `maxBytes` UTF-8 bytes) plus whether the file was truncated.
async function readBoundedTextFile(
  path: string,
  maxBytes: number,
): Promise<{ content: string; truncated: boolean }> {
  const handle = await fs.open(path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new Error('not a file');
    }
    const toRead = Math.min(stat.size, maxBytes + 1);
    const buffer = Buffer.alloc(Math.max(0, toRead));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const slice = buffer.subarray(0, bytesRead);
    const truncated = stat.size > maxBytes || bytesRead > maxBytes;
    if (!truncated) {
      return { content: slice.toString('utf8'), truncated: false };
    }
    return { content: decodeUtf8AtBoundary(slice, maxBytes), truncated: true };
  } finally {
    await handle.close();
  }
}

const RECOVERY_EVENT_ALLOWLIST = new Set([
  'tool_use',
  'text',
  'reasoning',
  'step_start',
  'step_finish',
  'error',
]);

const RECOVERY_TOOL_ALLOWLIST = new Set([
  'read',
  'edit',
  'write',
  'bash',
  'grep',
  'glob',
  'task',
  'skill',
  'todo',
  'list',
  'diff',
]);

const RECOVERY_STATUS_ALLOWLIST = new Set(['completed', 'error', 'pending']);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

// Pinned OpenCode 1.18.30 protocol error names (parent spec #137). These are
// reported protocol types, not confirmed root causes. Any missing or
// unsupported name maps to the fixed `unknown` bucket; raw names never become
// keys or free text.
export const WORKER_ERROR_NAMES = [
  'APIError',
  'ProviderAuthError',
  'MessageOutputLengthError',
  'MessageAbortedError',
  'StructuredOutputError',
  'ContextOverflowError',
  'ContentFilterError',
  'UnknownError',
] as const;

export type WorkerErrorName = (typeof WORKER_ERROR_NAMES)[number];

export type WorkerErrorBucket = WorkerErrorName | 'unknown';

const WORKER_ERROR_NAME_SET: ReadonlySet<string> = new Set(WORKER_ERROR_NAMES);

// Bounded structured-error summary (ticket #138). Counts only, in the current
// captured prefix. For recognized APIError only, validated HTTP status counts
// (finite integer 100..599, keyed by its decimal string) and literal boolean
// retryability are retained. Missing/invalid status/retryability stays
// explicitly unknown/unclassified via absence from `apiStatusCounts` and via
// `apiRetryableUnknown`. No coercion: strings, fractional, out-of-range and
// non-finite numbers are never copied. Reported retryability has no execution
// authority.
export interface WorkerErrorSummary {
  total: number;
  byName: Partial<Record<WorkerErrorBucket, number>>;
  apiStatusCounts: Record<string, number>;
  apiRetryableTrue: number;
  apiRetryableFalse: number;
  apiRetryableUnknown: number;
}

export function emptyWorkerErrorSummary(): WorkerErrorSummary {
  return {
    total: 0,
    byName: {},
    apiStatusCounts: {},
    apiRetryableTrue: 0,
    apiRetryableFalse: 0,
    apiRetryableUnknown: 0,
  };
}

function isValidHttpStatus(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    Number.isFinite(value) &&
    value >= 100 &&
    value <= 599
  );
}

// Single shared safe projection for implementation recovery and finalized
// skill evidence. Inspects top-level `error` events in the captured prefix
// only. Reads exactly `error.name`, `error.data.statusCode` and
// `error.data.isRetryable`; every other field (messages, stacks,
// headers/bodies, nested causes/metadata, provider identifiers, prompts,
// reasoning, tool input/output, commands, recipient data, credentials) is
// never read into the summary.
export function summarizeWorkerErrors(lines: readonly string[]): WorkerErrorSummary {
  const summary = emptyWorkerErrorSummary();
  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.type !== 'error') {
      continue;
    }
    summary.total += 1;
    const errorObj = asRecord(record.error);
    const rawName = errorObj?.name;
    const bucket: WorkerErrorBucket =
      typeof rawName === 'string' && WORKER_ERROR_NAME_SET.has(rawName)
        ? (rawName as WorkerErrorBucket)
        : 'unknown';
    summary.byName[bucket] = (summary.byName[bucket] ?? 0) + 1;
    if (bucket !== 'APIError') {
      continue;
    }
    const dataObj = asRecord(errorObj?.data);
    const statusRaw = dataObj?.statusCode;
    if (isValidHttpStatus(statusRaw)) {
      const key = String(statusRaw);
      summary.apiStatusCounts[key] = (summary.apiStatusCounts[key] ?? 0) + 1;
    }
    const retryRaw = dataObj?.isRetryable;
    if (retryRaw === true) {
      summary.apiRetryableTrue += 1;
    } else if (retryRaw === false) {
      summary.apiRetryableFalse += 1;
    } else {
      summary.apiRetryableUnknown += 1;
    }
  }
  return summary;
}

// Safe lifecycle metadata: allowlisted event/tool names, counts, bounded
// timestamps and last-known status only. Raw prompts, reasoning, text,
// inputs, outputs, shell commands, payloads, recipients, credentials and
// tokens are never read into the record.
export function summarizeWorkerLifecycle(lines: readonly string[]): RecoveryDiagnostics {
  const eventCounts: Record<string, number> = {};
  const toolCounts: Record<string, number> = {};
  let malformed = 0;
  let unknownEvents = 0;
  let invalidTimestamps = 0;
  const reasons: string[] = [];
  let firstTimestamp: number | null = null;
  let lastTimestamp: number | null = null;
  let lastStatus: string | null = null;

  for (const line of lines) {
    if (line.trim() === '') {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line) as unknown;
    } catch {
      malformed += 1;
      continue;
    }
    const record = asRecord(parsed);
    const type = record === null ? null : asNonEmptyString(record.type);
    if (type === null || !RECOVERY_EVENT_ALLOWLIST.has(type)) {
      unknownEvents += 1;
      continue;
    }
    eventCounts[type] = (eventCounts[type] ?? 0) + 1;
    const timestamp = record?.timestamp;
    if (typeof timestamp === 'number' && Number.isFinite(timestamp)) {
      // A finite number outside Date's valid range (e.g. 1e100) must not
      // contaminate the shared extrema: validate before accumulation so a
      // later valid timestamp is retained and the invalid input is disclosed.
      if (Number.isFinite(new Date(timestamp).getTime())) {
        if (firstTimestamp === null || timestamp < firstTimestamp) {
          firstTimestamp = timestamp;
        }
        if (lastTimestamp === null || timestamp > lastTimestamp) {
          lastTimestamp = timestamp;
        }
      } else {
        invalidTimestamps += 1;
      }
    }
    if (type === 'tool_use') {
      const part = asRecord(record?.part);
      const tool = part === null ? null : asNonEmptyString(part.tool);
      if (tool !== null && RECOVERY_TOOL_ALLOWLIST.has(tool)) {
        toolCounts[tool] = (toolCounts[tool] ?? 0) + 1;
      } else {
        unknownEvents += 1;
      }
      const state = part === null ? null : asRecord(part.state);
      const status = state === null ? null : asNonEmptyString(state.status);
      if (status !== null && RECOVERY_STATUS_ALLOWLIST.has(status)) {
        lastStatus = status;
      }
    }
  }

  if (malformed > 0) {
    reasons.push(`ignored ${String(malformed)} malformed worker records`);
  }
  if (unknownEvents > 0) {
    reasons.push(`ignored ${String(unknownEvents)} unknown worker events`);
  }
  if (invalidTimestamps > 0) {
    reasons.push(`ignored ${String(invalidTimestamps)} invalid worker timestamps`);
  }

  const toIso = (value: number | null): string | null => {
    if (value === null) {
      return null;
    }
    try {
      return new Date(value).toISOString();
    } catch {
      return null;
    }
  };

  const status: RecoveryStatus =
    lines.length === 0 ? 'unavailable' : reasons.length > 0 ? 'incomplete' : 'complete';
  if (lines.length === 0) {
    reasons.push('no worker events captured');
  }

  return {
    totalLines: lines.length,
    eventCounts,
    toolCounts,
    firstTimestamp: toIso(firstTimestamp),
    lastTimestamp: toIso(lastTimestamp),
    durationMs:
      firstTimestamp !== null && lastTimestamp !== null ? lastTimestamp - firstTimestamp : null,
    lastStatus,
    malformed,
    unknownEvents,
    status,
    reasons,
    errors: summarizeWorkerErrors(lines),
  };
}

// Fixed safe console/status surface: presence, completeness and counts only.
// Patch content and file contents never appear here; they stay in the
// local outcome record for operator inspection.
export function formatRecoverySummary(record: ImplementationRecoveryRecord): string {
  const present =
    record.combinedPatch !== '' || record.untrackedFiles.length > 0 ? 'present' : 'absent';
  return (
    `implementation recovery ${present} (${record.status}): ` +
    `${String(record.counts.included)} included ` +
    `(${String(record.counts.committed)} committed, ` +
    `${String(record.counts.uncommitted)} uncommitted, ` +
    `${String(record.counts.untracked)} untracked), ` +
    `${String(record.counts.excluded)} excluded` +
    (record.workflowFiles.length > 0 ? ', workflow changes require trusted handoff' : '') +
    (record.truncated ? ', truncated' : '')
  );
}

export function emptyRecoveryCounts(): RecoveryCounts {
  return { committed: 0, uncommitted: 0, untracked: 0, included: 0, excluded: 0 };
}

export function createUnavailableRecovery(input: {
  base: string;
  branch: string;
  head?: string;
  reasons: string[];
  diagnostics: RecoveryDiagnostics;
}): ImplementationRecoveryRecord {
  return {
    version: RECOVERY_VERSION,
    base: input.base,
    head: input.head ?? '(unknown)',
    branch: input.branch,
    status: 'unavailable',
    reasons: [...input.reasons],
    counts: emptyRecoveryCounts(),
    workflowFiles: [],
    truncated: false,
    combinedPatch: '',
    patchTruncated: false,
    untrackedFiles: [],
    untrackedTruncated: false,
    diagnostics: input.diagnostics,
    createdAt: new Date().toISOString(),
  };
}

const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

function isExactSha(value: string): boolean {
  return EXACT_SHA_PATTERN.test(value.trim());
}

export interface RecoveryStatusLists {
  tracked: string[];
  untracked: string[];
}

// Minimal `git status --porcelain` parsing for recovery triage: tracked
// edits/deletions/renames versus `??` untracked additions. Rename entries
// keep both the old and the new path so the deletion is not silently dropped
// from the portable snapshot; C-quoted paths are decoded (octal UTF-8 bytes
// plus standard escapes) so eligible non-ASCII source stays eligible instead
// of silently dropping through the allowlist.
export function parseRecoveryStatus(stdout: string): RecoveryStatusLists {
  const tracked: string[] = [];
  const untracked: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine.trim() === '') {
      continue;
    }
    if (rawLine.startsWith('??')) {
      const path = unwrapStatusPath(rawLine.slice(2).trim());
      if (path !== '') {
        untracked.push(path);
      }
      continue;
    }
    if (rawLine.length < 4) {
      continue;
    }
    const rest = rawLine.slice(3);
    const arrow = rest.lastIndexOf(' -> ');
    if (arrow >= 0) {
      const oldPath = unwrapStatusPath(rest.slice(0, arrow).trim());
      const newPath = unwrapStatusPath(rest.slice(arrow + 4).trim());
      if (oldPath !== '') {
        tracked.push(oldPath);
      }
      if (newPath !== '') {
        tracked.push(newPath);
      }
      continue;
    }
    const path = unwrapStatusPath(rest.trim());
    if (path !== '') {
      tracked.push(path);
    }
  }
  return { tracked, untracked };
}

function unwrapStatusPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeGitQuotedPath(trimmed.slice(1, -1));
  }
  return trimmed;
}

// Decode a git C-quoted path body (surrounding quotes already stripped):
// octal escapes carry UTF-8 bytes for non-ASCII paths when core.quotepath is
// on, plus the standard `\"`, `\\`, `\n`, `\t` escapes. Decoding keeps
// eligible source eligible; on undecodable input the raw body is returned so
// the allowlist still excludes it by path (counted as excluded) rather than
// silently disappearing from triage counts.
function decodeGitQuotedPath(body: string): string {
  const bytes: number[] = [];
  let text = '';
  const flushBytes = (): void => {
    if (bytes.length > 0) {
      text += Buffer.from(bytes).toString('utf8');
      bytes.length = 0;
    }
  };
  for (let i = 0; i < body.length; i += 1) {
    const char: string = body[i] ?? '';
    if (char !== '\\' || i + 1 >= body.length) {
      flushBytes();
      text += char;
      continue;
    }
    const next: string = body[i + 1] ?? '';
    if (next === 'n') {
      flushBytes();
      text += '\n';
      i += 1;
      continue;
    }
    if (next === 't') {
      flushBytes();
      text += '\t';
      i += 1;
      continue;
    }
    if (next === '"' || next === '\\') {
      bytes.push(next.charCodeAt(0));
      i += 1;
      continue;
    }
    const octal = body.slice(i + 1, i + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
      continue;
    }
    // Not a recognized escape: keep the backslash literally so the path still
    // flows through allowlist exclusion rather than vanishing.
    flushBytes();
    text += char;
  }
  flushBytes();
  return text;
}

function listRecoveryWorkflowFiles(paths: readonly string[]): string[] {
  return listWorkflowFiles(paths).slice(0, 20);
}

function uniquePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map((path) => path.trim()).filter((path) => path !== ''))].sort();
}

export interface RecoveryCaptureInput {
  base: string;
  branch: string;
  lines: readonly string[];
  worktreeRoot?: string;
}

export interface RecoveryCaptureDeps {
  execute?: CommandExecutor;
  readFile?: (path: string) => Promise<string>;
  now?: () => string;
  // Test/operator overrides for finite deadlines (defaults are the exported
  // `RECOVERY_*_TIMEOUT_MS` constants). Short overrides keep stalled-read and
  // capture-deadline tests fast without weakening production bounds.
  readTimeoutMs?: number;
  captureTimeoutMs?: number;
}

// Portable bounded snapshot of the actual failed worktree state. Read-only
// Git/filesystem operations only: the caller invokes this after bounded worker
// termination has been established (see `runWorkerStream` termination
// handshake for both timeout and non-timeout implement failures). When
// termination is unconfirmed the caller retains unavailable evidence without
// invoking this snapshot. Every failure degrades to honest
// incomplete/unavailable metadata and never throws, so the original
// TIMEOUT/BLOCKED result is always preserved.
export async function captureImplementationRecovery(
  input: RecoveryCaptureInput,
  deps: RecoveryCaptureDeps = {},
): Promise<ImplementationRecoveryRecord> {
  const diagnostics = summarizeWorkerLifecycle(input.lines);
  const captureTimeoutMs = deps.captureTimeoutMs ?? RECOVERY_CAPTURE_TIMEOUT_MS;
  try {
    return await withTimeout(
      doCaptureImplementationRecovery(input, deps, diagnostics),
      captureTimeoutMs,
    );
  } catch {
    return {
      ...createUnavailableRecovery({
        base: input.base,
        branch: input.branch,
        reasons: ['recovery capture timed out before completion'],
        diagnostics,
      }),
      createdAt: (deps.now ?? (() => new Date().toISOString()))(),
    };
  }
}

async function doCaptureImplementationRecovery(
  input: RecoveryCaptureInput,
  deps: RecoveryCaptureDeps,
  diagnostics: RecoveryDiagnostics,
): Promise<ImplementationRecoveryRecord> {
  const reasons: string[] = [];
  const now = deps.now ?? (() => new Date().toISOString());
  const execute = deps.execute;
  const injectedRead = deps.readFile;
  const readTimeoutMs = deps.readTimeoutMs ?? RECOVERY_FILE_READ_TIMEOUT_MS;
  const worktreeRoot = input.worktreeRoot ?? process.cwd();

  if (execute === undefined) {
    return {
      ...createUnavailableRecovery({
        base: input.base,
        branch: input.branch,
        reasons: ['recovery executor unavailable'],
        diagnostics,
      }),
      createdAt: now(),
    };
  }

  let actualHead = '(unknown)';
  try {
    const { stdout } = await execute('git', ['rev-parse', 'HEAD']);
    const head = stdout.trim();
    if (isExactSha(head)) {
      actualHead = head;
    } else {
      reasons.push('actual HEAD unavailable');
    }
  } catch {
    reasons.push('actual HEAD unavailable');
  }

  let branch = input.branch;
  try {
    const { stdout } = await execute('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
    const current = stdout.trim();
    if (current !== '') {
      branch = current;
    }
  } catch {
    reasons.push('branch name unavailable; using ticket branch');
  }

  const base = input.base.trim();
  const baseValid = isExactSha(base);
  const headValid = isExactSha(actualHead);
  if (!baseValid) {
    reasons.push('recorded base unavailable');
  }

  let committedNames: string[] = [];
  if (baseValid && headValid) {
    try {
      const { stdout } = await execute('git', [
        'diff',
        '--name-only',
        '--no-renames',
        `${base}..${actualHead}`,
        '--',
      ]);
      // `git diff --name-only` C-quotes non-ASCII paths like status does;
      // decode through the same helper so eligible source stays eligible.
      // `--no-renames` lists both sides of a pure rename as a deletion plus
      // an addition so the old path cannot disappear while reporting complete.
      committedNames = parseNameOnlyOutput(stdout).map((name) => unwrapStatusPath(name));
    } catch {
      reasons.push('committed change list unavailable');
    }
  } else if (baseValid && !headValid) {
    reasons.push('committed change list unavailable without actual HEAD');
  }

  let trackedStatus: string[] = [];
  let untrackedStatus: string[] = [];
  try {
    // `-uall` lists individual files inside wholly-new untracked directories
    // (bare `-u normal` collapses them to a single `dir/` entry that the
    // allowlist rejects while reporting `complete`).
    const { stdout } = await execute('git', ['status', '--porcelain', '-uall']);
    const parsed = parseRecoveryStatus(stdout);
    trackedStatus = parsed.tracked;
    untrackedStatus = parsed.untracked;
  } catch {
    reasons.push('worktree status unavailable');
  }

  const allChanged = uniquePaths([...committedNames, ...trackedStatus, ...untrackedStatus]);
  const workflowFiles = listRecoveryWorkflowFiles(allChanged);
  if (workflowFiles.length > 0) {
    reasons.push(
      'workflow files changed; recovery preserves metadata only — use the trusted-publication handoff policy, no automatic publication',
    );
  }

  const untrackedSet = new Set(untrackedStatus.map((path) => path.trim()).filter((p) => p !== ''));
  const trackedCandidates = uniquePaths([...committedNames, ...trackedStatus]).filter(
    (path) => !untrackedSet.has(path),
  );

  const eligibleTracked = trackedCandidates.filter((path) => isEligibleRecoveryPath(path));
  const excludedTracked = trackedCandidates.length - eligibleTracked.length;

  const eligibleUntrackedCandidates = uniquePaths(untrackedStatus).filter((path) =>
    isEligibleRecoveryPath(path),
  );
  const excludedUntracked =
    uniquePaths(untrackedStatus).length - eligibleUntrackedCandidates.length;

  let combinedPatch = '';
  let patchTruncated = false;
  let includedTracked = 0;
  if (baseValid && eligibleTracked.length > 0) {
    const budgeted = eligibleTracked.slice(0, RECOVERY_MAX_FILES);
    if (budgeted.length < eligibleTracked.length) {
      patchTruncated = true;
      reasons.push(`tracked snapshot truncated to ${String(RECOVERY_MAX_FILES)} paths`);
    }
    try {
      const { stdout } = await execute('git', ['diff', base, '--', ...budgeted, '--']);
      combinedPatch = stdout;
      includedTracked = budgeted.length;
      if (utf8ByteLength(combinedPatch) > RECOVERY_MAX_TOTAL_BYTES) {
        combinedPatch = sliceByUtf8Bytes(combinedPatch, RECOVERY_MAX_TOTAL_BYTES);
        patchTruncated = true;
        reasons.push('tracked snapshot truncated at byte bound');
      }
    } catch {
      reasons.push('tracked snapshot unavailable');
      combinedPatch = '';
      includedTracked = 0;
    }
  }

  const untrackedFiles: RecoveryUntrackedFile[] = [];
  let untrackedTruncated = false;
  let diskExcluded = 0;
  let bytesUsed = utf8ByteLength(combinedPatch);
  const remainingSlots = Math.max(0, RECOVERY_MAX_FILES - includedTracked);
  const budgetedUntracked = eligibleUntrackedCandidates.slice(0, remainingSlots);
  if (budgetedUntracked.length < eligibleUntrackedCandidates.length) {
    untrackedTruncated = true;
    reasons.push(`untracked snapshot truncated to ${String(RECOVERY_MAX_FILES)} total paths`);
  }
  for (const relativePath of budgetedUntracked) {
    if (bytesUsed >= RECOVERY_MAX_TOTAL_BYTES) {
      untrackedTruncated = true;
      reasons.push('recovery snapshot truncated at total byte bound');
      break;
    }
    const absolutePath = resolve(worktreeRoot, relativePath);
    const eligible = await isEligibleRecoveryFile(absolutePath, worktreeRoot).catch(() => false);
    if (!eligible) {
      diskExcluded += 1;
      reasons.push(`untracked file excluded after disk check: ${relativePath}`);
      continue;
    }
    try {
      // Bounded read with a finite deadline: an injected `readFile` is raced
      // against the read timeout, while the default path never loads more
      // than the remaining byte budget (+1 probe) into memory. Either way the
      // stored content is capped at true UTF-8 bytes, never code units.
      const budget = Math.min(
        RECOVERY_MAX_BYTES_PER_FILE,
        Math.max(0, RECOVERY_MAX_TOTAL_BYTES - bytesUsed),
      );
      let content: string;
      let fileTruncated = false;
      if (injectedRead !== undefined) {
        const raw = await withTimeout(injectedRead(absolutePath), readTimeoutMs);
        if (utf8ByteLength(raw) > budget) {
          content = sliceByUtf8Bytes(raw, budget);
          fileTruncated = true;
        } else {
          content = raw;
        }
      } else {
        const bounded = await withTimeout(readBoundedTextFile(absolutePath, budget), readTimeoutMs);
        content = bounded.content;
        fileTruncated = bounded.truncated;
      }
      if (fileTruncated) {
        untrackedFiles.push({ path: relativePath, content });
        bytesUsed += utf8ByteLength(content);
        untrackedTruncated = true;
        reasons.push(`untracked file truncated at bound: ${relativePath}`);
      } else {
        untrackedFiles.push({ path: relativePath, content });
        bytesUsed += utf8ByteLength(content);
      }
    } catch {
      reasons.push(`untracked file unreadable: ${relativePath}`);
    }
  }

  const counts: RecoveryCounts = {
    committed: committedNames.length,
    uncommitted: trackedStatus.length,
    untracked: untrackedStatus.length,
    included: includedTracked + untrackedFiles.length,
    excluded: Math.max(0, excludedTracked + excludedUntracked + diskExcluded),
  };

  const truncated = patchTruncated || untrackedTruncated;
  const headKnown = headValid;
  const status: RecoveryStatus =
    !headKnown && !baseValid ? 'unavailable' : reasons.length > 0 ? 'incomplete' : 'complete';

  return {
    version: RECOVERY_VERSION,
    base,
    head: actualHead,
    branch,
    status,
    reasons,
    counts,
    workflowFiles,
    truncated,
    combinedPatch,
    patchTruncated,
    untrackedFiles,
    untrackedTruncated,
    diagnostics,
    createdAt: now(),
  };
}
