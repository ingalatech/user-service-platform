import { parseDeployEnvironment, type DeployableEnvironment } from './naming.js';

// Remote commands select only a complete, versioned environment file.

export interface DeployArgs {
  readonly environment: DeployableEnvironment | undefined;
  readonly confirm: string | undefined;
  readonly nonInteractive: boolean;
  readonly dryRun: boolean;
  readonly writeConfig: string | undefined;
  readonly help: boolean;
}

export interface DeployArgEnv {
  readonly DEPLOY_TARGET?: string;
  readonly DEPLOY_ENV?: string;
  readonly DEPLOY_CONFIRM?: string;
}

const KNOWN_FLAGS: ReadonlySet<string> = new Set([
  '--env',
  '--confirm',
  '--non-interactive',
  '--dry-run',
  '--write-config',
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

export function parseDeployArgs(argv: string[], env: DeployArgEnv = {}): DeployArgs {
  let environment = nonEmpty(env.DEPLOY_ENV);
  let confirm = nonEmpty(env.DEPLOY_CONFIRM);
  let nonInteractive = false;
  let dryRun = false;
  let writeConfig: string | undefined;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === undefined || !KNOWN_FLAGS.has(flag)) {
      throw new Error(`Unknown deploy flag "${flag ?? '(missing)'}": see --help.`);
    }
    if (flag === '--env') {
      environment = readValue(flag, argv, index + 1);
      index += 1;
    } else if (flag === '--confirm') {
      confirm = readValue(flag, argv, index + 1);
      index += 1;
    } else if (flag === '--write-config') {
      writeConfig = readValue(flag, argv, index + 1);
      index += 1;
    } else if (flag === '--non-interactive') {
      nonInteractive = true;
    } else if (flag === '--dry-run') {
      dryRun = true;
    } else if (flag === '--help') {
      help = true;
    }
  }

  return {
    environment: environment === undefined ? undefined : parseDeployEnvironment(environment),
    confirm,
    nonInteractive,
    dryRun,
    writeConfig,
    help,
  };
}

export interface SelectionContext {
  readonly interactive: boolean;
  readonly targets?: readonly string[];
}

export interface DeploySelection {
  readonly environment: DeployableEnvironment;
}

export function resolveDeploySelection(
  args: DeployArgs,
  context: SelectionContext,
): DeploySelection {
  if (args.environment === undefined) {
    if (context.interactive) {
      throw new Error('No deployment environment selected.');
    }
    throw new Error(
      'Missing deployment environment: pass --env <sandbox|production> or set DEPLOY_ENV.',
    );
  }
  return { environment: args.environment };
}

export const DEPLOY_HELP = `Usage: npm run deploy -- [options]

Options:
  --env <sandbox|production>  Canonical environment (staging is never offered)
  --confirm <worker-name>     Required for production: the target Worker name
  --non-interactive           Fail instead of prompting (automation/CI)
  --dry-run                   Resolve, preflight and print the plan without mutation
  --write-config <path>       Materialize the target Wrangler config and exit
  --help                      Show this help

Automation: DEPLOY_ENV and DEPLOY_CONFIRM select the same
inputs without prompts. Worker secrets stay in Cloudflare and are never read
by this command.
`;
