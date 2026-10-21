import { describe, expect, it } from 'vitest';
import { LOCAL_PROFILE } from '../../src/config/index.js';
import {
  planDeploymentSteps,
  promotionSmokeCommand,
  productionConfirmFor,
  runPromotion,
  runDeployment,
  smokeEnvironment,
  versionUrlForVerifiedVersion,
  type DeployCommandRunner,
  type DeployIo,
} from '../../scripts/deploy/orchestrate.js';
import { parseWorkerVersionDetails } from '../../scripts/deploy/versions.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';
import {
  formatPreflightError,
  preflightFailed,
  runPreflight,
} from '../../scripts/deploy/preflight.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';
import { CLOUDFLARE_ABSENT_WORKER_10007 } from './fixtures/cloudflare-absent-worker.js';

const SANDBOX: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  workerUrl: 'https://sandbox.example.test',
  applicationConfig: { ...LOCAL_PROFILE, ENVIRONMENT: 'sandbox', AUTH_MAIL_TRANSPORT: 'resend' },
};

const PRODUCTION: ResolvedDeployment = {
  ...SANDBOX,
  environment: 'production',
  workerName: 'rch-rugbychampagne-user-service-production',
  databaseName: 'rch-rugbychampagne-user-service-production-db',
  databaseId: CONTRACT_PRODUCTION_DATABASE_ID,
  workerUrl: 'https://production.example.test',
};

const CANARY = 'canary-deploy-secret-abcdef123456';
const VERSION_URL_SANDBOX = {
  ...SANDBOX,
  workerUrl: 'https://rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
};
const VERSION_DETAILS = JSON.stringify({
  id: 'immutable-v1',
  metadata: { created_on: '2026-10-20T12:00:00Z' },
  preview_url:
    'https://authoritative-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
  resources: {
    bindings: [
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'RESEND_API_KEY', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
      { name: 'SMTP_PASSWORD', type: 'secret_text' },
    ],
  },
});
const PRODUCTION_VERSION_DETAILS = VERSION_DETAILS.replaceAll('sandbox', 'production');
const VERIFIED_VERSION = parseWorkerVersionDetails(JSON.parse(VERSION_DETAILS));
const VERIFIED_VERSION_WITHOUT_PREVIEW = parseWorkerVersionDetails({
  id: 'immutable-v1',
  metadata: { created_on: '2026-10-20T12:00:00Z' },
  resources: {
    bindings: [
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'RESEND_API_KEY', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
      { name: 'SMTP_PASSWORD', type: 'secret_text' },
    ],
  },
});

interface Harness {
  io: DeployIo;
  runner: DeployCommandRunner;
  commands: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[];
  removed: string[];
  logs: string[];
  preflightCalls: number;
}

function createHarness(failOn?: RegExp, failPreflight = false): Harness {
  const commands: { command: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
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
    runner: (command, args, options) => {
      commands.push({ command, args: [...args], env: options?.env });
      const text = `${command} ${args.join(' ')}`;
      if (failOn?.test(text) === true) {
        return Promise.resolve({ exitCode: 1 });
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: text.includes('wrangler versions view')
          ? VERSION_DETAILS
          : text.includes('wrangler versions list')
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
    expect(promotionSmokeCommand('sandbox')).toEqual(['npm', ['run', 'smoke:readiness']]);
    expect(promotionSmokeCommand('production')).toEqual(['npm', ['run', 'smoke:production']]);
  });

  it('builds smoke environments from the resolved Worker URL without secrets', () => {
    process.env.SMOKE_SANDBOX_BASE_URL = 'https://inherited.example.test';
    process.env.BETTER_AUTH_SECRET = 'must-not-enter-smoke';
    try {
      expect(smokeEnvironment(SANDBOX)).toEqual({
        PATH: process.env.PATH,
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.test',
      });
      expect(smokeEnvironment(PRODUCTION)).toEqual({
        PATH: process.env.PATH,
        SMOKE_PRODUCTION_BASE_URL: 'https://production.example.test',
      });
    } finally {
      delete process.env.SMOKE_SANDBOX_BASE_URL;
      delete process.env.BETTER_AUTH_SECRET;
    }
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
    const smokeIndex = text.findIndex((entry) => entry.includes('smoke:health'));
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
    expect(text.some((entry) => entry.includes('smoke:health'))).toBe(false);
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
    const runner: DeployCommandRunner = (command, args, options) => {
      harness.commands.push({ command, args: [...args], env: options?.env });
      return Promise.resolve({
        exitCode: 0,
        stdout: args.includes('versions') && args.includes('list') ? '[]' : '',
      });
    };

    await runDeployment({ resolved: SANDBOX }, io, runner);

    expect(harness.commands.some(({ args }) => args.includes('smoke:health'))).toBe(true);
    const smoke = harness.commands.find(({ args }) => args.includes('smoke:health'));
    expect(smoke?.env).toEqual({
      PATH: process.env.PATH,
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.test',
    });
  });

  it('confirms and deploys when versions discovery returns the absent-Worker 10007 fixture', async () => {
    const harness = createHarness();
    const io: DeployIo = {
      ...harness.io,
      confirmFirstDeployment: () => Promise.resolve(true),
    };
    const runner: DeployCommandRunner = (command, args) => {
      harness.commands.push({ command, args: [...args] });
      if (args.includes('versions') && args.includes('list')) {
        return Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: CLOUDFLARE_ABSENT_WORKER_10007,
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    };

    await runDeployment({ resolved: SANDBOX }, io, runner);

    expect(
      harness.commands.some(({ command, args }) =>
        `${command} ${args.join(' ')}`.includes('wrangler deploy'),
      ),
    ).toBe(true);
    expect(harness.logs.join('\n')).not.toContain('script_not_found');
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

  it('runs candidate readiness before deploying the selected immutable version', async () => {
    const harness = createHarness();
    const commands: string[] = [];
    let candidateUrl = '';
    await expect(
      runPromotion(
        { resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' },
        {
          materialize: () => '/tmp/promotion.json',
          cleanup: (path) => harness.removed.push(path),
          preflight: () => Promise.resolve(),
          log: (message) => harness.logs.push(message),
          smoke: (_resolved, versionUrl) => {
            candidateUrl = versionUrl;
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
              : args.includes('view')
                ? { exitCode: 0, stdout: VERSION_DETAILS }
                : { exitCode: 0 },
          );
        },
      ),
    ).resolves.toBeUndefined();
    expect(commands).toEqual([
      'wrangler versions list --json --config /tmp/promotion.json',
      'wrangler versions view --json --version-id immutable-v1 --config /tmp/promotion.json',
      'wrangler versions deploy immutable-v1@100% --config /tmp/promotion.json',
    ]);
    expect(candidateUrl).toBe(
      'https://authoritative-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
    );
    expect(harness.removed).toContain('/tmp/promotion.json');
  });

  it('blocks production promotion before any traffic mutation', async () => {
    const harness = createHarness();
    const commands: string[] = [];
    await expect(
      runPromotion(
        {
          resolved: {
            ...PRODUCTION,
            workerUrl:
              'https://rch-rugbychampagne-user-service-production.rch-evolucion.workers.dev',
          },
          versionId: 'immutable-v1',
          confirm: PRODUCTION.workerName,
        },
        {
          materialize: () => '/tmp/production-promotion.json',
          cleanup: (path) => harness.removed.push(path),
          preflight: () => Promise.resolve(),
          log: (message) => harness.logs.push(message),
          smoke: () => Promise.resolve(),
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
              : args.includes('view')
                ? { exitCode: 0, stdout: PRODUCTION_VERSION_DETAILS }
                : { exitCode: 0 },
          );
        },
      ),
    ).resolves.toBeUndefined();
    expect(commands).toEqual([
      'wrangler versions list --json --config /tmp/production-promotion.json',
      'wrangler versions view --json --version-id immutable-v1 --config /tmp/production-promotion.json',
      'wrangler versions deploy immutable-v1@100% --config /tmp/production-promotion.json',
    ]);
  });

  it('refuses production promotion before listing or mutating and still cleans up', async () => {
    const commands: string[] = [];
    const cleaned: string[] = [];
    await expect(
      runPromotion(
        { resolved: PRODUCTION, versionId: 'immutable-v1' },
        {
          materialize: () => '/tmp/production-promotion-boundary.json',
          cleanup: (path) => cleaned.push(path),
          preflight: () => Promise.resolve(),
          log: () => undefined,
          smoke: () => Promise.resolve(),
        },
        (_command, args) => {
          commands.push(args.join(' '));
          return Promise.resolve({ exitCode: 0, stdout: '[]' });
        },
      ),
    ).rejects.toThrow(/exact Worker name/);
    expect(commands).toEqual([]);
    expect(cleaned).toEqual(['/tmp/production-promotion-boundary.json']);
  });

  it('cleans up and does not promote or smoke when version discovery fails', async () => {
    const commands: string[] = [];
    const logs: string[] = [];
    const cleaned: string[] = [];
    await expect(
      runPromotion(
        { resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' },
        {
          materialize: () => '/tmp/promotion-discovery-failure.json',
          cleanup: (path) => cleaned.push(path),
          preflight: () => Promise.resolve(),
          log: (message) => logs.push(message),
          smoke: () => {
            throw new Error('smoke must not run');
          },
        },
        (_command, args) => {
          commands.push(args.join(' '));
          return Promise.resolve({ exitCode: 1, stdout: 'provider-canary' });
        },
      ),
    ).rejects.toThrow(/list-worker-versions/);
    expect(commands).toHaveLength(1);
    expect(cleaned).toEqual(['/tmp/promotion-discovery-failure.json']);
    expect(logs.join('\n')).not.toContain('provider-canary');
  });

  it('cleans up and does not promote when candidate readiness fails', async () => {
    const commands: string[] = [];
    const cleaned: string[] = [];
    let smokeCalls = 0;
    await expect(
      runPromotion(
        { resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' },
        {
          materialize: () => '/tmp/promotion-failure.json',
          cleanup: (path) => cleaned.push(path),
          preflight: () => Promise.resolve(),
          log: () => undefined,
          smoke: () => {
            smokeCalls += 1;
            return Promise.reject(new Error('candidate readiness failed'));
          },
        },
        (_command, args) => {
          commands.push(args.join(' '));
          return Promise.resolve(
            args.includes('list')
              ? { exitCode: 0, stdout: JSON.stringify([{ id: 'immutable-v1' }]) }
              : args.includes('view')
                ? { exitCode: 0, stdout: VERSION_DETAILS }
                : { exitCode: 1, stdout: 'provider-canary' },
          );
        },
      ),
    ).rejects.toThrow(/candidate readiness failed/);
    expect(commands).toHaveLength(2);
    expect(commands[1]).toContain('versions view');
    expect(smokeCalls).toBe(1);
    expect(cleaned).toEqual(['/tmp/promotion-failure.json']);
  });

  it('constructs a Version URL only after full-ID metadata verification', () => {
    if (VERIFIED_VERSION_WITHOUT_PREVIEW === undefined || VERIFIED_VERSION === undefined) {
      throw new Error('version fixture was not parsed');
    }
    expect(
      versionUrlForVerifiedVersion(VERSION_URL_SANDBOX, VERIFIED_VERSION_WITHOUT_PREVIEW),
    ).toBe('https://immutabl-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev');
    expect(versionUrlForVerifiedVersion(VERSION_URL_SANDBOX, VERIFIED_VERSION)).toBe(
      'https://authoritative-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
    );
    expect(() =>
      versionUrlForVerifiedVersion(
        { ...SANDBOX, workerUrl: 'https://api.example.test' },
        VERIFIED_VERSION,
      ),
    ).toThrow(/invalid Version URL/);
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

  it('runs the real read-only preflight and no mutation commands for a dry run', async () => {
    const commands: string[] = [];
    const removed: string[] = [];
    const logs: string[] = [];
    const runner: DeployCommandRunner = (command, args) => {
      commands.push(`${command} ${args.join(' ')}`);
      return Promise.resolve({ exitCode: 0, stdout: args.includes('deployments') ? '[]' : '' });
    };
    const io: DeployIo = {
      materialize: () => '/tmp/wrangler.dry-run.json',
      cleanup: (path) => removed.push(path),
      preflight: async (resolved) => {
        const checks = await runPreflight(
          { resolved },
          {
            nodeVersion: 'v24.21.0',
            commands: [],
            run: async (command, args) => {
              const result = await runner(command, args);
              return {
                exitCode: result.exitCode,
                stdout: result.stdout ?? '',
                ...(result.stderr === undefined ? {} : { stderr: result.stderr }),
              };
            },
          },
        );
        if (preflightFailed(checks)) throw formatPreflightError(checks);
      },
      log: (message) => logs.push(message),
    };

    await runDeployment({ resolved: SANDBOX, dryRun: true }, io, runner);

    expect(commands).toEqual([
      'npx wrangler --version',
      'npx wrangler whoami',
      'npx wrangler d1 list',
      'git status --porcelain',
      'npx wrangler deployments list --name rch-rugbychampagne-user-service-sandbox --json',
    ]);
    expect(
      commands.some(
        (command) =>
          command.includes('migrations') ||
          command.includes('wrangler deploy ') ||
          command.includes('versions upload') ||
          command.includes('versions deploy'),
      ),
    ).toBe(false);
    expect(removed).toEqual(['/tmp/wrangler.dry-run.json']);
    expect(logs.join('\n')).toContain('rch-rugbychampagne-user-service-sandbox');
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
