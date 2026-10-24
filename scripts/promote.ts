import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  removeTempWranglerConfig,
  writeTempPromotionWranglerConfig,
} from './deploy/materialize.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentTarget,
  type DeploymentTarget,
} from './deploy/environment-config.js';
import { formatPreflightError, preflightFailed, runPreflight } from './deploy/preflight.js';
import {
  promotionSmokeCommand,
  runPromotion,
  smokeEnvironment,
  type DeployCommandRunner,
} from './deploy/orchestrate.js';
import { parseWorkerVersions, type WorkerVersionSummary } from './deploy/versions.js';
import { selectWithKeys } from './deploy/prompt.js';
import type { DeployableEnvironment } from './deploy/naming.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function preparePromotionVersions(value: unknown): {
  readonly versions: WorkerVersionSummary[];
  readonly display: string[];
} {
  const versions = parseWorkerVersions(value);
  const latest = [...versions].sort((left, right) => right.createdOn.localeCompare(left.createdOn));
  return {
    versions: latest,
    display: latest.map(
      (version) =>
        `${version.tag ?? 'untagged'} — ${version.id} — ${new Date(version.createdOn).toISOString()}`,
    ),
  };
}

export interface PromotionSmokeChild {
  on(event: 'error', listener: (error: Error) => void): this;
  on(event: 'close', listener: (code: number | null) => void): this;
}

export type PromotionSmokeSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly env: NodeJS.ProcessEnv; readonly stdio: 'inherit' },
) => PromotionSmokeChild;

export function runPromotionSmoke(
  resolved: DeploymentTarget,
  baseUrl: string = resolved.workerUrl,
  spawnFn: PromotionSmokeSpawn = (command, args, options) =>
    spawn(process.platform === 'win32' ? `${command}.cmd` : command, [...args], options),
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [command, commandArgs] = promotionSmokeCommand(resolved.environment);
    const child = spawnFn(command, commandArgs, {
      env: smokeEnvironment({ ...resolved, workerUrl: baseUrl }),
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Sandbox smoke failed.'));
    });
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  const environments = [
    'sandbox',
    'production',
  ] as const satisfies readonly DeployableEnvironment[];
  const environmentOption = option('--env');
  const environment =
    environmentOption ??
    environments[await selectPromotionChoice('Select promotion environment', environments)];
  if (environment === undefined) throw new Error('No promotion environment selected.');
  // Promotion intentionally resolves only target identity. The selected
  // immutable version already contains its compiled application profile;
  // current non-secret environment values must not be re-materialized here.
  const resolved = resolveEnvironmentTarget(
    loadEnvironmentFile(environmentFilePath(repoRoot, environment)),
    { requireRemoteReady: true },
  );
  const directory = mkdtempSync(join(tmpdir(), 'user-service-promote-'));
  let configPath = '';
  try {
    configPath = writeTempPromotionWranglerConfig(resolved, directory);
    const run: DeployCommandRunner = async (command, commandArgs) => {
      try {
        const { stdout } = await execFileAsync(command, commandArgs, {
          env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: resolved.accountId },
        });
        return { exitCode: 0, stdout };
      } catch {
        return { exitCode: 1, stdout: '' };
      }
    };
    const listed = await run('npx', [
      'wrangler',
      'versions',
      'list',
      '--json',
      '--config',
      configPath,
    ]);
    if (listed.exitCode !== 0) throw new Error('Unable to list Worker versions.');
    const prepared = preparePromotionVersions(JSON.parse(listed.stdout ?? '[]') as unknown);
    if (prepared.versions.length === 0) throw new Error('No Worker versions are available.');
    const selectedIndex = await selectPromotionChoice(
      'Select immutable Worker version',
      prepared.display,
    );
    const selected = prepared.versions[selectedIndex];
    if (selected === undefined) throw new Error('No immutable Version ID selected.');
    let confirm = option('--confirm');
    if (resolved.environment === 'production') {
      if (confirm === undefined) {
        const readline = createInterface({ input: process.stdin, output: process.stdout });
        try {
          confirm = await readline.question(
            `Type exactly "${resolved.workerName}" to promote production: `,
          );
        } finally {
          readline.close();
        }
      }
    }
    await runPromotion(
      { resolved, versionId: selected.id, confirm },
      {
        materialize: () => configPath,
        cleanup: removeTempWranglerConfig,
        preflight: async (deployment) => {
          const checks = await runPreflight(
            { resolved: deployment },
            {
              nodeVersion: process.version,
              commands: [],
              run: async (command, commandArgs) => {
                try {
                  const { stdout } = await execFileAsync(command, commandArgs, {
                    env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: deployment.accountId },
                  });
                  return { exitCode: 0, stdout };
                } catch {
                  return { exitCode: 1, stdout: '' };
                }
              },
            },
          );
          if (preflightFailed(checks)) throw formatPreflightError(checks);
        },
        log: console.log,
        smoke: (_deployment, versionUrl) => runPromotionSmoke(resolved, versionUrl),
      },
      run,
    );
  } finally {
    if (configPath) removeTempWranglerConfig(configPath);
    rmSync(directory, { recursive: true, force: true });
  }
}

function isInteractive(): boolean {
  return (
    process.stdin.isTTY && process.stdout.isTTY && typeof process.stdin.setRawMode === 'function'
  );
}

async function selectPromotionChoice(
  question: string,
  choices: readonly string[],
): Promise<number> {
  if (isInteractive()) {
    return selectWithKeys(process.stdin, process.stdout, question, choices);
  }

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    choices.forEach((choice, index) => {
      process.stdout.write(`${String(index + 1)}. ${choice}\n`);
    });
    const answer = (await readline.question(`${question} [1-${String(choices.length)}]: `)).trim();
    const selected = Number(answer) - 1;
    if (!Number.isInteger(selected) || selected < 0 || selected >= choices.length) {
      throw new Error('No valid promotion selection was provided.');
    }
    return selected;
  } finally {
    readline.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'unknown promotion failure');
    process.exitCode = 1;
  });
}
