import { describe, expect, it } from 'vitest';
import {
  productionProvisionConfirmFor,
  runProvision,
  stageProvisionedDatabaseId,
  type ProvisionCommandRunner,
  type ProvisionIo,
  type ProvisionRequest,
} from '../../scripts/deploy/provision.js';
import type { TargetsFile } from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo } from './deploy-test-utils.js';

const SANDBOX_DB = 'rch-rugbychampagne-user-service-sandbox-db';
const PRODUCTION_DB = 'rch-rugbychampagne-user-service-production-db';
const PRODUCTION_WORKER = 'rch-rugbychampagne-user-service-production';
const REMOTE_SANDBOX_ID = 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b';
const OTHER_REMOTE_ID = 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c';
const CANARY = 'canary-provision-secret-abcdef123456';

function realCreateText(databaseName: string, databaseId: string): string {
  // Representative `wrangler d1 create` output at pinned Wrangler 4.130.0:
  // human-readable success text plus a config snippet, never JSON.
  return [
    `✅ Successfully created DB '${databaseName}'`,
    'Created your new D1 database.',
    '',
    'To access your new D1 Database in your Worker, add the following snippet to your configuration file:',
    '[[d1_databases]]',
    'binding = "DB"',
    `database_name = "${databaseName}"`,
    `database_id = "${databaseId}"`,
    '',
  ].join('\n');
}

interface HarnessOptions {
  readonly file?: TargetsFile;
  readonly remotes?: { name: string; uuid: string }[];
  readonly remotesAfterCreate?: { name: string; uuid: string }[];
  readonly d1ListStdout?: string;
  readonly d1ListExit?: number;
  readonly d1ListStdoutAfterCreate?: string;
  readonly d1ListExitAfterCreate?: number;
  readonly createStdout?: string;
  readonly createExit?: number;
  readonly worker?: 'found' | 'absent' | 'error' | 'malformed';
  readonly secrets?: unknown;
  readonly secretExit?: number;
  readonly failWrite?: boolean;
}

interface Harness {
  readonly io: ProvisionIo;
  readonly runner: ProvisionCommandRunner;
  readonly commands: { command: string; args: string[] }[];
  readonly writes: TargetsFile[];
  readonly logs: string[];
  readonly accountIds: string[];
}

function withDatabaseId(
  file: TargetsFile,
  environment: 'sandbox' | 'production',
  id: string,
): TargetsFile {
  return {
    ...file,
    targets: file.targets.map((entry) => ({
      ...entry,
      environments: {
        ...entry.environments,
        [environment]: { ...entry.environments[environment], databaseId: id },
      },
    })),
  };
}

function createHarness(options: HarnessOptions = {}): Harness {
  let file = options.file ?? withDatabaseId(loadTargetsFromRepo(), 'sandbox', '');
  file = {
    ...file,
    targets: file.targets.map((target) => ({
      ...target,
      environments: {
        sandbox: { ...target.environments.sandbox, accountId: '11111111111111111111111111111111' },
        production: {
          ...target.environments.production,
          accountId: '11111111111111111111111111111111',
        },
      },
    })),
  };
  const commands: { command: string; args: string[] }[] = [];
  const writes: TargetsFile[] = [];
  const logs: string[] = [];
  const accountIds: string[] = [];
  const harness: Harness = {
    io: {
      loadTargets: () => file,
      writeTargets: (next) => {
        if (options.failWrite === true) {
          throw new Error('simulated config write failure');
        }
        writes.push(next);
        file = next;
      },
      log: (message) => {
        logs.push(message);
      },
    },
    runner: (command, args, scope) => {
      commands.push({ command, args: [...args] });
      accountIds.push(scope?.accountId ?? '');
      if (args.includes('d1') && args.includes('list')) {
        const createSeen = commands.some((entry) => entry.args.includes('create'));
        if (createSeen) {
          if (options.d1ListStdoutAfterCreate !== undefined) {
            return Promise.resolve({
              exitCode: options.d1ListExitAfterCreate ?? 0,
              stdout: options.d1ListStdoutAfterCreate,
            });
          }
          if ((options.d1ListExitAfterCreate ?? 0) !== 0) {
            return Promise.resolve({
              exitCode: options.d1ListExitAfterCreate ?? 1,
              stdout: '',
            });
          }
          if (options.remotesAfterCreate !== undefined) {
            return Promise.resolve({
              exitCode: 0,
              stdout: JSON.stringify(options.remotesAfterCreate),
            });
          }
        }
        if (options.d1ListStdout !== undefined) {
          return Promise.resolve({
            exitCode: options.d1ListExit ?? 0,
            stdout: options.d1ListStdout,
          });
        }
        if ((options.d1ListExit ?? 0) !== 0) {
          return Promise.resolve({ exitCode: options.d1ListExit ?? 1, stdout: '' });
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify(options.remotes ?? []),
        });
      }
      if (args.includes('d1') && args.includes('create')) {
        return Promise.resolve({
          exitCode: options.createExit ?? 0,
          stdout: options.createStdout ?? realCreateText(SANDBOX_DB, REMOTE_SANDBOX_ID),
        });
      }
      if (args.includes('deployments')) {
        const mode = options.worker ?? 'absent';
        if (mode === 'error') {
          return Promise.resolve({ exitCode: 1, stdout: '' });
        }
        if (mode === 'malformed') {
          return Promise.resolve({ exitCode: 0, stdout: '{"not":"an-array"}' });
        }
        return Promise.resolve({
          exitCode: 0,
          stdout: mode === 'found' ? JSON.stringify([{ id: 'deployment-1' }]) : '[]',
        });
      }
      if (args.includes('secret')) {
        return Promise.resolve({
          exitCode: options.secretExit ?? 0,
          stdout: JSON.stringify(
            options.secrets ?? [
              { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
              { name: 'SMTP_USER', type: 'secret_text' },
              { name: 'SMTP_PASSWORD', type: 'secret_text' },
            ],
          ),
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: '' });
    },
    commands,
    writes,
    logs,
    accountIds,
  };
  return harness;
}

function sandboxRequest(overrides: Partial<ProvisionRequest> = {}): ProvisionRequest {
  return { target: 'rch-rugbychampagne', environment: 'sandbox', mode: 'plan', ...overrides };
}

// Provisioning orchestration (ticket #80): plan is read-only, apply
// creates/adopts the exact-name D1 and stages the non-secret id, Worker
// state is discovered read-only, secrets are names/status only, and
// production apply needs the exact Worker-name confirmation.
describe('provisioning plan mode', () => {
  it('reports CREATE for an empty D1 slot with zero remote mutations', async () => {
    const harness = createHarness();
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.d1Action).toBe('create');
    expect(outcome.databaseName).toBe(SANDBOX_DB);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toEqual([]);
    expect(outcome.configUpdated).toBe(false);
    expect(harness.logs.join('\n')).toContain(SANDBOX_DB);
    expect(harness.accountIds.length).toBeGreaterThan(0);
    expect(
      harness.accountIds.every((accountId) => accountId === '11111111111111111111111111111111'),
    ).toBe(true);
  });

  it('performs no remote mutation in default plan mode', async () => {
    const harness = createHarness({
      file: withDatabaseId(loadTargetsFromRepo(), 'sandbox', REMOTE_SANDBOX_ID),
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('reports ADOPT for an exact existing D1 with an empty slot', async () => {
    const harness = createHarness({ remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }] });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.d1Action).toBe('adopt');
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(harness.writes).toEqual([]);
  });

  it('verifies an already-recorded D1 without rewriting config', async () => {
    const harness = createHarness({
      file: withDatabaseId(loadTargetsFromRepo(), 'sandbox', REMOTE_SANDBOX_ID),
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.d1Action).toBe('ok');
    expect(harness.writes).toEqual([]);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
  });
});

describe('provisioning apply mode', () => {
  it('refuses a configured D1 id missing from the selected account before creating a replacement', async () => {
    const harness = createHarness({
      file: withDatabaseId(loadTargetsFromRepo(), 'sandbox', REMOTE_SANDBOX_ID),
    });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), harness.io, harness.runner),
    ).rejects.toThrow(/not present in the selected Cloudflare account/i);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
  });

  it('creates the exact canonical D1 and stages its id from JSON rediscovery', async () => {
    const harness = createHarness({
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    );
    const create = harness.commands.find(({ args }) => args.includes('create'));
    expect(create?.args).toEqual(['wrangler', 'd1', 'create', SANDBOX_DB, '--update-config=false']);
    const lists = harness.commands.filter(({ args }) => args.includes('list'));
    expect(lists.length).toBeGreaterThanOrEqual(2);
    expect(outcome.d1Action).toBe('created');
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(outcome.configUpdated).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.targets[0]?.environments.sandbox.databaseId).toBe(REMOTE_SANDBOX_ID);
  });

  it('stages the rediscovered id even when creation text carries no usable uuid', async () => {
    const harness = createHarness({
      createStdout: realCreateText(SANDBOX_DB, 'pending-without-uuid-lookup'),
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    );
    expect(outcome.d1Action).toBe('created');
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(harness.writes).toHaveLength(1);
  });

  it('never stages creation text output: the staged id comes from exact-name rediscovery', async () => {
    const decoyId = 'd9e8f7a6-b5c4-4d3e-8f7a-6b5c4d3e2f1a';
    const harness = createHarness({
      createStdout: realCreateText(SANDBOX_DB, decoyId),
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    );
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(outcome.databaseId).not.toBe(decoyId);
    expect(harness.writes[0]?.targets[0]?.environments.sandbox.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(harness.logs.join('\n')).not.toContain(decoyId);
  });

  it('adopts the existing D1 id on apply without creating', async () => {
    const harness = createHarness({ remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }] });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    );
    expect(outcome.d1Action).toBe('adopt');
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.targets[0]?.environments.sandbox.databaseId).toBe(REMOTE_SANDBOX_ID);
  });

  it('is idempotent: a rerun after success creates nothing and writes nothing', async () => {
    const first = createHarness({
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const created = await runProvision(sandboxRequest({ mode: 'apply' }), first.io, first.runner);
    expect(created.configUpdated).toBe(true);
    const second = createHarness({
      file: withDatabaseId(loadTargetsFromRepo(), 'sandbox', REMOTE_SANDBOX_ID),
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(sandboxRequest({ mode: 'apply' }), second.io, second.runner);
    expect(outcome.d1Action).toBe('ok');
    expect(second.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(second.writes).toEqual([]);
  });

  it('recovers from a config-write failure by rediscovering the same remote', async () => {
    const failing = createHarness({
      failWrite: true,
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), failing.io, failing.runner),
    ).rejects.toThrow(/config/i);
    expect(failing.writes).toEqual([]);
    const recovery = createHarness({ remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }] });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      recovery.io,
      recovery.runner,
    );
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(recovery.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(recovery.writes).toHaveLength(1);
  });

  it('preserves unrelated targets and environments when staging', async () => {
    const harness = createHarness({ remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }] });
    await runProvision(sandboxRequest({ mode: 'apply' }), harness.io, harness.runner);
    const staged = harness.writes[0];
    expect(staged?.targets[0]?.environments.production.databaseId).toBe('');
    expect(staged?.targets[0]?.environments.sandbox.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
  });
});

describe('provisioning failure boundaries', () => {
  it('fails closed on duplicate exact-name discovery without mutation', async () => {
    const harness = createHarness({
      remotes: [
        { name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID },
        { name: SANDBOX_DB, uuid: OTHER_REMOTE_ID },
      ],
    });
    const error = await runProvision(sandboxRequest(), harness.io, harness.runner).then(
      () => {
        throw new Error('expected provisioning to fail closed');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/ambiguous|duplicate/i);
    expect((error as Error).message).toMatch(/manually|runbook/i);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('fails closed on configured/remote mismatch with the exact next operator action', async () => {
    const harness = createHarness({
      file: withDatabaseId(loadTargetsFromRepo(), 'sandbox', OTHER_REMOTE_ID),
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const error = await runProvision(sandboxRequest(), harness.io, harness.runner).then(
      () => {
        throw new Error('expected provisioning to fail closed');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/mismatch|disagree|conflict/i);
    expect((error as Error).message).toMatch(/manually|runbook/i);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('fails closed on discovery command failure with the exact next operator action', async () => {
    const harness = createHarness({ d1ListExit: 1 });
    await expect(runProvision(sandboxRequest(), harness.io, harness.runner)).rejects.toThrow(
      /npx wrangler d1 list --json/,
    );
    expect(harness.writes).toEqual([]);
  });

  it('fails closed on malformed discovery output without staging an id', async () => {
    const harness = createHarness({ d1ListStdout: '{"value":"not-an-array"}' });
    await expect(runProvision(sandboxRequest(), harness.io, harness.runner)).rejects.toThrow();
    expect(harness.writes).toEqual([]);
  });

  it('fails closed when creation fails with the manual fallback action', async () => {
    const harness = createHarness({ createExit: 1 });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), harness.io, harness.runner),
    ).rejects.toThrow(new RegExp(`npx wrangler d1 create ${SANDBOX_DB} --update-config=false`));
    expect(harness.writes).toEqual([]);
  });

  it('fails closed when post-create rediscovery finds no exact-name database', async () => {
    const harness = createHarness({ remotesAfterCreate: [] });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), harness.io, harness.runner),
    ).rejects.toThrow(/rediscover|rerun.*--apply|npx wrangler d1 list --json/i);
    expect(harness.writes).toEqual([]);
  });

  it('fails closed when post-create rediscovery is ambiguous', async () => {
    const harness = createHarness({
      remotesAfterCreate: [
        { name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID },
        { name: SANDBOX_DB, uuid: OTHER_REMOTE_ID },
      ],
    });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), harness.io, harness.runner),
    ).rejects.toThrow(/ambiguous|duplicate/i);
    expect(harness.writes).toEqual([]);
  });

  it('fails closed when post-create rediscovery output is malformed with the exact recovery action', async () => {
    const harness = createHarness({
      d1ListStdoutAfterCreate: `not json ${CANARY}`,
    });
    const error = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    ).then(
      () => {
        throw new Error('expected provisioning to fail closed');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(SANDBOX_DB);
    expect((error as Error).message).toContain('npx wrangler d1 list --json');
    expect((error as Error).message).toMatch(/rerun with --apply/i);
    expect((error as Error).message).not.toContain(CANARY);
    expect(harness.logs.join('\n')).not.toContain(CANARY);
    expect(harness.writes).toEqual([]);
    expect(harness.commands).toHaveLength(3);
  });

  it('fails closed when post-create rediscovery carries an invalid identifier with the exact recovery action', async () => {
    const harness = createHarness({
      d1ListStdoutAfterCreate: JSON.stringify([{ name: SANDBOX_DB, uuid: CANARY }]),
    });
    const error = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    ).then(
      () => {
        throw new Error('expected provisioning to fail closed');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(SANDBOX_DB);
    expect((error as Error).message).toContain('npx wrangler d1 list --json');
    expect((error as Error).message).toMatch(/rerun with --apply/i);
    expect((error as Error).message).not.toContain(CANARY);
    expect(harness.logs.join('\n')).not.toContain(CANARY);
    expect(harness.writes).toEqual([]);
    expect(harness.commands).toHaveLength(3);
  });

  it('fails closed when post-create rediscovery exits nonzero with the exact recovery action', async () => {
    const harness = createHarness({
      d1ListExitAfterCreate: 1,
    });
    const error = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    ).then(
      () => {
        throw new Error('expected provisioning to fail closed');
      },
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('npx wrangler d1 list --json');
    expect((error as Error).message).toMatch(/rerun with --apply/i);
    expect(harness.writes).toEqual([]);
    expect(harness.commands).toHaveLength(3);
  });

  it('adopts the existing database on rerun after a failed post-create rediscovery without another create', async () => {
    const failing = createHarness({
      d1ListStdoutAfterCreate: `not json ${CANARY}`,
    });
    await expect(
      runProvision(sandboxRequest({ mode: 'apply' }), failing.io, failing.runner),
    ).rejects.toThrow(/npx wrangler d1 list --json/);
    expect(failing.writes).toEqual([]);
    const recovery = createHarness({ remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }] });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      recovery.io,
      recovery.runner,
    );
    expect(outcome.d1Action).toBe('adopt');
    expect(outcome.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(recovery.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(recovery.writes).toHaveLength(1);
  });

  it('never adopts another environment database by prefix', async () => {
    const harness = createHarness({
      remotes: [{ name: PRODUCTION_DB, uuid: OTHER_REMOTE_ID }],
    });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.d1Action).toBe('create');
    expect(outcome.databaseId).toBe('');
  });
});

describe('provisioning Worker and secret reporting', () => {
  it('reports a deployed Worker without deploying application code', async () => {
    const harness = createHarness({
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
      worker: 'found',
    });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.workerState).toBe('found');
    for (const { args } of harness.commands) {
      expect(args.join(' ')).not.toMatch(/wrangler deploy(?!ments)/);
      expect(args.join(' ')).not.toMatch(/publish|upload/);
    }
  });

  it('reports an absent Worker as not deployed with the deploy next step', async () => {
    const harness = createHarness({ worker: 'absent' });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.workerState).toBe('absent');
    expect(harness.logs.join('\n')).toMatch(/not deployed|npm run deploy/i);
  });

  it('reports Worker discovery failure as unknown rather than guessing', async () => {
    const harness = createHarness({ worker: 'error' });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.workerState).toBe('unknown');
    expect(outcome.d1Action).toBe('create');
    expect(harness.logs.join('\n')).not.toMatch(/not deployed yet/);
    expect(outcome.secretStatus).toBe('unverified');
    expect(harness.commands.some(({ args }) => args.includes('secret'))).toBe(false);
  });

  it('checks required secrets by names only where the Worker exists', async () => {
    const harness = createHarness({
      remotes: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
      worker: 'found',
      secrets: [
        { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
        { name: 'SMTP_USER', type: 'secret_text' },
      ],
    });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.secretStatus).toBe('missing');
    const logs = harness.logs.join('\n');
    expect(logs).toMatch(/SMTP_PASSWORD/);
    expect(logs).toMatch(
      /secret put SMTP_PASSWORD.*--name .*rch-rugbychampagne-user-service-sandbox/,
    );
  });

  it('skips secret listing with post-deploy instructions when the Worker is absent', async () => {
    const harness = createHarness({ worker: 'absent' });
    const outcome = await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(outcome.secretStatus).toBe('worker-not-deployed');
    expect(harness.commands.some(({ args }) => args.includes('secret'))).toBe(false);
    expect(harness.logs.join('\n')).toMatch(/BETTER_AUTH_SECRET/);
  });

  it('never logs secret values from provider output', async () => {
    const harness = createHarness({
      remotes: [
        { name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID, value: CANARY } as unknown as {
          name: string;
          uuid: string;
        },
      ],
      worker: 'found',
      secrets: [
        { name: 'BETTER_AUTH_SECRET', type: 'secret_text', value: CANARY },
        { name: 'SMTP_USER', type: 'secret_text', value: CANARY },
        { name: 'SMTP_PASSWORD', type: 'secret_text', value: CANARY },
      ],
    });
    await runProvision(sandboxRequest(), harness.io, harness.runner);
    expect(harness.logs.join('\n')).not.toContain(CANARY);
  });

  it('never logs creation text output containing provider-shaped fields', async () => {
    const harness = createHarness({
      createStdout: [
        `✅ Successfully created DB '${SANDBOX_DB}'`,
        'Created your new D1 database.',
        `token ${CANARY}`,
        `database_id = "${REMOTE_SANDBOX_ID}"`,
        '',
      ].join('\n'),
      remotesAfterCreate: [{ name: SANDBOX_DB, uuid: REMOTE_SANDBOX_ID }],
    });
    const outcome = await runProvision(
      sandboxRequest({ mode: 'apply' }),
      harness.io,
      harness.runner,
    );
    expect(outcome.d1Action).toBe('created');
    expect(harness.logs.join('\n')).not.toContain(CANARY);
  });
});

const PRODUCTION_REMOTE_ID = 'c3d4e5f6-a708-4939-c5d6-e7f809a1b2c3';

describe('provisioning production safety', () => {
  it('keeps production plan read-only without confirmation', async () => {
    const harness = createHarness();
    const outcome = await runProvision(
      { target: 'rch-rugbychampagne', environment: 'production', mode: 'plan' },
      harness.io,
      harness.runner,
    );
    expect(outcome.databaseName).toBe(PRODUCTION_DB);
    expect(harness.commands.some(({ args }) => args.includes('create'))).toBe(false);
    expect(harness.writes).toEqual([]);
  });

  it('makes zero mutations for production apply without confirmation', async () => {
    const harness = createHarness();
    await expect(
      runProvision(
        { target: 'rch-rugbychampagne', environment: 'production', mode: 'apply' },
        harness.io,
        harness.runner,
      ),
    ).rejects.toThrow(new RegExp(PRODUCTION_WORKER));
    expect(harness.commands).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('makes zero mutations for production apply with the wrong confirmation', async () => {
    const harness = createHarness();
    await expect(
      runProvision(
        {
          target: 'rch-rugbychampagne',
          environment: 'production',
          mode: 'apply',
          confirm: 'PROMOTE',
        },
        harness.io,
        harness.runner,
      ),
    ).rejects.toThrow(/confirmation/i);
    expect(harness.commands).toEqual([]);
    expect(harness.writes).toEqual([]);
  });

  it('provisions production apply with the exact Worker-name confirmation', async () => {
    const harness = createHarness({
      createStdout: realCreateText(PRODUCTION_DB, PRODUCTION_REMOTE_ID),
      remotesAfterCreate: [{ name: PRODUCTION_DB, uuid: PRODUCTION_REMOTE_ID }],
    });
    const outcome = await runProvision(
      {
        target: 'rch-rugbychampagne',
        environment: 'production',
        mode: 'apply',
        confirm: PRODUCTION_WORKER,
      },
      harness.io,
      harness.runner,
    );
    const create = harness.commands.find(({ args }) => args.includes('create'));
    expect(create?.args).toEqual([
      'wrangler',
      'd1',
      'create',
      PRODUCTION_DB,
      '--update-config=false',
    ]);
    expect(outcome.d1Action).toBe('created');
    expect(outcome.databaseId).toBe(PRODUCTION_REMOTE_ID);
    expect(outcome.configUpdated).toBe(true);
    expect(harness.writes).toHaveLength(1);
    expect(harness.writes[0]?.targets[0]?.environments.production.databaseId).toBe(
      PRODUCTION_REMOTE_ID,
    );
    expect(harness.writes[0]?.targets[0]?.environments.sandbox.databaseId).toBe('');
    for (const { args } of harness.commands) {
      expect(args.join(' ')).not.toMatch(/wrangler deploy(?!ments)/);
      expect(args.join(' ')).not.toMatch(/publish|upload/);
      expect(args.join(' ')).not.toMatch(/secret (put|delete|bulk)/);
    }
  });

  it('derives the production confirmation from the target Worker name', () => {
    expect(
      productionProvisionConfirmFor({
        targetKey: 'rch-rugbychampagne',
        company: 'rch',
        site: 'rugbychampagne',
        service: 'user-service',
        environment: 'production',
        workerName: PRODUCTION_WORKER,
        databaseName: PRODUCTION_DB,
        databaseId: '',
        vars: {},
      }),
    ).toBe(PRODUCTION_WORKER);
  });

  it('never shares database identity across targets or environments', () => {
    const staged = stageProvisionedDatabaseId(
      withDatabaseId(loadTargetsFromRepo(), 'sandbox', ''),
      'rch-rugbychampagne',
      'sandbox',
      REMOTE_SANDBOX_ID,
    );
    expect(staged.targets[0]?.environments.sandbox.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(staged.targets[0]?.environments.production.databaseId).toBe('');
  });
});

describe('stageProvisionedDatabaseId', () => {
  it('updates only the selected environment database id', () => {
    const staged = stageProvisionedDatabaseId(
      loadTargetsFromRepo(),
      'rch-rugbychampagne',
      'sandbox',
      REMOTE_SANDBOX_ID,
    );
    expect(staged.targets[0]?.environments.sandbox.databaseId).toBe(REMOTE_SANDBOX_ID);
    expect(staged.targets[0]?.environments.production.databaseId).toBe('');
    expect(staged.version).toBe(1);
  });

  it('refuses unknown targets and invalid ids', () => {
    expect(() =>
      stageProvisionedDatabaseId(loadTargetsFromRepo(), 'unknown', 'sandbox', REMOTE_SANDBOX_ID),
    ).toThrow(/unknown/i);
    expect(() =>
      stageProvisionedDatabaseId(
        loadTargetsFromRepo(),
        'rch-rugbychampagne',
        'sandbox',
        'not-a-uuid',
      ),
    ).toThrow();
  });
});
