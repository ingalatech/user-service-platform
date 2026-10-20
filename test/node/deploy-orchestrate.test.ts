import { describe, expect, it } from 'vitest';
import {
  planDeploymentSteps,
  promotionSmokeCommand,
  productionConfirmFor,
  runPromotion,
  runDeployment,
  type DeployCommandRunner,
  type DeployIo,
} from '../../scripts/deploy/orchestrate.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';

const SANDBOX: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  vars: { AUTH_MAIL_TRANSPORT: 'resend' },
};

const PRODUCTION: ResolvedDeployment = {
  ...SANDBOX,
  environment: 'production',
  workerName: 'rch-rugbychampagne-user-service-production',
  databaseName: 'rch-rugbychampagne-user-service-production-db',
  databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
};

const CANARY = 'canary-deploy-secret-abcdef123456';

interface Harness {
  io: DeployIo;
  runner: DeployCommandRunner;
  commands: { command: string; args: string[] }[];
  removed: string[];
  logs: string[];
  preflightCalls: number;
}

function createHarness(failOn?: RegExp, failPreflight = false): Harness {
  const commands: { command: string; args: string[] }[] = [];
  const removed: string[] = [];
  const logs: string[] = [];
  const harness: Harness = {
    io: {
      materialize: () => '/tmp/wrangler.deploy-test.json',
      cleanup: (path) => {
        removed.push(path);
      },
      preflight: () => {
        harness.preflightCalls += 1;
        if (failPreflight) {
          return Promise.reject(
            new Error('Deployment preflight failed: worktree: worktree has uncommitted changes.'),
          );
        }
        return Promise.resolve(undefined);
      },
      log: (message) => {
        logs.push(message);
      },
    },
    runner: (command, args) => {
      commands.push({ command, args: [...args] });
      const text = `${command} ${args.join(' ')}`;
      if (failOn?.test(text) === true) {
        return Promise.resolve({ exitCode: 1 });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: text.includes('wrangler versions list')
          ? '[{"id":"v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{"workers/message":"test"}}]'
          : '',
      });
    },
    commands,
    removed,
    logs,
    preflightCalls: 0,
  };
  return harness;
}

// Deployment orchestration (ticket #78): migrations precede Worker deployment,
// sandbox records the deployment and runs smoke, production needs an explicit
// confirmation and is never an automatic side effect. Temporary configs are
// always removed, even on failure.
describe('deployment orchestration', () => {
  it('selects the non-mutating smoke command per promotion environment', () => {
    expect(promotionSmokeCommand('sandbox')).toEqual(['npm', ['run', 'smoke:sandbox']]);
    expect(promotionSmokeCommand('production')).toEqual(['npm', ['run', 'smoke:production']]);
  });
  it('plans the sandbox release in migration-first order with smoke last', () => {
    expect(planDeploymentSteps({ resolved: SANDBOX })).toEqual([
      'preflight',
      'build-admin-assets',
      'validate-migrations-local',
      'migrate-remote',
      'deploy-worker',
      'record-deployment',
      'smoke-sandbox',
    ]);
  });

  it('plans production without smoke but with the deployment record', () => {
    const steps = planDeploymentSteps({
      resolved: PRODUCTION,
      confirm: productionConfirmFor(PRODUCTION),
    });
    expect(steps).toEqual([
      'preflight',
      'build-admin-assets',
      'validate-migrations-local',
      'migrate-remote',
      'deploy-worker',
      'record-deployment',
    ]);
  });

  it('requires the production confirmation to equal the target Worker name', () => {
    expect(productionConfirmFor(PRODUCTION)).toBe('rch-rugbychampagne-user-service-production');
  });

  it('refuses production without confirmation before any remote mutation', async () => {
    const harness = createHarness();
    await expect(
      runDeployment({ resolved: PRODUCTION }, harness.io, harness.runner),
    ).rejects.toThrow(/rch-rugbychampagne-user-service-production/);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('refuses production with the wrong confirmation before any remote mutation', async () => {
    const harness = createHarness();
    await expect(
      runDeployment({ resolved: PRODUCTION, confirm: 'PROMOTE' }, harness.io, harness.runner),
    ).rejects.toThrow(/confirmation/);
    expect(harness.commands).toEqual([]);
  });

  it('runs migrations before Worker deployment for sandbox', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const migrateIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    const deployIndex = text.findIndex((entry) => entry.includes('wrangler deploy'));
    const smokeIndex = text.findIndex((entry) => entry.includes('smoke:sandbox'));
    expect(migrateIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(migrateIndex);
    expect(smokeIndex).toBe(-1);
    expect(text.some((entry) => entry.includes('--config /tmp/wrangler.deploy-test.json'))).toBe(
      true,
    );
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('uploads a candidate for an existing Worker without changing traffic', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    expect(text.some((entry) => entry.includes('wrangler versions upload'))).toBe(true);
    expect(text.some((entry) => entry.includes('wrangler deploy --config'))).toBe(false);
    expect(text.some((entry) => entry.includes('smoke:sandbox'))).toBe(false);
    expect(harness.logs).toContain(
      'candidate uploaded; stable-origin smoke is deferred until promotion',
    );
  });

  it('keeps stable-origin smoke for the explicitly confirmed first deployment', async () => {
    const harness = createHarness();
    const io: DeployIo = {
      ...harness.io,
      confirmFirstDeployment: () => Promise.resolve(true),
    };
    const runner: DeployCommandRunner = (command, args) => {
      harness.commands.push({ command, args: [...args] });
      return Promise.resolve({
        exitCode: 0,
        stdout: args.includes('versions') && args.includes('list') ? '[]' : '',
      });
    };

    await runDeployment({ resolved: SANDBOX }, io, runner);

    expect(harness.commands.some(({ args }) => args.includes('smoke:sandbox'))).toBe(true);
  });

  it('requires explicit confirmation before the unavoidable first active deployment', async () => {
    const harness = createHarness();
    const commands: string[] = [];
    const io: DeployIo = {
      ...harness.io,
      confirmFirstDeployment: () => Promise.resolve(false),
    };
    const runner: DeployCommandRunner = (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      return Promise.resolve({
        exitCode: 0,
        stdout: args.includes('list') ? '[]' : '',
      });
    };
    await expect(runDeployment({ resolved: SANDBOX }, io, runner)).rejects.toThrow(
      /first deployment cancelled/i,
    );
    expect(commands.some((entry) => entry.includes('wrangler deploy --config'))).toBe(false);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('promotes only the selected existing version to 100% and does not build or migrate', async () => {
    const harness = createHarness();
    const commands: string[] = [];
    await runPromotion(
      { resolved: SANDBOX, versionId: 'immutable-v1' },
      {
        materialize: () => '/tmp/promotion.json',
        cleanup: (path) => harness.removed.push(path),
        preflight: () => Promise.resolve(),
        log: (message) => harness.logs.push(message),
        smoke: () => {
          commands.push('smoke');
          return Promise.resolve();
        },
      },
      (_command, args) => {
        commands.push(args.join(' '));
        return Promise.resolve(
          args.includes('list')
            ? {
                exitCode: 0,
                stdout:
                  '[{"id":"immutable-v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{"workers/tag":"candidate"}}]',
              }
            : { exitCode: 0 },
        );
      },
    );
    expect(commands).toEqual([
      'wrangler versions list --json --config /tmp/promotion.json',
      'wrangler versions deploy immutable-v1@100% --config /tmp/promotion.json',
      'smoke',
    ]);
    expect(harness.removed).toContain('/tmp/promotion.json');
  });

  it('promotes production and runs the non-mutating production smoke after routing', async () => {
    const harness = createHarness();
    const commands: string[] = [];
    await runPromotion(
      { resolved: PRODUCTION, versionId: 'immutable-v1', confirm: PRODUCTION.workerName },
      {
        materialize: () => '/tmp/production-promotion.json',
        cleanup: (path) => harness.removed.push(path),
        preflight: () => Promise.resolve(),
        log: (message) => harness.logs.push(message),
        smoke: () => {
          commands.push('smoke:production');
          return Promise.resolve();
        },
      },
      (_command, args) => {
        commands.push(args.join(' '));
        return Promise.resolve(
          args.includes('list')
            ? {
                exitCode: 0,
                stdout:
                  '[{"id":"immutable-v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{}}]',
              }
            : { exitCode: 0 },
        );
      },
    );
    expect(commands).toEqual([
      'wrangler versions list --json --config /tmp/production-promotion.json',
      'wrangler versions deploy immutable-v1@100% --config /tmp/production-promotion.json',
      'smoke:production',
    ]);
  });

  it('builds the administration assets before any remote mutation (ticket #124)', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const buildIndex = text.findIndex((entry) => entry === 'npm run build:admin');
    const remoteIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThan(buildIndex);
  });

  it('aborts before remote mutation when the administration build fails', async () => {
    const harness = createHarness(/npm run build:admin/);
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /build-admin-assets/,
    );
    expect(harness.commands).toEqual([
      {
        command: 'npx',
        args: [
          'wrangler',
          'versions',
          'list',
          '--json',
          '--config',
          '/tmp/wrangler.deploy-test.json',
        ],
      },
      { command: 'npm', args: ['run', 'build:admin'] },
    ]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('validates migrations locally before remote mutation', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.io, harness.runner);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const localIndex = text.findIndex((entry) => entry.includes('migrations apply DB --local'));
    const remoteIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeLessThan(remoteIndex);
  });

  it('removes the temporary config even when deployment fails', async () => {
    const harness = createHarness(/wrangler versions upload/);
    await expect(runDeployment({ resolved: SANDBOX }, harness.io, harness.runner)).rejects.toThrow(
      /deploy-worker/,
    );
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('runs zero remote commands for a dry run', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
    expect(harness.logs.join('\n')).toContain('rch-rugbychampagne-user-service-sandbox');
  });

  it('executes the read-only preflight on a dry run without mutating commands', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('fails the dry run when preflight fails and still cleans up', async () => {
    const harness = createHarness(undefined, true);
    await expect(
      runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner),
    ).rejects.toThrow(/preflight/);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands).toEqual([]);
    expect(harness.removed).toEqual(['/tmp/wrangler.deploy-test.json']);
  });

  it('never logs secret values while summarizing the deployment', async () => {
    const harness = createHarness();
    process.env.DEPLOY_CLI_CANARY = CANARY;
    try {
      await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.io, harness.runner);
    } finally {
      delete process.env.DEPLOY_CLI_CANARY;
    }
    expect(harness.logs.join('\n')).not.toContain(CANARY);
  });
});
