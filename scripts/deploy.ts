// Client-aware Cloudflare deployer (ticket #78, ADR-0008).
//
// First-class deployment commands for the User Service across multiple
// companies and sites:
//
// ```bash
// npm run deploy -- --env sandbox
// npm run deploy:production -- --confirm rch-rugbychampagne-user-service-production
// ```
//
// The deployer selects a deployment target and canonical environment
// interactively for humans (never offering `staging`) and deterministically
// through CLI/env inputs for automation. It materializes a temporary Wrangler
// config from the base application config plus the selected target, runs
// preflight before any remote mutation, applies D1 migrations before Worker
// deployment, records the deployment, and runs the existing smoke test for
// sandbox. Production requires `--confirm` equal to the target Worker name
// and is never an automatic side effect.
//
// Secret boundary: Worker secrets remain configured directly in Cloudflare
// for the selected target Worker. This command never reads, prints, commits
// or uploads secret values; Cloudflare credentials pass to Wrangler through
// process inheritance only.
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DEPLOY_HELP, parseDeployArgs, type DeployArgs } from './deploy/cli.js';
import type { DeployableEnvironment } from './deploy/naming.js';
import {
  buildTargetWranglerConfig,
  removeTempWranglerConfig,
  writeTempWranglerConfig,
} from './deploy/materialize.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentDeployment,
} from './deploy/environment-config.js';
import { formatPreflightError, preflightFailed, runPreflight } from './deploy/preflight.js';
import { runDeployment, type DeployIo } from './deploy/orchestrate.js';
import { startSessionFailureTail } from './deploy/diagnostic-tail.js';
import type { ResolvedDeployment } from './deploy/environment-config.js';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isInteractive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

async function promptSelection(args: DeployArgs, interactive: boolean): Promise<DeployArgs> {
  if (args.environment !== undefined) {
    return args;
  }
  if (!interactive) {
    throw new Error(
      'Missing deployment environment: pass --env <sandbox|production> or set DEPLOY_ENV.',
    );
  }
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    let environment: DeployableEnvironment;
    console.log('Environments:');
    console.log('  1) sandbox');
    console.log('  2) production');
    const answer = (await readline.question('Select an environment (number): ')).trim();
    if (answer === '1') {
      environment = 'sandbox';
    } else if (answer === '2') {
      environment = 'production';
    } else {
      throw new Error('No deployment environment selected.');
    }
    return { ...args, environment };
  } finally {
    readline.close();
  }
}

// Runs a deployment step with inherited stdio so the operator sees Wrangler
// output directly. Credentials pass through process inheritance only; this
// command never reads secret values.
function runInherited(
  command: string,
  commandArgs: string[],
  accountId?: string,
): Promise<{ exitCode: number }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, commandArgs, {
      env:
        accountId === undefined
          ? process.env
          : { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
      // Provider stderr is never operator output. Discovery captures it for
      // code classification; mutating commands expose only their exit code.
      stdio: ['inherit', 'inherit', 'ignore'],
    });
    child.on('error', () => {
      resolvePromise({ exitCode: 1 });
    });
    child.on('close', (code) => {
      resolvePromise({ exitCode: code ?? 1 });
    });
  });
}

function processStderr(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stderr' in error) {
    const stderr = (error as { readonly stderr?: unknown }).stderr;
    return typeof stderr === 'string' ? stderr : '';
  }
  return '';
}

async function main(): Promise<void> {
  const parsed = parseDeployArgs(process.argv.slice(2), {
    DEPLOY_ENV: process.env.DEPLOY_ENV,
    DEPLOY_CONFIRM: process.env.DEPLOY_CONFIRM,
  });
  if (parsed.help) {
    console.log(DEPLOY_HELP);
    return;
  }
  const args = await promptSelection(parsed, isInteractive() && !parsed.nonInteractive);
  if (args.environment === undefined) throw new Error('No deployment environment selected.');
  const resolved = resolveEnvironmentDeployment(
    loadEnvironmentFile(environmentFilePath(repoRoot(), args.environment)),
    { requireRemoteReady: true },
  );

  if (args.writeConfig !== undefined) {
    const destination = resolve(args.writeConfig);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(
      destination,
      `${JSON.stringify(buildTargetWranglerConfig(resolved, { repoRoot: repoRoot() }), null, 2)}\n`,
      'utf8',
    );
    console.log(
      `wrote worker=${resolved.workerName} database=${resolved.databaseName} path=${destination}`,
    );
    return;
  }

  const directory = mkdtempSync(join(tmpdir(), 'user-service-deploy-'));
  const deployRepoRoot = repoRoot();
  const io: DeployIo = {
    materialize: (target) =>
      writeTempWranglerConfig(target, directory, { repoRoot: deployRepoRoot }),
    cleanup: (path) => {
      removeTempWranglerConfig(path);
      try {
        rmSync(directory, { recursive: true, force: true });
      } catch {
        // Temporary-directory hygiene never fails a deployment.
      }
    },
    preflight: async (target: ResolvedDeployment) => {
      const checks = await runPreflight(
        { resolved: target },
        {
          nodeVersion: process.version,
          commands: [],
          run: async (command, commandArgs) => {
            try {
              const { stdout } = await execFileAsync(command, commandArgs, {
                env:
                  target.accountId === ''
                    ? process.env
                    : { ...process.env, CLOUDFLARE_ACCOUNT_ID: target.accountId },
              });
              return { exitCode: 0, stdout };
            } catch (error: unknown) {
              return { exitCode: 1, stdout: '', stderr: processStderr(error) };
            }
          },
        },
      );
      if (preflightFailed(checks)) {
        throw formatPreflightError(checks);
      }
    },
    log: (message: string) => {
      console.log(message);
    },
    sourceMetadata: async () => {
      const [commit, branch] = await Promise.all([
        execFileAsync('git', ['rev-parse', '--short', 'HEAD'], { cwd: deployRepoRoot }),
        execFileAsync('git', ['branch', '--show-current'], { cwd: deployRepoRoot }),
      ]);
      return { commit: commit.stdout.trim(), branch: branch.stdout.trim() || 'detached' };
    },
    confirmFirstDeployment: async (workerName) => {
      if (!isInteractive()) {
        return false;
      }
      const readline = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const expected = `FIRST DEPLOY ${workerName}`;
        console.log(
          'Cloudflare activates a Worker’s first version immediately; no inactive candidate is possible.',
        );
        return (
          (await readline.question(`Type exactly "${expected}" to continue: `)).trim() === expected
        );
      } finally {
        readline.close();
      }
    },
    // Diagnostic tailing is retained for the full privileged sandbox smoke;
    // bootstrap and public readiness do not inspect runtime secret state.
    startSessionFailureTail: (target: ResolvedDeployment, configPath: string) => {
      if (target.environment !== 'sandbox') {
        return Promise.reject(new Error('Diagnostic tailing is sandbox-only.'));
      }
      return startSessionFailureTail(target, configPath);
    },
  };
  const outcome = await runDeployment(
    { resolved, confirm: args.confirm, dryRun: args.dryRun },
    io,
    async (command, commandArgs) => {
      if (commandArgs.includes('list') && commandArgs.includes('--json')) {
        try {
          const { stdout } = await execFileAsync(command, commandArgs, {
            env:
              resolved.accountId === ''
                ? process.env
                : { ...process.env, CLOUDFLARE_ACCOUNT_ID: resolved.accountId },
          });
          return { exitCode: 0, stdout };
        } catch (error: unknown) {
          return { exitCode: 1, stdout: '', stderr: processStderr(error) };
        }
      }
      return runInherited(command, commandArgs, resolved.accountId);
    },
  );
  console.log(`deployment complete worker=${outcome.workerName}`);
}

const invokedDirectly = process.argv[1]?.endsWith('deploy.ts') === true;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown deployment failure');
    process.exitCode = 1;
  });
}
