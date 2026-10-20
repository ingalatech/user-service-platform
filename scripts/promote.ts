import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { removeTempWranglerConfig, writeTempWranglerConfig } from './deploy/materialize.js';
import { formatPreflightError, preflightFailed, runPreflight } from './deploy/preflight.js';
import { runPromotion, type DeployCommandRunner } from './deploy/orchestrate.js';
import { listTargetKeys, loadTargetsFile, resolveTargetDeployment } from './deploy/targets.js';
import {
  applyAccountOverrides,
  loadAccountOverrides,
  resolveCloudflareAccountId,
} from './deploy/account-config.js';

const execFileAsync = promisify(execFile);
const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

async function main(): Promise<void> {
  const targetsFile = loadTargetsFile(
    JSON.parse(readFileSync(join(repoRoot, 'deploy/targets.json'), 'utf8')) as unknown,
  );
  const overridesPath = join(repoRoot, 'deploy/targets.local.json');
  const targets = applyAccountOverrides(
    targetsFile,
    loadAccountOverrides(
      existsSync(overridesPath)
        ? (JSON.parse(readFileSync(overridesPath, 'utf8')) as unknown)
        : { version: 1, targets: {} },
    ),
    process.env.CLOUDFLARE_ACCOUNT_ID,
  );
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const args = process.argv.slice(2);
  const option = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index < 0 ? undefined : args[index + 1];
  };
  try {
    const target =
      option('--target') ??
      listTargetKeys(targets)[Number(await readline.question('Select target number: ')) - 1];
    const environment =
      option('--env') ?? (await readline.question('Environment (sandbox/production): ')).trim();
    const targetDeployment = resolveTargetDeployment(targets, { target, environment });
    const resolved = {
      ...targetDeployment,
      accountId: resolveCloudflareAccountId(
        targetDeployment.accountId ?? '',
        undefined,
        process.env.CLOUDFLARE_ACCOUNT_ID,
      ),
    };
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
      const versions: unknown = JSON.parse(listed.stdout ?? '[]');
      if (!Array.isArray(versions) || versions.length === 0)
        throw new Error('No Worker versions are available.');
      versions.forEach((version: unknown, index: number) => {
        if (typeof version === 'object' && version !== null) {
          const record = version as Record<string, unknown>;
          const field = (name: string): string => {
            const value = record[name];
            return typeof value === 'string' ? value : '';
          };
          console.log(
            `${String(index + 1)}) ${field('version_id') || 'unknown'} ${field('created_on')} ${field('message')}`,
          );
        }
      });
      const selected = versions[Number(await readline.question('Select version number: ')) - 1] as
        Record<string, unknown> | undefined;
      if (typeof selected?.version_id !== 'string')
        throw new Error('No immutable Version ID selected.');
      let confirm = option('--confirm');
      if (resolved.environment === 'production') {
        confirm ??= await readline.question(
          `Type exactly "${resolved.workerName}" to promote production: `,
        );
      }
      await runPromotion(
        { resolved, versionId: selected.version_id, confirm },
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
          smoke: async () => {
            await new Promise<void>((resolve, reject) => {
              const child = spawn('npm', ['run', 'smoke:sandbox'], {
                env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: resolved.accountId },
                stdio: 'inherit',
              });
              child.on('error', reject);
              child.on('close', (code) => {
                if (code === 0) resolve();
                else reject(new Error('Sandbox smoke failed.'));
              });
            });
          },
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
