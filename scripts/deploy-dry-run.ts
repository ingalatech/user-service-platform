import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildTargetWranglerConfig } from './deploy/materialize.js';
import {
  environmentFilePath,
  loadEnvironmentFile,
  resolveEnvironmentDeployment,
} from './deploy/environment-config.js';
import { parseDeployArgs } from './deploy/cli.js';

const repoRoot = dirname(fileURLToPath(new URL('.', import.meta.url)));

function executable(name: string): string {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function run(command: string, args: readonly string[]): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable(command), [...args], {
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolvePromise(code ?? 1);
    });
  });
}

async function main(): Promise<void> {
  const args = parseDeployArgs(process.argv.slice(2), { DEPLOY_ENV: process.env.DEPLOY_ENV });
  if (args.help) {
    console.log('Usage: npm run deploy:dry-run -- --env <sandbox|production>');
    return;
  }
  if (args.environment === undefined) {
    throw new Error('Missing deployment environment: pass --env <sandbox|production>.');
  }

  if ((await run('npm', ['run', 'build:admin'])) !== 0) {
    throw new Error('Administration asset build failed.');
  }

  const resolved = resolveEnvironmentDeployment(
    loadEnvironmentFile(environmentFilePath(repoRoot, args.environment)),
    { requireRemoteReady: true },
  );
  const directory = mkdtempSync(join(tmpdir(), 'user-service-deploy-dry-run-'));
  const configPath = resolve(directory, 'wrangler.json');
  try {
    writeFileSync(
      configPath,
      `${JSON.stringify(buildTargetWranglerConfig(resolved, { repoRoot }), null, 2)}\n`,
      'utf8',
    );
    const exitCode = await run('npx', ['wrangler', 'deploy', '--dry-run', '--config', configPath]);
    if (exitCode !== 0) throw new Error('Wrangler dry run failed.');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'unknown deployment dry-run failure');
  process.exitCode = 1;
});
