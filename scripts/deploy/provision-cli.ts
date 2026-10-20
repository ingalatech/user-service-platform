import { parseDeployEnvironment, type DeployableEnvironment } from './naming.js';

// Provision CLI selection (ticket #80).
//
// One entry point for first-time target provisioning:
//
// ```bash
// npm run provision -- --env sandbox --plan
// npm run provision -- --env sandbox --apply
// ```
//
// Plan is the default no-mutation mode when neither `--plan` nor `--apply`
// is supplied. Production `--apply` requires `--confirm` equal to the target
// Worker name; the orchestration boundary enforces it before any remote
// mutation, while production planning stays read-only without confirmation.
//
// This module only parses and validates the selection. It never reads secret
// values: the only environment values consulted are the non-secret
// `PROVISION_ENV` and `PROVISION_CONFIRM` automation
// selectors. Secret values are never accepted as CLI flags.

export type ProvisionMode = 'plan' | 'apply';

export interface ProvisionArgs {
  readonly environment: DeployableEnvironment | undefined;
  readonly mode: ProvisionMode;
  readonly confirm: string | undefined;
  readonly help: boolean;
}

export interface ProvisionArgEnv {
  readonly PROVISION_ENV?: string;
  readonly PROVISION_CONFIRM?: string;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--env',
  '--plan',
  '--apply',
  '--confirm',
  '--help',
]);

function readValue(flag: string, argv: string[], index: number): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}.`);
  }
  return value;
}

function nonEmpty(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function parseProvisionArgs(argv: string[], env: ProvisionArgEnv = {}): ProvisionArgs {
  let environment = nonEmpty(env.PROVISION_ENV);
  let confirm = nonEmpty(env.PROVISION_CONFIRM);
  let plan = false;
  let apply = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown provision flag "${flag ?? '(missing)'}": see --help.`);
    }
    if (flag === '--env') {
      environment = readValue(flag, argv, index + 1);
      index += 1;
    } else if (flag === '--confirm') {
      confirm = readValue(flag, argv, index + 1);
      index += 1;
    } else if (flag === '--plan') {
      plan = true;
    } else if (flag === '--apply') {
      apply = true;
    } else if (flag === '--help') {
      help = true;
    }
  }

  if (plan && apply) {
    throw new Error('Conflicting provision modes: pass either --plan or --apply, not both.');
  }

  return {
    environment: environment === undefined ? undefined : parseDeployEnvironment(environment),
    mode: apply ? 'apply' : 'plan',
    confirm,
    help,
  };
}

export interface ProvisionSelectionContext {
  readonly interactive: boolean;
}

export interface ProvisionSelection {
  readonly environment: DeployableEnvironment;
}

export function resolveProvisionSelection(
  args: ProvisionArgs,
  context: ProvisionSelectionContext,
): ProvisionSelection {
  if (args.environment === undefined) {
    if (context.interactive) {
      throw new Error('No provisioning environment selected.');
    }
    throw new Error(
      'Missing provisioning environment: pass --env <sandbox|production> or set PROVISION_ENV.',
    );
  }
  return { environment: args.environment };
}

export const PROVISION_HELP = `Usage: npm run provision -- [options]

Options:
  --env <sandbox|production>  Canonical environment (staging is never offered)
  --plan                      Report intended changes without remote mutation (default)
  --apply                     Create/adopt declared dependencies and stage non-secret ids
  --confirm <worker-name>     Required for production apply: the target Worker name
  --help                      Show this help

Automation: PROVISION_ENV and PROVISION_CONFIRM select the
same inputs without prompts. Provisioning never reads, writes, copies or
prints secret values, never deploys application code, and never commits.
`;
