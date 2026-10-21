import { execFile, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTempWranglerConfig, writeTempWranglerConfig } from './deploy/materialize.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentDeployment,
  type ResolvedDeployment,
} from './deploy/environment-config.js';
import { formatPreflightError, preflightFailed, runPreflight } from './deploy/preflight.js';
import {
  promotionSmokeCommand,
  runPromotion,
  smokeEnvironment,
  type DeployCommandRunner,
} from './deploy/orchestrate.js';
import { parseWorkerVersions, type WorkerVersionSummary } from './deploy/versions.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

export function preparePromotionVersions(value: unknown): {
  readonly versions: WorkerVersionSummary[];
  readonly display: string[];
} {
  const versions = parseWorkerVersions(value);
  return {
    versions,
    display: versions.map(
      (version, index) =>
        `${String(index + 1)}) ${version.id} ${version.createdOn} ${version.annotations}`,
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
  resolved: ResolvedDeployment,
  spawnFn: PromotionSmokeSpawn = (command, args, options) => spawn(command, [...args], options),
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const [command, commandArgs] = promotionSmokeCommand(resolved.environment);
    const child = spawnFn(command, commandArgs, {
      env: smokeEnvironment(resolved),
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
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    const environment =
      option('--env') ?? (await readline.question('Environment (sandbox/production): ')).trim();
    const resolved = resolveEnvironmentDeployment(
      loadEnvironmentFile(environmentFilePath(repoRoot, environment)),
      { requireRemoteReady: true },
    );
    const directory = mkdtempSync(join(tmpdir(), 'user-service-promote-'));
    let configPath = '';
    try {
      configPath = writeTempWranglerConfig(resolved, directory, { repoRoot });
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
      prepared.display.forEach((line) => {
        console.log(line);
      });
      const selected =
        prepared.versions[Number(await readline.question('Select version number: ')) - 1];
      if (selected === undefined) throw new Error('No immutable Version ID selected.');
      let confirm = option('--confirm');
      if (resolved.environment === 'production') {
        confirm ??= await readline.question(
          `Type exactly "${resolved.workerName}" to promote production: `,
        );
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
          smoke: () => runPromotionSmoke(resolved),
        },
        run,
      );
    } finally {
      if (configPath) removeTempWranglerConfig(configPath);
      rmSync(directory, { recursive: true, force: true });
    }
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
