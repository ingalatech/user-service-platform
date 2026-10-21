import { assertWorkerName, parseDeployEnvironment } from './naming.js';
import {
  isAbsentWorkerError,
  parseWorkerDeploymentsOutput,
  workerDeploymentsListArgs,
} from './provision-worker.js';
import { isProvisionedDatabaseId, type ResolvedDeployment } from './environment-config.js';

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
  readonly resolved: ResolvedDeployment;
}

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

function nodeMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version.trim());
  if (match?.[1] === undefined) {
    return 0;
  }
  const major = Number.parseInt(match[1], 10);
  return Number.isInteger(major) ? major : 0;
}

export async function runPreflight(
  input: PreflightInput,
  deps: PreflightDeps,
): Promise<PreflightCheck[]> {
  const checks: PreflightCheck[] = [];

  const major = nodeMajor(deps.nodeVersion);
  checks.push({
    name: 'node',
    ok: major >= 24,
    detail: major >= 24 ? 'node >= 24' : 'node >= 24 is required',
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
  resolved: ResolvedDeployment,
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
