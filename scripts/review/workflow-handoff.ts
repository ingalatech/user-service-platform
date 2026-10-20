import * as fs from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CommandExecutor } from './runner.js';

// Workflow-file publication handoff (ticket #36). Local agents may edit
// `.github/workflows/**`, but the local flow stops before publishing those
// changes. Repository-owned orchestration detects them and leaves a durable
// patch/metadata bundle for the authorized operator publication path.
export const WORKFLOW_DIR_PREFIX = '.github/workflows/';
export const WORKFLOW_DIR_ARG = '.github/workflows/';
export const HANDOFF_PATCH_PATH = '.agent-ticket/workflow-handoff.patch';
export const HANDOFF_RECORD_PATH = '.agent-ticket/workflow-handoff.json';
export const TRUSTED_PUBLICATION_MARKER = 'trusted-publication-required';

// Retained for the dormant local approval utility. These helpers validate
// historical handoff evidence but are not invoked by the local ticket or
// review cycles and do not publish workflow changes.
export const TRUSTED_HANDOFF_MARKER_PREFIX = '<!-- trusted-workflow-handoff:v1 ';
export const TRUSTED_HANDOFF_MARKER_SUFFIX = ' -->';
export const TRUSTED_PUBLISHER_APP_SLUG = 'chatgpt-codex-connector';

export interface TrustedHandoffMarker {
  v: 1;
  ticket: number;
  branch: string;
  base: string;
  head: string;
  files: string[];
}

const EXACT_SHA_PATTERN = /^[0-9a-fA-F]{40}$/;

function isExactSha(value: unknown): value is string {
  return typeof value === 'string' && EXACT_SHA_PATTERN.test(value.trim());
}

export function parseTrustedHandoffMarker(
  body: string | undefined | null,
): TrustedHandoffMarker | null {
  if (typeof body !== 'string') {
    return null;
  }
  const start = body.indexOf(TRUSTED_HANDOFF_MARKER_PREFIX);
  if (start === -1) {
    return null;
  }
  const jsonStart = start + TRUSTED_HANDOFF_MARKER_PREFIX.length;
  const end = body.indexOf(TRUSTED_HANDOFF_MARKER_SUFFIX, jsonStart);
  if (end === -1) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(jsonStart, end).trim()) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return null;
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    candidate.v !== 1 ||
    typeof candidate.ticket !== 'number' ||
    !Number.isInteger(candidate.ticket) ||
    candidate.ticket <= 0 ||
    typeof candidate.branch !== 'string' ||
    candidate.branch.trim() === '' ||
    !isExactSha(candidate.base) ||
    !isExactSha(candidate.head) ||
    !Array.isArray(candidate.files)
  ) {
    return null;
  }
  const files: string[] = [];
  for (const entry of candidate.files) {
    if (typeof entry !== 'string') {
      return null;
    }
    const normalized = normalizeHandoffPath(entry);
    if (!isWorkflowFile(normalized)) {
      return null;
    }
    files.push(normalized);
  }
  return {
    v: 1,
    ticket: candidate.ticket,
    branch: candidate.branch,
    base: candidate.base.trim(),
    head: candidate.head.trim(),
    files: [...new Set(files)].sort(),
  };
}

function isHandoffCovering(
  marker: TrustedHandoffMarker,
  workflowFiles: readonly string[],
): boolean {
  if (workflowFiles.length === 0) {
    return false;
  }
  const covered = new Set(marker.files);
  return workflowFiles.every((file) => covered.has(normalizeHandoffPath(file)));
}

export function findMatchingHandoffMarker(
  markers: readonly TrustedHandoffMarker[],
  options: { ticket: number; branch: string; workflowFiles: readonly string[] },
): TrustedHandoffMarker | null {
  for (const marker of markers) {
    if (
      marker.ticket === options.ticket &&
      marker.branch === options.branch &&
      isHandoffCovering(marker, options.workflowFiles)
    ) {
      return marker;
    }
  }
  return null;
}

export function normalizeHandoffPath(path: string): string {
  let normalized = path.trim();
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

export function isWorkflowFile(path: string): boolean {
  const normalized = normalizeHandoffPath(path);
  if (normalized === '' || !normalized.startsWith(WORKFLOW_DIR_PREFIX)) {
    return false;
  }
  const rest = normalized.slice(WORKFLOW_DIR_PREFIX.length);
  if (rest === '' || rest.endsWith('/')) {
    return false;
  }
  return true;
}

export function listWorkflowFiles(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const path of paths) {
    const normalized = normalizeHandoffPath(path);
    if (isWorkflowFile(normalized)) {
      seen.add(normalized);
    }
  }
  return [...seen].sort();
}

export function parseNameOnlyOutput(stdout: string): string[] {
  const paths: string[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') {
      paths.push(trimmed);
    }
  }
  return paths;
}

// Deterministic range diff scoped to the workflows directory so detection
// cannot drift between orchestrators. Callers pass exact SHAs they already
// hold (branch base and HEAD), never a moving ref.
export function buildWorkflowDiffArgs(base: string, head: string): readonly string[] {
  return ['diff', '--name-only', `${base}...${head}`, '--', WORKFLOW_DIR_ARG];
}

// Deterministic full-range patch so the handoff bundle preserves the
// complete correction (a correction may also contain scripts/tests/docs
// alongside workflow files). The record's `files` list still identifies the
// workflow files that triggered trusted handoff. Callers pass exact SHAs
// they already hold (branch base and HEAD), never a moving ref.
export function buildWorkflowPatchArgs(base: string, head: string): readonly string[] {
  return ['diff', `${base}...${head}`, '--'];
}

// Deliberately distinct from ordinary safe-push refusal text: the terminal
// workflow step distinguishes this handoff from branch/base/dirty failures.
export function formatHandoffReason(files: readonly string[]): string {
  const names = files.join(', ');
  return (
    `${TRUSTED_PUBLICATION_MARKER}: the correction touches workflow files (${names}). ` +
    'The local agent flow stops before publishing workflow changes. An authorized operator ' +
    'must publish the reviewed change, then exact-HEAD review resumes on the published HEAD.'
  );
}

export function formatHandoffAction(): string {
  return (
    'Ask the trusted operator to publish the reviewed correction from the handoff patch, ' +
    'then rerun review against the newly published exact HEAD.'
  );
}

export interface WorkflowHandoffRecord {
  version: 1;
  branch: string;
  base: string;
  head: string;
  files: string[];
  patchPath: string;
  reason: string;
  createdAt: string;
}

export interface BuildHandoffRecordInput {
  branch: string;
  base: string;
  head: string;
  files: readonly string[];
  createdAt?: string;
}

export function buildHandoffRecord(input: BuildHandoffRecordInput): WorkflowHandoffRecord {
  return {
    version: 1,
    branch: input.branch,
    base: input.base,
    head: input.head,
    files: [...input.files],
    patchPath: HANDOFF_PATCH_PATH,
    reason: formatHandoffReason(input.files),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export function serializeHandoffRecord(record: WorkflowHandoffRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export async function listChangedWorkflowFiles(
  execute: CommandExecutor,
  base: string,
  head: string,
): Promise<string[]> {
  const { stdout } = await execute('git', buildWorkflowDiffArgs(base, head));
  return listWorkflowFiles(parseNameOnlyOutput(stdout));
}

export async function getWorkflowPatch(
  execute: CommandExecutor,
  base: string,
  head: string,
): Promise<string> {
  const { stdout } = await execute('git', buildWorkflowPatchArgs(base, head));
  return stdout;
}

// Durable evidence bundle (ticket #36): persist the patch plus exact base/head
// metadata under `.agent-ticket/` for the authorized operator publication path.
export async function persistWorkflowHandoffBundle(
  record: WorkflowHandoffRecord,
  patch: string,
): Promise<void> {
  await fs.mkdir(dirname(HANDOFF_RECORD_PATH), { recursive: true });
  await fs.writeFile(HANDOFF_PATCH_PATH, patch, 'utf8');
  await fs.writeFile(HANDOFF_RECORD_PATH, serializeHandoffRecord(record), 'utf8');
}
