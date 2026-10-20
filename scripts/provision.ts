// First-time target provisioning entry point (ticket #80, parent spec #8).
//
// A maintainer who is not deeply familiar with Cloudflare provisions a new
// deployment target through one documented command:
//
// ```bash
// npm run provision -- --target rch-rugbychampagne --env sandbox --plan
// npm run provision -- --target rch-rugbychampagne --env sandbox --apply
// ```
//
// Plan is the default no-mutation mode. Apply discovers the exact canonical
// D1 database (creating it when absent), reports read-only Worker/deployment
// state, reports required secrets by names/types only, and stages the
// non-secret database id in `deploy/targets.json` as a reviewable worktree
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  parseProvisionArgs,
  PROVISION_HELP,
  resolveProvisionSelection,
} from './deploy/provision-cli.js';
import { runProvision, type ProvisionCommandResult } from './deploy/provision.js';
import { listTargetKeys, loadTargetsFile, type TargetsFile } from './deploy/targets.js';
import { applyAccountOverrides, loadAccountOverrides } from './deploy/account-config.js';

const execFileAsync = promisify(execFile);

function repoRoot(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function targetsPath(): string {
  return join(repoRoot(), 'deploy', 'targets.json');
}

function readTargetsFile(): TargetsFile {
  const root = repoRoot();
  const overridePath = join(root, 'deploy', 'targets.local.json');
  return applyAccountOverrides(
    loadTargetsFile(JSON.parse(readFileSync(targetsPath(), 'utf8')) as unknown),
    loadAccountOverrides(
      existsSync(overridePath)
        ? (JSON.parse(readFileSync(overridePath, 'utf8')) as unknown)
        : { version: 1, targets: {} },
    ),
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );
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
    PROVISION_TARGET: process.env.PROVISION_TARGET,
    PROVISION_ENV: process.env.PROVISION_ENV,
    PROVISION_CONFIRM: process.env.PROVISION_CONFIRM,
  });
  if (parsed.help) {
    console.log(PROVISION_HELP);
    return;
  }
  const targets = readTargetsFile();
  const selection = resolveProvisionSelection(parsed, {
    targets: listTargetKeys(targets),
    interactive: false,
  });
  const outcome = await runProvision(
    {
      target: selection.target,
      environment: selection.environment,
      mode: parsed.mode,
      confirm: parsed.confirm,
    },
    {
      loadTargets: () => readTargetsFile(),
      writeTargets: (file) => {
        writeFileSync(targetsPath(), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      },
      log: (message) => {
        console.log(message);
      },
    },
    (command, args, scope) =>
      runProvisionCommand(
        command,
        args,
        scope?.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      ),
  );
  if (outcome.configUpdated) {
    console.log(
      'provisioning staged deploy/targets.json: review the diff, then commit it before deploying.',
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
