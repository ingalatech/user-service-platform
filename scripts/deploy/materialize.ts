import { rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ResolvedDeployment } from './environment-config.js';

// Temporary Wrangler materialization (ticket #78, ADR-0008).
//
// The deployer derives one target-specific Wrangler config from the base
// application config plus the selected deployment target, so Worker name, D1
// binding and non-secret deployment vars are target/environment-specific
// while application code keeps using the stable `DB` binding. The generated
// file is temporary: the orchestrator removes it even when deployment fails,
// and it is never committed.
//
// Base application values below mirror the top-level `wrangler.jsonc`
// (`deploy-materialize.test.ts` fails on drift so the two cannot diverge
// silently). The base file keeps no remote `env` sections: every remote
// deploy goes through this materialization path.
export const BASE_WORKER_MAIN = 'src/index.ts';
export const BASE_COMPATIBILITY_DATE = '2026-08-22';
export const BASE_COMPATIBILITY_FLAGS: readonly string[] = ['nodejs_compat'];
export const BASE_OBSERVABILITY: { readonly enabled: true } = { enabled: true };
// Administration SPA assets (ticket #124, ADR-0012). The base
// `wrangler.jsonc` serves the built `admin/dist` directory through the
// `ASSETS` binding; materialized target configs carry the same binding with
// an absolute repository path (ticket #85 anchoring) so every environment
// serves identical built assets.
export const BASE_ASSETS_DIRECTORY = 'admin/dist';
export const BASE_ASSETS_BINDING = 'ASSETS';

// Repository-anchored file resolution (ticket #85, ADR-0008).
//
// Wrangler resolves `main` and `migrations_dir` relative to the Wrangler
// config file. The deployer materializes a target-specific config into an OS
// temporary directory, so relative entries would resolve under that temp
// directory (`/tmp/user-service-deploy-.../drizzle`) instead of the versioned
// repository source. Materialized configs therefore carry absolute paths
// derived deterministically from this module's location (never from
// `process.cwd()` or the temp directory), pointing at the single versioned
// source under `./drizzle`. No migration files are copied, rewritten, or
// generated.
export function resolveRepoRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

export function resolveRepoMigrationsDir(repoRoot: string = resolveRepoRoot()): string {
  return join(resolve(repoRoot), 'drizzle');
}

export function resolveRepoWorkerMain(repoRoot: string = resolveRepoRoot()): string {
  return join(resolve(repoRoot), BASE_WORKER_MAIN);
}

export function resolveRepoAdminDistDir(repoRoot: string = resolveRepoRoot()): string {
  return join(resolve(repoRoot), BASE_ASSETS_DIRECTORY);
}

export interface MaterializeOptions {
  readonly repoRoot?: string;
}

export interface TargetAssets {
  readonly directory: string;
  readonly binding: typeof BASE_ASSETS_BINDING;
  readonly run_worker_first: true;
  readonly html_handling: 'none';
}

export interface TargetD1Binding {
  readonly binding: 'DB';
  readonly database_name: string;
  readonly database_id: string;
  readonly migrations_dir: string;
}

export interface TargetWranglerConfig {
  readonly name: string;
  readonly account_id?: string;
  readonly main: string;
  readonly compatibility_date: typeof BASE_COMPATIBILITY_DATE;
  readonly compatibility_flags: readonly string[];
  readonly vars: Record<string, string>;
  readonly observability: { readonly enabled: true };
  readonly assets: TargetAssets;
  readonly d1_databases: readonly [TargetD1Binding];
}

export function buildTargetWranglerConfig(
  resolved: ResolvedDeployment,
  options: MaterializeOptions = {},
): TargetWranglerConfig {
  const repoRoot = options.repoRoot === undefined ? resolveRepoRoot() : resolve(options.repoRoot);
  const main = resolveRepoWorkerMain(repoRoot);
  const migrationsDir = resolveRepoMigrationsDir(repoRoot);
  const adminDistDir = resolveRepoAdminDistDir(repoRoot);
  if (!isAbsolute(main) || !isAbsolute(migrationsDir) || !isAbsolute(adminDistDir)) {
    throw new Error('Materialized Wrangler paths must be absolute.');
  }
  const config: TargetWranglerConfig = {
    name: resolved.workerName,
    ...(resolved.accountId === undefined ? {} : { account_id: resolved.accountId }),
    main,
    compatibility_date: BASE_COMPATIBILITY_DATE,
    compatibility_flags: [...BASE_COMPATIBILITY_FLAGS],
    vars: { ENVIRONMENT: resolved.environment, ...resolved.vars },
    observability: { ...BASE_OBSERVABILITY },
    assets: {
      directory: adminDistDir,
      binding: BASE_ASSETS_BINDING,
      run_worker_first: true,
      html_handling: 'none',
    },
    d1_databases: [
      {
        binding: 'DB',
        database_name: resolved.databaseName,
        database_id: resolved.databaseId,
        migrations_dir: migrationsDir,
      },
    ],
  };
  return config;
}

// Writes the materialized config into an operator-provided directory (the
// orchestrator creates an OS temporary directory) and returns its path.
export function writeTempWranglerConfig(
  resolved: ResolvedDeployment,
  directory: string,
  options: MaterializeOptions = {},
): string {
  const path = join(directory, `wrangler.${resolved.workerName}.json`);
  writeFileSync(
    path,
    `${JSON.stringify(buildTargetWranglerConfig(resolved, options), null, 2)}\n`,
    'utf8',
  );
  return path;
}

// Best-effort removal: cleanup runs in `finally` after both success and
// failure, so a missing file (or read-only directory) must never mask the
// deployment outcome.
export function removeTempWranglerConfig(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // Intentionally silent: temporary-file hygiene never fails a deployment.
  }
}
