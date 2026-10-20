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
