// Explicit bounded local fix-cycle correction through the evidence-capable
// worker seam (ticket #116).
//
// The operator invokes this utility explicitly from an isolated local
// worktree. It runs `opencode` instead of a raw shell command so the
// correction produces versioned minimal attributable skill evidence like
// every other worker. Bounds, live output and clean-worktree policy are
// preserved: a hung correction is terminated with a distinguishable TIMEOUT
// and leaves `.address-review-timeout` as an operator-visible local marker,
// while evidence failures never mask the correction outcome.
import * as fs from 'node:fs/promises';
import { buildAddressReviewArgs, getCurrentHead } from '../review/runner.js';
import {
  buildEvidenceInvocation,
  commandSessionExporter,
  createEvidenceCapture,
  finalizeSkillEvidence,
  suppressJsonWorkerLines,
} from '../review/evidence-worker.js';
import { isWorkerTimeout, timeoutForWorker } from '../review/worker-timeout.js';
import { runWorkerStream } from '../review/worker-stream.js';

export const FIX_CYCLE_TIMEOUT_SENTINEL = '.address-review-timeout';
// Stable local operator artifact; no automation consumes it.
export const FIX_CYCLE_TIMEOUT_MESSAGE = 'address-review timed out after 20m';

export function parseFixCyclePr(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `agent:fix-cycle-correction requires a positive integer PR number, got ${raw ?? '(missing)'}`,
    );
  }
  return Number.parseInt(trimmed, 10);
}

export type FixCycleWorker = (
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
) => Promise<void>;

export type FixCycleEvidence = (input: {
  worker: 'agent-fix-cycle';
  command: string;
  axis: string;
  attempt: number;
  workerStartHead: string;
  lines: readonly string[];
  truncatedStream?: boolean;
}) => Promise<string | undefined>;

export interface FixCycleCorrectionDeps {
  runWorker?: FixCycleWorker;
  finalizeEvidence?: FixCycleEvidence;
  writeSentinel?: (path: string, contents: string) => Promise<void>;
  getHead?: () => Promise<string>;
}

export interface FixCycleCorrectionResult {
  exitCode: number;
  evidencePath?: string;
  timedOut?: boolean;
  reason?: string;
}

async function defaultRunWorker(
  command: string,
  args: readonly string[],
  onLine: (line: string) => void,
): Promise<void> {
  await runWorkerStream(
    command,
    args,
    {
      label: 'address-review',
      timeoutMs: timeoutForWorker('address-review'),
      stdoutLogFilter: suppressJsonWorkerLines,
    },
    undefined,
    { onStdoutLine: onLine },
  );
}

async function defaultFinalizeEvidence(input: {
  worker: 'agent-fix-cycle';
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

export async function runFixCycleCorrection(
  rawPr: string | undefined,
  deps: FixCycleCorrectionDeps = {},
): Promise<FixCycleCorrectionResult> {
  let pr: number;
  try {
    pr = parseFixCyclePr(rawPr);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`AGENT-FIX-CYCLE-CORRECTION BLOCKED (validate): ${reason}`);
    return { exitCode: 1, reason };
  }
  const runWorker = deps.runWorker ?? defaultRunWorker;
  const finalizeEvidence = deps.finalizeEvidence ?? defaultFinalizeEvidence;
  const writeSentinel =
    deps.writeSentinel ??
    ((path: string, contents: string) => fs.writeFile(path, contents, 'utf8'));
  const getHead = deps.getHead ?? getCurrentHead;
  let workerStartHead = '(unknown)';
  try {
    workerStartHead = await getHead();
  } catch {
    workerStartHead = '(unknown)';
  }
  const capture = createEvidenceCapture();
  const settleEvidence = async (): Promise<string | undefined> => {
    try {
      return await finalizeEvidence({
        worker: 'agent-fix-cycle',
        command: 'address-review',
        axis: 'address-review',
        attempt: 1,
        workerStartHead,
        lines: capture.lines,
        truncatedStream: capture.wasTruncated(),
      });
    } catch {
      return undefined;
    }
  };
  try {
    await runWorker('opencode', buildAddressReviewArgs(pr), (line) => {
      capture.pushLine(line);
    });
  } catch (error) {
    const evidencePath = await settleEvidence();
    if (isWorkerTimeout(error)) {
      try {
        await writeSentinel(FIX_CYCLE_TIMEOUT_SENTINEL, FIX_CYCLE_TIMEOUT_MESSAGE);
      } catch {
        // Best-effort local operator marker; never mask the timeout itself.
      }
      console.error(`AGENT-FIX-CYCLE-CORRECTION TIMEOUT: ${FIX_CYCLE_TIMEOUT_MESSAGE}.`);
      return {
        exitCode: 1,
        timedOut: true,
        ...(evidencePath === undefined ? {} : { evidencePath }),
      };
    }
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`AGENT-FIX-CYCLE-CORRECTION FAILED: ${reason}`);
    return {
      exitCode: 1,
      reason,
      ...(evidencePath === undefined ? {} : { evidencePath }),
    };
  }
  const evidencePath = await settleEvidence();
  console.log('address-review completed within its bound.');
  return { exitCode: 0, ...(evidencePath === undefined ? {} : { evidencePath }) };
}

async function main(): Promise<void> {
  const [prArg, ...rest] = process.argv.slice(2);
  if (prArg === '--help' || prArg === '-h') {
    console.log('usage: agent:fix-cycle-correction <pr-number>');
    return;
  }
  if (rest.length > 0) {
    console.error(
      `AGENT-FIX-CYCLE-CORRECTION BLOCKED (validate): unknown argument: ${rest[0] ?? '(missing)'}`,
    );
    process.exitCode = 1;
    return;
  }
  const result = await runFixCycleCorrection(prArg);
  process.exitCode = result.exitCode;
}

await main().catch((error: unknown) => {
  console.error(
    `AGENT-FIX-CYCLE-CORRECTION FATAL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
