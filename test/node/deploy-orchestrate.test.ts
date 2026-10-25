import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { LOCAL_PROFILE } from '../../src/config/index.js';
import {
  planDeploymentSteps,
  promotionSmokeCommand,
  productionConfirmFor,
  runPromotion,
  runDeployment,
  smokeEnvironment,
  versionUrlForVerifiedVersion,
} from '../../scripts/deploy/orchestrate.js';
import { parseWorkerVersionDetails } from '../../scripts/deploy/versions.js';
import { buildVersionManifest, parseVersionManifest } from '../../scripts/deploy/manifest.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';
import {
  CONTRACT_PRODUCTION_DATABASE_ID,
  CONTRACT_SANDBOX_DATABASE_ID,
} from './deploy-test-utils.js';
import { CLOUDFLARE_ABSENT_WORKER_10007 } from './fixtures/cloudflare-absent-worker.js';
import { TestReleaseProcess } from './release-process-test-adapter.js';

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
const releaseLogs: string[] = [];
const VERSION_URL_SANDBOX = {
  ...SANDBOX,
  workerUrl: 'https://rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
};
const VERSION_MANIFEST = buildVersionManifest(SANDBOX.applicationConfig, {
  branch: 'test/branch',
  commit: '0123456789abcdef0123456789abcdef01234567',
  tag: '0123456-20261022T120000Z-test-branch',
});
const VERSION_DETAILS = JSON.stringify({
  id: 'immutable-v1',
  metadata: { created_on: '2026-10-20T12:00:00Z' },
  preview_url:
    'https://authoritative-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
  annotations: {
    'workers/message': VERSION_MANIFEST.message,
    'workers/tag': VERSION_MANIFEST.tag,
  },
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

beforeEach(() => {
  releaseLogs.length = 0;
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    releaseLogs.push(args.map(String).join(' '));
  });
});

afterEach(() => vi.restoreAllMocks());

interface Harness {
  process: TestReleaseProcess;
  commands: TestReleaseProcess['commands'];
  logs: string[];
  readonly preflightCalls: number;
}

function createHarness(failOn?: RegExp, failPreflight = false): Harness {
  const process = new TestReleaseProcess({
    respond: ({ command, args }) => {
      const text = `${command} ${args.join(' ')}`;
      if (failPreflight && args[0] === 'wrangler' && args[1] === '--version') {
        return { exitCode: 1 };
      }
      if (failOn?.test(text) === true) return { exitCode: 1 };
      if (text.includes('wrangler versions view')) return { exitCode: 0, stdout: VERSION_DETAILS };
      if (text.includes('wrangler versions list')) {
        return {
          exitCode: 0,
          stdout:
            '[{"id":"v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{"workers/message":"test"}}]',
        };
      }
      return undefined;
    },
  });
  return {
    process,
    commands: process.commands,
    logs: releaseLogs,
    get preflightCalls() {
      return process.calls.filter(({ args }) => args[0] === 'wrangler' && args[1] === '--version')
        .length;
    },
  };
}

function expectMaterializedConfigRemoved(commands: Harness['commands']): void {
  const args = commands.find(({ args }) => args.includes('--config'))?.args;
  const configIndex = args?.indexOf('--config') ?? -1;
  const configPath = configIndex < 0 ? undefined : args?.[configIndex + 1];
  expect(configPath).toBeDefined();
  if (configPath !== undefined) expect(existsSync(configPath)).toBe(false);
}

function releaseCommandTexts(process: TestReleaseProcess): string[] {
  return process.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
}

function expectConfigRemoved(process: TestReleaseProcess, commandFragment: string): void {
  const args = process.commands.find(({ args }) => args.join(' ').includes(commandFragment))?.args;
  const configIndex = args?.indexOf('--config') ?? -1;
  const path = configIndex < 0 ? undefined : args?.[configIndex + 1];
  expect(path).toBeDefined();
  if (path !== undefined) expect(existsSync(path)).toBe(false);
}

function createPromotionProcess(
  respond: NonNullable<ConstructorParameters<typeof TestReleaseProcess>[0]>['respond'],
): TestReleaseProcess {
  return new TestReleaseProcess({ respond });
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
    await expect(runDeployment({ resolved: PRODUCTION }, harness.process)).rejects.toThrow(
      /rch-rugbychampagne-user-service-production/,
    );
    expect(harness.commands).toEqual([]);
  });

  it('refuses production with the wrong confirmation before any remote mutation', async () => {
    const harness = createHarness();
    await expect(
      runDeployment({ resolved: PRODUCTION, confirm: 'PROMOTE' }, harness.process),
    ).rejects.toThrow(/confirmation/);
    expect(harness.commands).toEqual([]);
  });

  it('runs migrations before Worker deployment for sandbox', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.process);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const migrateIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    const deployIndex = harness.commands.findIndex(
      ({ args }) => args[0] === 'wrangler' && args.includes('upload'),
    );
    const smokeIndex = text.findIndex((entry) => entry.includes('smoke:health'));
    expect(migrateIndex).toBeGreaterThanOrEqual(0);
    expect(deployIndex).toBeGreaterThan(migrateIndex);
    expect(smokeIndex).toBe(-1);
    expect(text.some((entry) => entry.includes('--config'))).toBe(true);
    expectMaterializedConfigRemoved(harness.commands);
  });

  it('uploads a candidate for an existing Worker without changing traffic', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.process);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    expect(text.some((entry) => entry.includes('wrangler versions upload'))).toBe(true);
    expect(text.some((entry) => entry.includes('wrangler deploy --config'))).toBe(false);
    expect(text.some((entry) => entry.includes('smoke:health'))).toBe(false);
    const upload = harness.commands.find(({ args }) => args.includes('upload'));
    const messageIndex = upload?.args.indexOf('--message') ?? -1;
    const tagIndex = upload?.args.indexOf('--tag') ?? -1;
    const message = messageIndex < 0 ? undefined : upload?.args[messageIndex + 1];
    const tag = tagIndex < 0 ? undefined : upload?.args[tagIndex + 1];
    expect(message).toBeDefined();
    expect(tag).toMatch(/^0123456-\d{8}T\d{6}Z-test-branch$/);
    expect(
      parseVersionManifest({
        'workers/message': message,
        'workers/tag': tag,
      }),
    ).toMatchObject({
      branch: 'test/branch',
      commit: '0123456789abcdef0123456789abcdef01234567',
      fingerprint: VERSION_MANIFEST.fingerprint,
      mailTransport: 'resend',
    });
    expect(harness.logs).toContain(
      'candidate uploaded; stable-origin smoke is deferred until promotion',
    );
  });

  it('keeps stable-origin smoke for the explicitly confirmed first deployment', async () => {
    const confirmedWorkers: string[] = [];
    const processAdapter = new TestReleaseProcess({
      respond: ({ args }) =>
        args.includes('versions') && args.includes('list')
          ? { exitCode: 0, stdout: '[]' }
          : undefined,
    });

    await runDeployment({ resolved: SANDBOX }, processAdapter, (workerName) => {
      confirmedWorkers.push(workerName);
      return Promise.resolve(true);
    });

    expect(confirmedWorkers).toEqual([SANDBOX.workerName]);
    expect(releaseLogs).toContain(
      `first deployment for worker=${SANDBOX.workerName} will activate its first version; Cloudflare does not support an inactive initial version`,
    );
    expect(processAdapter.commands.some(({ args }) => args.includes('smoke:health'))).toBe(true);
    const smoke = processAdapter.commands.find(({ args }) => args.includes('smoke:health'));
    expect(smoke?.env).toEqual({
      PATH: process.env.PATH,
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.test',
    });
    const deploy = processAdapter.commands.find(({ args }) => args.includes('deploy'));
    const messageIndex = deploy?.args.indexOf('--message') ?? -1;
    const tagIndex = deploy?.args.indexOf('--tag') ?? -1;
    const message = messageIndex < 0 ? undefined : deploy?.args[messageIndex + 1];
    const tag = tagIndex < 0 ? undefined : deploy?.args[tagIndex + 1];
    expect(message).toBeDefined();
    expect(tag).toMatch(/^0123456-\d{8}T\d{6}Z-test-branch$/);
    expect(
      parseVersionManifest({
        'workers/message': message,
        'workers/tag': tag,
      }),
    ).toMatchObject({
      branch: 'test/branch',
      commit: '0123456789abcdef0123456789abcdef01234567',
      fingerprint: VERSION_MANIFEST.fingerprint,
      mailTransport: 'resend',
    });
    expectMaterializedConfigRemoved(processAdapter.commands);
  });

  it('confirms and deploys when versions discovery returns the absent-Worker 10007 fixture', async () => {
    const processAdapter = new TestReleaseProcess({
      respond: ({ args }) => {
        if (args.includes('versions') && args.includes('list')) {
          return {
            exitCode: 1,
            stdout: '',
            stderr: CLOUDFLARE_ABSENT_WORKER_10007,
          };
        }
        return undefined;
      },
    });

    await runDeployment({ resolved: SANDBOX }, processAdapter, () => Promise.resolve(true));

    expect(
      processAdapter.commands.some(({ command, args }) =>
        `${command} ${args.join(' ')}`.includes('wrangler deploy'),
      ),
    ).toBe(true);
    expect(releaseLogs.join('\n')).not.toContain('script_not_found');
    expectMaterializedConfigRemoved(processAdapter.commands);
  });

  it('requires explicit confirmation before the unavoidable first active deployment', async () => {
    const confirmedWorkers: string[] = [];
    const processAdapter = new TestReleaseProcess({
      respond: ({ args }) =>
        args.includes('versions') && args.includes('list')
          ? { exitCode: 0, stdout: '[]' }
          : undefined,
    });
    await expect(
      runDeployment({ resolved: SANDBOX }, processAdapter, (workerName) => {
        confirmedWorkers.push(workerName);
        return Promise.resolve(false);
      }),
    ).rejects.toThrow(/first deployment cancelled/i);
    expect(
      processAdapter.commands.some(
        ({ args }) => args.includes('deploy') && args.includes('--config'),
      ),
    ).toBe(false);
    expect(confirmedWorkers).toEqual([SANDBOX.workerName]);
    expectMaterializedConfigRemoved(processAdapter.commands);
  });

  it('runs candidate readiness before deploying the selected immutable version', async () => {
    const processAdapter = createPromotionProcess(({ command, args }) => {
      if (args.includes('versions') && args.includes('list')) {
        return {
          exitCode: 0,
          stdout:
            '[{"id":"immutable-v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{"workers/tag":"candidate"}}]',
        };
      }
      if (args.includes('versions') && args.includes('view')) {
        return { exitCode: 0, stdout: VERSION_DETAILS };
      }
      return command === 'npm' && args.includes('smoke:readiness')
        ? { exitCode: 0, stdout: '' }
        : undefined;
    });
    await expect(
      runPromotion({ resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' }, processAdapter),
    ).resolves.toBeUndefined();
    const texts = releaseCommandTexts(processAdapter);
    const versionCommands = texts.filter((entry) => entry.includes('wrangler versions'));
    expect(versionCommands).toEqual([
      expect.stringMatching(/versions list --json --config/),
      expect.stringMatching(/versions view --json immutable-v1 --config/),
      expect.stringMatching(/versions deploy immutable-v1@100% --config/),
    ]);
    expect(
      processAdapter.calls.find(
        ({ command, args }) => command === 'npm' && args.includes('smoke:readiness'),
      )?.options?.env,
    ).toEqual({
      PATH: process.env.PATH,
      SMOKE_SANDBOX_BASE_URL:
        'https://authoritative-rch-rugbychampagne-user-service-sandbox.rch-evolucion.workers.dev',
    });
    expectConfigRemoved(processAdapter, 'versions deploy immutable-v1@100%');
  });

  it('blocks production promotion before any traffic mutation', async () => {
    const processAdapter = createPromotionProcess(({ args }) => {
      if (args.includes('versions') && args.includes('list')) {
        return {
          exitCode: 0,
          stdout:
            '[{"id":"immutable-v1","metadata":{"created_on":"2026-10-20T12:00:00Z"},"annotations":{}}]',
        };
      }
      if (args.includes('versions') && args.includes('view')) {
        return { exitCode: 0, stdout: PRODUCTION_VERSION_DETAILS };
      }
      return undefined;
    });
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
        processAdapter,
      ),
    ).resolves.toBeUndefined();
    expect(
      releaseCommandTexts(processAdapter).filter((entry) => entry.includes('versions deploy')),
    ).toHaveLength(1);
  });

  it('refuses production promotion before listing or mutating and still cleans up', async () => {
    const processAdapter = createPromotionProcess(() => undefined);
    await expect(
      runPromotion({ resolved: PRODUCTION, versionId: 'immutable-v1' }, processAdapter),
    ).rejects.toThrow(/exact Worker name/);
    expect(processAdapter.commands).toEqual([]);
  });

  it('cleans up and does not promote or smoke when version discovery fails', async () => {
    const processAdapter = createPromotionProcess(({ args }) =>
      args.includes('versions') && args.includes('list')
        ? { exitCode: 1, stdout: 'provider-canary' }
        : undefined,
    );
    await expect(
      runPromotion({ resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' }, processAdapter),
    ).rejects.toThrow(/list-worker-versions/);
    expect(
      releaseCommandTexts(processAdapter).filter((entry) => entry.includes('versions list')),
    ).toHaveLength(1);
    expect(processAdapter.commands.map(({ args }) => args.join(' ')).join('\n')).not.toContain(
      'provider-canary',
    );
    expectConfigRemoved(processAdapter, 'versions list --json --config');
  });

  it('cleans up and does not promote when candidate readiness fails', async () => {
    const processAdapter = createPromotionProcess(({ command, args }) => {
      if (args.includes('versions') && args.includes('list')) {
        return { exitCode: 0, stdout: JSON.stringify([{ id: 'immutable-v1' }]) };
      }
      if (args.includes('versions') && args.includes('view')) {
        return { exitCode: 0, stdout: VERSION_DETAILS };
      }
      if (command === 'npm' && args.includes('smoke:readiness')) return { exitCode: 1 };
      return undefined;
    });
    await expect(
      runPromotion({ resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' }, processAdapter),
    ).rejects.toThrow(/Sandbox smoke failed/);
    const texts = releaseCommandTexts(processAdapter);
    expect(texts.some((entry) => entry.includes('npm run smoke:readiness'))).toBe(true);
    expect(texts.some((entry) => entry.includes('versions deploy'))).toBe(false);
    expectConfigRemoved(processAdapter, 'versions view --json immutable-v1');
  });

  it('cleans up after a failed promotion without attempting an automatic rollback', async () => {
    const processAdapter = createPromotionProcess(({ command, args }) => {
      if (args.includes('versions') && args.includes('list')) {
        return { exitCode: 0, stdout: JSON.stringify([{ id: 'immutable-v1' }]) };
      }
      if (args.includes('versions') && args.includes('view')) {
        return { exitCode: 0, stdout: VERSION_DETAILS };
      }
      if (command === 'npx' && args.includes('deploy'))
        return { exitCode: 1, stdout: 'provider-canary' };
      return undefined;
    });
    await expect(
      runPromotion({ resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' }, processAdapter),
    ).rejects.toThrow(/promote-worker-version/);

    const texts = releaseCommandTexts(processAdapter);
    expect(texts.filter((command) => command.includes('versions deploy'))).toHaveLength(1);
    expect(texts.some((command) => command.includes('wrangler rollback'))).toBe(false);
    expect(releaseLogs.join('\n')).not.toContain('provider-canary');
    expectConfigRemoved(processAdapter, 'versions deploy immutable-v1@100%');
  });

  it('fails closed for an existing candidate without a release manifest', async () => {
    const processAdapter = createPromotionProcess(({ args }) => {
      if (args.includes('versions') && args.includes('list')) {
        return { exitCode: 0, stdout: JSON.stringify([{ id: 'immutable-v1' }]) };
      }
      if (args.includes('versions') && args.includes('view')) {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            id: 'immutable-v1',
            metadata: { created_on: '2026-10-20T12:00:00Z' },
            resources: {
              bindings: [
                { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
                { name: 'RESEND_API_KEY', type: 'secret_text' },
              ],
            },
          }),
        };
      }
      return undefined;
    });
    await expect(
      runPromotion({ resolved: VERSION_URL_SANDBOX, versionId: 'immutable-v1' }, processAdapter),
    ).rejects.toThrow(/release manifest/);
    const texts = releaseCommandTexts(processAdapter);
    expect(texts.some((entry) => entry.includes('versions deploy'))).toBe(false);
    expect(texts.some((entry) => entry.includes('npm run smoke:readiness'))).toBe(false);
    expectConfigRemoved(processAdapter, 'versions view --json immutable-v1');
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
    await runDeployment({ resolved: SANDBOX }, harness.process);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const buildIndex = text.findIndex((entry) => entry === 'npm run build:admin');
    const remoteIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    expect(buildIndex).toBeGreaterThanOrEqual(0);
    expect(remoteIndex).toBeGreaterThan(buildIndex);
  });

  it('aborts before remote mutation when the administration build fails', async () => {
    const harness = createHarness(/npm run build:admin/);
    await expect(runDeployment({ resolved: SANDBOX }, harness.process)).rejects.toThrow(
      /build-admin-assets/,
    );
    const texts = releaseCommandTexts(harness.process);
    const versions = texts.findIndex((entry) => entry.includes('wrangler versions list'));
    const build = texts.findIndex((entry) => entry === 'npm run build:admin');
    const remoteMigration = texts.findIndex((entry) =>
      entry.includes('migrations apply DB --remote'),
    );
    expect(versions).toBeGreaterThanOrEqual(0);
    expect(build).toBeGreaterThan(versions);
    expect(remoteMigration).toBe(-1);
    expectMaterializedConfigRemoved(harness.commands);
  });

  it('validates migrations locally before remote mutation', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX }, harness.process);
    const text = harness.commands.map(({ command, args }) => `${command} ${args.join(' ')}`);
    const localIndex = text.findIndex((entry) => entry.includes('migrations apply DB --local'));
    const remoteIndex = text.findIndex((entry) => entry.includes('migrations apply DB --remote'));
    expect(localIndex).toBeGreaterThanOrEqual(0);
    expect(localIndex).toBeLessThan(remoteIndex);
  });

  it('removes the temporary config even when deployment fails', async () => {
    const harness = createHarness(/wrangler versions upload/);
    await expect(runDeployment({ resolved: SANDBOX }, harness.process)).rejects.toThrow(
      /deploy-worker/,
    );
    expectMaterializedConfigRemoved(harness.commands);
  });

  it('runs the real read-only preflight and no mutation commands for a dry run', async () => {
    const processAdapter = new TestReleaseProcess();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, processAdapter);

    expect(releaseCommandTexts(processAdapter)).toEqual([
      'npx wrangler --version',
      'npx wrangler whoami',
      'npx wrangler d1 list',
      'git status --porcelain',
      'npx wrangler deployments list --name rch-rugbychampagne-user-service-sandbox --json',
    ]);
    expect(
      releaseCommandTexts(processAdapter).some(
        (command) =>
          command.includes('migrations') ||
          command.includes('wrangler deploy ') ||
          command.includes('versions upload') ||
          command.includes('versions deploy'),
      ),
    ).toBe(false);
    expect(releaseLogs.join('\n')).toContain('rch-rugbychampagne-user-service-sandbox');
  });

  it('executes the read-only preflight on a dry run without mutating commands', async () => {
    const harness = createHarness();
    await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.process);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands.some(({ args }) => args.includes('migrations'))).toBe(false);
    expect(harness.commands.some(({ args }) => args.includes('deploy'))).toBe(false);
  });

  it('fails the dry run when preflight fails and still cleans up', async () => {
    const harness = createHarness(undefined, true);
    await expect(
      runDeployment({ resolved: SANDBOX, dryRun: true }, harness.process),
    ).rejects.toThrow(/preflight/);
    expect(harness.preflightCalls).toBe(1);
    expect(harness.commands.some(({ args }) => args.includes('migrations'))).toBe(false);
    expect(harness.commands.some(({ args }) => args.includes('deploy'))).toBe(false);
  });

  it('never logs secret values while summarizing the deployment', async () => {
    const harness = createHarness();
    process.env.DEPLOY_CLI_CANARY = CANARY;
    try {
      await runDeployment({ resolved: SANDBOX, dryRun: true }, harness.process);
    } finally {
      delete process.env.DEPLOY_CLI_CANARY;
    }
    expect(harness.logs.join('\n')).not.toContain(CANARY);
  });
});
