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
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { DEPLOY_HELP, parseDeployArgs, type DeployArgs } from './deploy/cli.js';
import type { DeployableEnvironment } from './deploy/naming.js';
import { buildTargetWranglerConfig } from './deploy/materialize.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentDeployment,
} from './deploy/environment-config.js';
import { runDeployment } from './deploy/orchestrate.js';
import { createChildProcessReleaseAdapter } from './deploy/process.js';
import { selectWithKeys } from './deploy/prompt.js';

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function isInteractive(): boolean {
  return process.stdin.isTTY && process.stdout.isTTY;
}

async function confirmFirstDeployment(workerName: string): Promise<boolean> {
  if (!isInteractive()) return false;
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
}

type SelectEnvironment = (question: string, choices: readonly string[]) => Promise<number>;

export async function promptDeploySelection(
  args: DeployArgs,
  interactive: boolean,
  select: SelectEnvironment = (question, choices) =>
    selectWithKeys(process.stdin, process.stdout, question, choices),
): Promise<DeployArgs> {
  if (args.environment !== undefined) {
    return args;
  }
  if (!interactive) {
    throw new Error(
      'Missing deployment environment: pass --env <sandbox|production> or set DEPLOY_ENV.',
    );
  }
  const environments = [
    'sandbox',
    'production',
  ] as const satisfies readonly DeployableEnvironment[];
  const question = args.dryRun
    ? 'Select deployment environment (dry-run: no changes will be made)'
    : 'Select deployment environment';
  const environment = environments[await select(question, environments)];
  if (environment === undefined) throw new Error('No deployment environment selected.');
  return { ...args, environment };
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
  if (
    parsed.dryRun &&
    parsed.environment === undefined &&
    isInteractive() &&
    !parsed.nonInteractive
  ) {
    console.log('\nDeploy dry-run: no changes will be made.');
  }
  const args = await promptDeploySelection(parsed, isInteractive() && !parsed.nonInteractive);
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

  const outcome = await runDeployment(
    { resolved, confirm: args.confirm, dryRun: args.dryRun },
    createChildProcessReleaseAdapter(),
    confirmFirstDeployment,
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
