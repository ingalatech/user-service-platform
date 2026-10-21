import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { assertWorkerName, parseDeployEnvironment } from './naming.js';
import {
  isAbsentWorkerError,
  parseWorkerDeploymentsOutput,
  workerDeploymentsListArgs,
} from './provision-worker.js';
import { isProvisionedDatabaseId, type DeploymentTarget } from './environment-config.js';

// Deployment preflight (ticket #78, ADR-0008).
//
// Verifies Node/Wrangler/auth/account access, a clean worktree, target
// configuration and required resource identifiers before any remote
// mutation. Preflight performs no remote mutation itself: it runs only
// `wrangler --version`, `wrangler whoami` and `git status --porcelain`.
//
// Secret boundary: preflight never reads provider/auth secret values. Cloudflare
// authentication is probed through `wrangler whoami` exit status, and command
// output is reduced to pass/fail.

export interface PreflightCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface PreflightResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr?: string;
}

export interface PreflightDeps {
  readonly nodeVersion: string;
  readonly commands: PreflightCommand[];
  readonly run: (command: string, args: string[]) => Promise<PreflightResult>;
}

export interface PreflightInput {
  readonly resolved: DeploymentTarget;
}

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
}

interface NodeRange {
  readonly minimum: NodeVersion;
  readonly exclusiveMaximumMajor: number;
  readonly text: string;
}

function readNodeRange(): NodeRange {
  const packageJson = JSON.parse(
    readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
  ) as { readonly engines?: { readonly node?: unknown } };
  const text = packageJson.engines?.node;
  const engineText = typeof text === 'string' ? text : undefined;
  const match = engineText === undefined ? null : /^>=(\d+)\.(\d+)\.(\d+) <(\d+)$/.exec(engineText);
  const minimumMajor = match?.[1];
  const minimumMinor = match?.[2];
  const minimumPatch = match?.[3];
  const exclusiveMaximumMajor = match?.[4];
  if (
    engineText === undefined ||
    minimumMajor === undefined ||
    minimumMinor === undefined ||
    minimumPatch === undefined ||
    exclusiveMaximumMajor === undefined
  ) {
    throw new Error('package.json must declare a Node engine range like ">=24.22.1 <25".');
  }
  return {
    minimum: {
      major: Number.parseInt(minimumMajor, 10),
      minor: Number.parseInt(minimumMinor, 10),
      patch: Number.parseInt(minimumPatch, 10),
    },
    exclusiveMaximumMajor: Number.parseInt(exclusiveMaximumMajor, 10),
    text: engineText,
  };
}

const NODE_RANGE = readNodeRange();

function parseNodeVersion(version: string): NodeVersion | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
    version.trim(),
  );
  const major = match?.[1];
  const minor = match?.[2];
  const patch = match?.[3];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return {
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
    patch: Number.parseInt(patch, 10),
  };
}

function compareNodeVersions(left: NodeVersion, right: NodeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function nodeVersionSatisfies(version: string): boolean {
  const parsed = parseNodeVersion(version);
  return (
    parsed !== undefined &&
    parsed.major < NODE_RANGE.exclusiveMaximumMajor &&
    compareNodeVersions(parsed, NODE_RANGE.minimum) >= 0
  );
}

export async function runPreflight(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  const nodeOk = nodeVersionSatisfies(deps.nodeVersion);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: nodeOk ? `node ${NODE_RANGE.text}` : `node ${NODE_RANGE.text} is required`,
  });

  const versionResult = await deps.run('npx', ['wrangler', '--version']);
  checks.push({
    name: 'wrangler',
    ok: versionResult.exitCode === 0,
    detail: versionResult.exitCode === 0 ? 'wrangler available' : 'wrangler --version failed',
  });

  const authResult = await deps.run('npx', ['wrangler', 'whoami']);
  checks.push({
    name: 'cloudflare-auth',
    ok: authResult.exitCode === 0,
    detail:
      authResult.exitCode === 0
        ? 'cloudflare authentication verified'
        : 'cloudflare authentication failed (wrangler whoami)',
  });

  // Account access is probed with a read-only resource listing: it proves the
  // token can reach the account scope without mutating anything.
  const accountResult = await deps.run('npx', ['wrangler', 'd1', 'list']);
  checks.push({
    name: 'account-access',
    ok: accountResult.exitCode === 0,
    detail:
      accountResult.exitCode === 0
        ? 'cloudflare account access verified'
        : 'cloudflare account access failed (wrangler d1 list)',
  });

  const statusResult = await deps.run('git', ['status', '--porcelain']);
  const clean = statusResult.exitCode === 0 && statusResult.stdout.trim() === '';
  checks.push({
    name: 'worktree',
    ok: clean,
    detail: clean ? 'worktree clean' : 'worktree has uncommitted changes',
  });

  let environmentOk = true;
  try {
    parseDeployEnvironment(input.resolved.environment);
  } catch {
    environmentOk = false;
  }
  const configured =
    input.resolved.targetKey.length > 0 &&
    environmentOk &&
    isProvisionedDatabaseId(input.resolved.databaseId);
  checks.push({
    name: 'target-config',
    ok: configured,
    detail: configured ? 'target configuration complete' : 'target configuration incomplete',
  });

  let workerOk = true;
  try {
    assertWorkerName(input.resolved.workerName);
  } catch {
    workerOk = false;
  }
  checks.push({
    name: 'worker-name',
    ok: workerOk,
    detail: workerOk ? 'worker name valid' : 'worker name invalid',
  });

  const workerPresence = await checkWorkerPresence(input.resolved, deps);
  checks.push(workerPresence.check);

  return checks;
}

export function preflightFailed(checks: readonly PreflightCheck[]): boolean {
  return checks.some((check) => !check.ok);
}

async function checkWorkerPresence(
  resolved: DeploymentTarget,
  deps: PreflightDeps,
): Promise<{ readonly check: PreflightCheck; readonly exists: boolean | undefined }> {
  const listed = await deps.run('npx', [...workerDeploymentsListArgs(resolved.workerName)]);
  if (listed.exitCode !== 0) {
    if (isAbsentWorkerError(listed.stderr)) {
      return {
        check: {
          name: 'worker-presence',
          ok: true,
          detail: 'Worker absent; first deploy is allowed',
        },
        exists: false,
      };
    }
    return {
      check: {
        name: 'worker-presence',
        ok: false,
        detail: 'Worker existence could not be determined',
      },
      exists: undefined,
    };
  }
  try {
    const discovery = parseWorkerDeploymentsOutput(listed.stdout);
    return {
      check: {
        name: 'worker-presence',
        ok: true,
        detail: discovery.found ? 'Worker exists' : 'Worker absent; first deploy is allowed',
      },
      exists: discovery.found,
    };
  } catch {
    return {
      check: {
        name: 'worker-presence',
        ok: false,
        detail: 'Worker existence could not be determined',
      },
      exists: undefined,
    };
  }
}

// Formats only check names plus static details: command output (which may
// carry account identifiers or reflected secrets) is never included.
export function formatPreflightError(checks: readonly PreflightCheck[]): Error {
  const failed = checks
    .filter((check) => !check.ok)
    .map((check) => `${check.name}: ${check.detail}`);
  return new Error(`Deployment preflight failed: ${failed.join('; ')}.`);
}
