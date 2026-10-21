import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BASE_ASSETS_BINDING,
  BASE_ASSETS_DIRECTORY,
  BASE_COMPATIBILITY_DATE,
  BASE_COMPATIBILITY_FLAGS,
  BASE_OBSERVABILITY,
  BASE_WORKER_MAIN,
  buildTargetWranglerConfig,
  removeTempWranglerConfig,
  resolveRepoAdminDistDir,
  resolveRepoMigrationsDir,
  resolveRepoRoot,
  resolveRepoWorkerMain,
  writeTempWranglerConfig,
} from '../../scripts/deploy/materialize.js';
import { COMPILED_CONFIG_DEFINE_NAME } from '../../src/config/index.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';

const SANDBOX_RESOLVED: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  workerUrl: 'https://sandbox.example.test',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  applicationConfig: {
    ENVIRONMENT: 'sandbox',
    AUTH_REGISTRATION_ENABLED: 'true',
    AUTH_EMAIL_PASSWORD_ENABLED: 'true',
    AUTH_REQUIRE_EMAIL_VERIFICATION: 'true',
    AUTH_MAIL_TRANSPORT: 'resend',
    AUTH_MAIL_FROM: 'User Service <jg@ingalatech.com>',
    AUTH_APP_NAME: 'User Service',
    AUTH_MAIL_ALLOWLIST: 'jonatangarbuyo@gmail.com,jg@ingalatech.com',
    AUTH_VERIFY_EMAIL_ACTION_URL: '',
    AUTH_RESET_PASSWORD_ACTION_URL: '',
    AUTH_JWT_ISSUER: '',
    AUTH_JWT_AUDIENCE: '',
    AUTH_JWT_TTL_SECONDS: '',
    AUTH_GATEWAY_ORIGINS: '',
    SMTP_HOST: '',
    SMTP_PORT: '',
    SMTP_SECURE: '',
  },
};

// Temporary Wrangler materialization (ticket #78): the deployer derives one
// target-specific config from the base application config plus the selected
// target. Application code keeps using the stable `DB` binding while the
// physical D1 stays target-specific.
describe('wrangler config materialization', () => {
  it('tracks the base application config instead of drifting from it', () => {
    const base = readFileSync('wrangler.jsonc', 'utf8');
    expect(base).toContain(`"compatibility_date": "${BASE_COMPATIBILITY_DATE}"`);
    for (const flag of BASE_COMPATIBILITY_FLAGS) {
      expect(base).toContain(flag);
    }
    expect(base).toContain(`"main": "${BASE_WORKER_MAIN}"`);
    expect(BASE_OBSERVABILITY).toEqual({ enabled: true });
    expect(base).toContain('"enabled": true');
    // Ticket #124: the base config serves the built administration SPA
    // through the stable ASSETS binding; materialized target configs must
    // carry the same binding (asserted below).
    expect(base).toContain(`"directory": "./${BASE_ASSETS_DIRECTORY}"`);
    expect(base).toContain(`"binding": "${BASE_ASSETS_BINDING}"`);
  });

  it('materializes a target-specific config with the stable DB binding', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    const expectedMigrationsDir = resolveRepoMigrationsDir();
    const expectedMain = resolveRepoWorkerMain();
    expect(config.name).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(config.main).toBe(expectedMain);
    expect(config.d1_databases).toEqual([
      {
        binding: 'DB',
        database_name: 'rch-rugbychampagne-user-service-sandbox-db',
        database_id: CONTRACT_SANDBOX_DATABASE_ID,
        migrations_dir: expectedMigrationsDir,
      },
    ]);
    expect(config.define[COMPILED_CONFIG_DEFINE_NAME]).toBe(
      JSON.stringify(SANDBOX_RESOLVED.applicationConfig),
    );
    expect('vars' in config).toBe(false);
  });

  it('compiles the complete application profile without secret names', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    const compiled = config.define[COMPILED_CONFIG_DEFINE_NAME];
    expect(compiled).toBe(JSON.stringify(SANDBOX_RESOLVED.applicationConfig));
    expect(compiled).toContain('AUTH_MAIL_TRANSPORT');
    expect(compiled).not.toMatch(
      /BETTER_AUTH_SECRET|RESEND_API_KEY|SMTP_USER|SMTP_PASSWORD|CLOUDFLARE_API_TOKEN/,
    );
  });

  it('materializes distinct compiled profiles for sandbox and production', () => {
    const productionProfile = { ...SANDBOX_RESOLVED.applicationConfig, ENVIRONMENT: 'production' };
    const production = buildTargetWranglerConfig({
      ...SANDBOX_RESOLVED,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      databaseName: 'rch-rugbychampagne-user-service-production-db',
      databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
      applicationConfig: productionProfile,
    });
    expect(production.define[COMPILED_CONFIG_DEFINE_NAME]).toBe(JSON.stringify(productionProfile));
    expect(production.define[COMPILED_CONFIG_DEFINE_NAME]).not.toBe(
      JSON.stringify(SANDBOX_RESOLVED.applicationConfig),
    );
  });

  it('retains the compiled profile values in the Wrangler define entry', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    const compiled = JSON.parse(config.define[COMPILED_CONFIG_DEFINE_NAME]) as Record<
      string,
      string
    >;
    expect(compiled).toMatchObject({
      ENVIRONMENT: 'sandbox',
      AUTH_MAIL_TRANSPORT: 'resend',
      AUTH_MAIL_FROM: 'User Service <jg@ingalatech.com>',
      AUTH_MAIL_ALLOWLIST: 'jonatangarbuyo@gmail.com,jg@ingalatech.com',
    });
  });

  it('materializes the selected Cloudflare account as Wrangler account_id', () => {
    const config = buildTargetWranglerConfig({
      ...SANDBOX_RESOLVED,
      accountId: '22222222222222222222222222222222',
    });
    expect(config.account_id).toBe('22222222222222222222222222222222');
  });

  it('serves the same built administration assets on every target (ticket #124)', () => {
    // Local and generated target-specific deploy configurations include the
    // same built assets: the stable ASSETS binding with an absolute
    // repository path to the single `admin/dist` build output.
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    expect(config.assets).toEqual({
      directory: resolveRepoAdminDistDir(),
      binding: 'ASSETS',
      run_worker_first: true,
      html_handling: 'none',
    });
    expect(isAbsolute(config.assets.directory)).toBe(true);
    expect(config.assets.directory).toBe(resolveRepoAdminDistDir(resolveRepoRoot()));
    expect(config.assets.directory.endsWith(BASE_ASSETS_DIRECTORY)).toBe(true);
  });

  it('anchors repository files to absolute repo paths, not the temp config directory', () => {
    // Ticket #85: Wrangler resolves `main` and `migrations_dir` relative to
    // the config file, so a temp config must carry absolute repository paths.
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    const migrationsDir = config.d1_databases[0].migrations_dir;
    expect(isAbsolute(migrationsDir)).toBe(true);
    expect(isAbsolute(config.main)).toBe(true);
    expect(basename(migrationsDir)).toBe('drizzle');
    expect(config.main.endsWith(BASE_WORKER_MAIN)).toBe(true);
    expect(resolve(config.main)).toBe(config.main);
    expect(resolve(migrationsDir)).toBe(migrationsDir);
    expect(migrationsDir).toBe(resolveRepoMigrationsDir(resolveRepoRoot()));
    expect(config.main).toBe(resolveRepoWorkerMain(resolveRepoRoot()));
  });

  it('does not declare or materialize runtime secrets', () => {
    const config = buildTargetWranglerConfig(SANDBOX_RESOLVED);
    expect('secrets' in config).toBe(false);
    expect(JSON.stringify(config)).not.toMatch(
      /wrangler\s+secret|BETTER_AUTH_SECRET|RESEND_API_KEY|SMTP_USER|SMTP_PASSWORD|CLOUDFLARE_API_TOKEN/,
    );
  });

  it('binds a distinct D1 per target environment while keeping the DB binding', () => {
    const production = buildTargetWranglerConfig({
      ...SANDBOX_RESOLVED,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      databaseName: 'rch-rugbychampagne-user-service-production-db',
      databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
      applicationConfig: { ...SANDBOX_RESOLVED.applicationConfig, ENVIRONMENT: 'production' },
    });
    const sandboxDatabases = (configOf(buildTargetWranglerConfig(SANDBOX_RESOLVED)) ?? []) as {
      database_id: string;
    }[];
    const productionDatabases = (configOf(production) ?? []) as { database_id: string }[];
    expect(sandboxDatabases[0]?.database_id).not.toBe(productionDatabases[0]?.database_id);
    expect(production.define[COMPILED_CONFIG_DEFINE_NAME]).toContain('"ENVIRONMENT":"production"');
  });

  it('writes and removes the temporary config around deployment', () => {
    const directory = mkdtempSync(join(tmpdir(), 'deploy-materialize-test-'));
    try {
      const path = writeTempWranglerConfig(SANDBOX_RESOLVED, directory);
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { name?: unknown };
      expect(parsed.name).toBe('rch-rugbychampagne-user-service-sandbox');
      removeTempWranglerConfig(path);
      expect(() => readFileSync(path, 'utf8')).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('resolves the versioned drizzle source from an OS-temp config location', () => {
    // Ticket #85 acceptance: a config materialized into an OS temp directory
    // must still resolve the repository `./drizzle` files without copying
    // them, independent of the temp directory.
    const first = mkdtempSync(join(tmpdir(), 'deploy-materialize-temp-a-'));
    const second = mkdtempSync(join(tmpdir(), 'deploy-materialize-temp-b-'));
    try {
      const firstPath = writeTempWranglerConfig(SANDBOX_RESOLVED, first);
      const secondPath = writeTempWranglerConfig(SANDBOX_RESOLVED, second);
      try {
        const firstConfig = JSON.parse(readFileSync(firstPath, 'utf8')) as {
          main?: unknown;
          d1_databases?: { migrations_dir?: unknown }[];
        };
        const secondConfig = JSON.parse(readFileSync(secondPath, 'utf8')) as {
          d1_databases?: { migrations_dir?: unknown }[];
        };
        const firstMigrationsDir = firstConfig.d1_databases?.[0]?.migrations_dir;
        const secondMigrationsDir = secondConfig.d1_databases?.[0]?.migrations_dir;
        expect(typeof firstMigrationsDir).toBe('string');
        expect(firstMigrationsDir).toBe(secondMigrationsDir);
        if (typeof firstMigrationsDir !== 'string') {
          throw new Error('Materialized migrations_dir must be a string.');
        }
        // The temp directory itself carries no drizzle copy: relative
        // resolution from the config location would fail.
        expect(existsSync(join(first, 'drizzle'))).toBe(false);
        expect(join(dirname(firstPath), 'drizzle')).not.toBe(firstMigrationsDir);
        // The absolute entry points at the single versioned source.
        expect(isAbsolute(firstMigrationsDir)).toBe(true);
        expect(basename(firstMigrationsDir)).toBe('drizzle');
        expect(existsSync(join(firstMigrationsDir, 'meta', '_journal.json'))).toBe(true);
        expect(existsSync(firstMigrationsDir)).toBe(true);
        // The worker entry is anchored the same way.
        expect(typeof firstConfig.main).toBe('string');
        if (typeof firstConfig.main !== 'string') {
          throw new Error('Materialized main must be a string.');
        }
        expect(isAbsolute(firstConfig.main)).toBe(true);
        expect(existsSync(firstConfig.main)).toBe(true);
      } finally {
        removeTempWranglerConfig(firstPath);
        removeTempWranglerConfig(secondPath);
      }
    } finally {
      rmSync(first, { recursive: true, force: true });
      rmSync(second, { recursive: true, force: true });
    }
  });

  it('tolerates removing an already-missing temporary config', () => {
    expect(() => {
      removeTempWranglerConfig(join(tmpdir(), 'deploy-materialize-missing.json'));
    }).not.toThrow();
  });
});

function configOf(config: unknown): unknown {
  if (typeof config === 'object' && config !== null) {
    return (config as { d1_databases?: unknown }).d1_databases;
  }
  return undefined;
}
