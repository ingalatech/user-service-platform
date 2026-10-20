// First-time target provisioning entry point (ticket #80, parent spec #8).
//
// A maintainer who is not deeply familiar with Cloudflare provisions a new
// deployment target through one documented command:
//
// ```bash
// npm run provision -- --env sandbox --plan
// npm run provision -- --env sandbox --apply
// ```
//
// Plan is the default no-mutation mode. Apply discovers the exact canonical
// D1 database (creating it when absent), reports read-only Worker/deployment
// state, reports required secrets by names/types only, and stages the
// non-secret database id in `config/environments/.env.sandbox` as a reviewable worktree
// diff. Production apply requires `--confirm` equal to the target Worker
// name; production planning stays read-only.
//
// Provisioning never deploys application code, never creates a placeholder
// Worker, never reads/writes/copies/prints secret values, never commits or
// pushes, and never uses Wrangler `--update-config`: the repository target
// registry stays authoritative.
//
// Secret boundary: Wrangler child processes inherit Cloudflare credentials
// from the operator environment only. Provider output is reduced to
// pass/fail plus names/ids at the orchestration boundary; raw provider
// bodies never reach logs or errors.
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  parseProvisionArgs,
  PROVISION_HELP,
  resolveProvisionSelection,
} from './deploy/provision-cli.js';
import { runProvision, type ProvisionCommandResult } from './deploy/provision.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentDeployment,
  stageDatabaseId,
} from './deploy/environment-config.js';
import type { TargetsFile } from './deploy/targets.js';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function readEnvironmentTarget(environment: 'sandbox' | 'production'): TargetsFile {
  const resolved = resolveEnvironmentDeployment(
    loadEnvironmentFile(environmentFilePath(repoRoot(), environment)),
  );
  return {
    version: 1,
    service: 'user-service',
    targets: [
      {
        key: resolved.targetKey,
        company: resolved.company,
        site: resolved.site,
        service: resolved.service,
        displayName: 'RugbyChampagne (RCH)',
        environments: {
          sandbox: {
            accountId: resolved.accountId,
            databaseId: environment === 'sandbox' ? resolved.databaseId : '',
            vars: resolved.vars,
          },
          production: {
            accountId: resolved.accountId,
            databaseId: environment === 'production' ? resolved.databaseId : '',
            vars: resolved.vars,
          },
        },
      },
    ],
  };
}

// Runs a Wrangler read/create step, capturing machine-readable stdout for
// the orchestration boundary. Credentials pass through process inheritance
// only; raw provider output is consumed as data and never printed, so
// tokens, account identifiers or secret values cannot leak through logs.
async function runProvisionCommand(
  command: string,
  args: readonly string[],
  accountId: string,
): Promise<ProvisionCommandResult> {
  try {
    const { stdout } = await execFileAsync(command, [...args], {
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: accountId },
    });
    return { exitCode: 0, stdout };
  } catch {
    return { exitCode: 1, stdout: '' };
  }
}

async function main(): Promise<void> {
  const parsed = parseProvisionArgs(process.argv.slice(2), {
    PROVISION_ENV: process.env.PROVISION_ENV,
    PROVISION_CONFIRM: process.env.PROVISION_CONFIRM,
  });
  if (parsed.help) {
    console.log(PROVISION_HELP);
    return;
  }
  if (parsed.environment === 'production') {
    throw new Error('Production provisioning is not supported; provision sandbox only.');
  }
  if (parsed.environment === undefined) throw new Error('No provisioning environment selected.');
  const selection = resolveProvisionSelection(parsed, {
    interactive: false,
  });
  const environmentPath = environmentFilePath(repoRoot(), selection.environment);
  const outcome = await runProvision(
    {
      target: 'rch-rugbychampagne',
      environment: selection.environment,
      mode: parsed.mode,
      confirm: parsed.confirm,
    },
    {
      loadTargets: () => readEnvironmentTarget(selection.environment),
      loadVersionedTargets: () => readEnvironmentTarget(selection.environment),
      writeTargets: (file) => {
        const id = file.targets[0]?.environments[selection.environment].databaseId;
        if (id !== undefined) stageDatabaseId(environmentPath, id);
      },
      log: (message) => {
        console.log(message);
      },
    },
    (command, args, scope) => runProvisionCommand(command, args, scope?.accountId ?? ''),
  );
  if (outcome.configUpdated) {
    console.log(
      `provisioning staged ${environmentPath}: review the diff, then commit it before deploying.`,
    );
  }
}

const invokedDirectly = process.argv[1]?.endsWith('provision.ts') === true;
if (invokedDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown provisioning failure');
    process.exitCode = 1;
  });
}
