import { describe, expect, it } from 'vitest';
import {
  formatPreflightError,
  preflightFailed,
  runPreflight,
  type PreflightCommand,
  type PreflightDeps,
} from '../../scripts/deploy/preflight.js';
import { resolveTargetDeployment } from '../../scripts/deploy/targets.js';
import type { ResolvedDeployment } from '../../scripts/deploy/targets.js';
import { CONTRACT_SANDBOX_DATABASE_ID, loadTargetsFromRepo } from './deploy-test-utils.js';

const RESOLVED: ResolvedDeployment = {
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

const CANARY_API_TOKEN = 'canary-cloudflare-token-abcdef123456';
const CANARY_AUTH_SECRET = 'canary-better-auth-secret-7890';

function passingDeps(overrides: Partial<PreflightDeps> = {}): PreflightDeps {
  const commands: PreflightCommand[] = [];
  return {
    nodeVersion: 'v24.21.0',
    commands,
    run: (command, args) => {
      commands.push({ command, args: [...args] });
      if (command === 'git') {
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }
      if (command === 'npx' && args.includes('deployments')) {
        return Promise.resolve({ exitCode: 0, stdout: '[{"id":"deployment-1"}]' });
      }
      if (command === 'npx' && args.includes('secret')) {
        // Ticket #106: names/types-only listing for the resend-transport
        // RESOLVED fixture (`BETTER_AUTH_SECRET` + `RESEND_API_KEY`).
        return Promise.resolve({
          exitCode: 0,
          stdout: JSON.stringify([
            { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
            { name: 'RESEND_API_KEY', type: 'secret_text' },
          ]),
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: 'ok' });
    },
    ...overrides,
  };
}

// Names/types-only secret-listing stub for the ticket #106 binding-type gate.
// `entries` is serialized as the provider output; pass a raw string to
// simulate unexpected output.
function secretListDeps(entries: unknown, exitCode = 0): PreflightDeps {
  const commands: PreflightCommand[] = [];
  return {
    nodeVersion: 'v24.21.0',
    commands,
    run: (command, args) => {
      commands.push({ command, args: [...args] });
      if (command === 'git') {
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }
      if (command === 'npx' && args.includes('deployments')) {
        return Promise.resolve({ exitCode: 0, stdout: '[{"id":"deployment-1"}]' });
      }
      if (command === 'npx' && args.includes('secret')) {
        return Promise.resolve({
          exitCode,
          stdout: typeof entries === 'string' ? entries : JSON.stringify(entries),
        });
      }
      return Promise.resolve({ exitCode: 0, stdout: 'ok' });
    },
  };
}

const SANDBOX_SMTP: ResolvedDeployment = {
  ...RESOLVED,
  vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
};

const SANDBOX_SECRET_TEXT = [
  { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
  { name: 'SMTP_USER', type: 'secret_text' },
  { name: 'SMTP_PASSWORD', type: 'secret_text' },
];

// Deployment preflight (ticket #78): every remote mutation is preceded by
// Node/Wrangler/auth/account, worktree, target-config and resource checks.
// Secret values are never inspected, printed, or uploaded.
describe('deployment preflight', () => {
  it('passes for a provisioned target in a clean authenticated worktree', async () => {
    const deps = passingDeps();
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(false);
    expect(checks.map((check) => check.name)).toEqual([
      'node',
      'wrangler',
      'cloudflare-auth',
      'account-access',
      'worktree',
      'target-config',
      'worker-name',
      'worker-presence',
      'worker-secrets',
    ]);
  });

  it('allows an absent Worker without attempting remote secret listing', async () => {
    const deps = passingDeps({
      run: (command, args) => {
        if (command === 'git') return Promise.resolve({ exitCode: 0, stdout: '' });
        if (args.includes('deployments')) return Promise.resolve({ exitCode: 0, stdout: '[]' });
        if (args.includes('secret')) {
          throw new Error('secret listing is not applicable to an absent Worker');
        }
        return Promise.resolve({ exitCode: 0, stdout: 'ok' });
      },
    });
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(false);
    expect(checks.find((check) => check.name === 'worker-secrets')?.detail).toMatch(/absent/);
  });

  it('fails closed on existing Worker secret listing failure', async () => {
    const deps = passingDeps({
      run: (command, args) => {
        if (command === 'npx' && args.includes('deployments')) {
          return Promise.resolve({ exitCode: 0, stdout: '[{"id":"deployment-1"}]' });
        }
        if (command === 'npx' && args.includes('secret')) {
          return Promise.resolve({ exitCode: 1, stdout: '' });
        }
        return Promise.resolve({ exitCode: 0, stdout: '' });
      },
    });
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/worker-secrets/);
  });

  it('refuses when Cloudflare account access fails', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (args.includes('d1')) {
            return Promise.resolve({ exitCode: 1, stdout: 'forbidden' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/account/i);
  });

  it('issues only read-only commands during preflight', async () => {
    const deps = passingDeps();
    await runPreflight({ resolved: RESOLVED }, deps);
    for (const { command, args } of deps.commands) {
      const text = `${command} ${args.join(' ')}`;
      expect(text).not.toMatch(/migrate|delete/);
      expect(text).not.toMatch(/secret (put|delete|bulk)/);
    }
    // Ticket #106: the only secret operation is the names/types-only listing
    // (`secret list --format json --name <worker>`); secret values are never
    // fetched, and mutating secret subcommands never run.
    const secretCalls = deps.commands.filter((entry) => entry.args.includes('secret'));
    expect(secretCalls).toHaveLength(1);
    expect(secretCalls[0]).toEqual({
      command: 'npx',
      args: ['wrangler', 'secret', 'list', '--format', 'json', '--name', RESOLVED.workerName],
    });
  });

  it('refuses outdated Node runtimes', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({ nodeVersion: 'v22.14.0' }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/node/i);
  });

  it('refuses when Wrangler is unavailable', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (command === 'npx' && args[1] === '--version') {
            return Promise.resolve({ exitCode: 1, stdout: 'no wrangler' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
  });

  it('refuses when Cloudflare authentication fails', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command, args) => {
          if (args.includes('whoami')) {
            return Promise.resolve({ exitCode: 1, stdout: 'not logged in' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/auth/i);
  });

  it('refuses a dirty worktree before remote mutation', async () => {
    const checks = await runPreflight(
      { resolved: RESOLVED },
      passingDeps({
        run: (command) => {
          if (command === 'git') {
            return Promise.resolve({ exitCode: 0, stdout: 'M wrangler.jsonc\n' });
          }
          return Promise.resolve({ exitCode: 0, stdout: '' });
        },
      }),
    );
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/worktree/i);
  });

  it('refuses an unprovisioned database id', async () => {
    const checks = await runPreflight({ resolved: { ...RESOLVED, databaseId: '' } }, passingDeps());
    expect(preflightFailed(checks)).toBe(true);
  });

  it('never leaks secret values into preflight results', async () => {
    const deps = passingDeps({
      run: () =>
        Promise.resolve({
          exitCode: 1,
          stdout: `token ${CANARY_API_TOKEN} secret ${CANARY_AUTH_SECRET}`,
        }),
    });
    const checks = await runPreflight({ resolved: RESOLVED }, deps);
    expect(preflightFailed(checks)).toBe(true);
    const serialized = JSON.stringify(checks);
    expect(serialized).not.toContain(CANARY_API_TOKEN);
    expect(serialized).not.toContain(CANARY_AUTH_SECRET);
  });
});

// Ticket #106 binding-type gate: every required name must exist specifically
// as a Cloudflare `secret_text` binding. A same-name plaintext `vars` entry
// never satisfies the check, and failures happen in preflight — before
// `wrangler deploy` and smoke — with names/status only.
describe('worker secret_text binding gate', () => {
  it('requires exactly the RCH sandbox secret set as secret_text', async () => {
    const resolved = resolveTargetDeployment(loadTargetsFromRepo(), {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    const deps = secretListDeps(SANDBOX_SECRET_TEXT);
    const checks = await runPreflight({ resolved }, deps);
    expect(preflightFailed(checks)).toBe(false);
    const secretCall = deps.commands.find((entry) => entry.args.includes('secret'));
    expect(secretCall?.args).toEqual([
      'wrangler',
      'secret',
      'list',
      '--format',
      'json',
      '--name',
      'rch-rugbychampagne-user-service-sandbox',
    ]);
  });

  it('fails when one required sandbox secret is missing', async () => {
    const deps = secretListDeps([
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
    ]);
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/SMTP_PASSWORD.*missing/);
  });

  it('fails when a required name is plaintext rather than secret_text', async () => {
    const deps = secretListDeps([
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'SMTP_USER', type: 'secret_text' },
      { name: 'SMTP_PASSWORD', type: 'plaintext' },
    ]);
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/SMTP_PASSWORD/);
  });

  it('ignores extra unrelated secrets', async () => {
    const deps = secretListDeps([
      ...SANDBOX_SECRET_TEXT,
      { name: 'SOME_OTHER_SECRET', type: 'secret_text' },
    ]);
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(false);
  });

  it('fails closed when the secret listing fails', async () => {
    const deps = secretListDeps([], 1);
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(true);
    const message = formatPreflightError(checks).message;
    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).toMatch(/SMTP_USER/);
    expect(message).toMatch(/SMTP_PASSWORD/);
  });

  it('fails closed on unexpected secret list output', async () => {
    const deps = secretListDeps('ok');
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(true);
  });

  it('never consumes value fields from the secret listing', async () => {
    const deps = secretListDeps(
      SANDBOX_SECRET_TEXT.map((entry) => ({ ...entry, value: CANARY_AUTH_SECRET })),
    );
    const checks = await runPreflight({ resolved: SANDBOX_SMTP }, deps);
    expect(preflightFailed(checks)).toBe(false);
    expect(JSON.stringify(checks)).not.toContain(CANARY_AUTH_SECRET);
  });

  it('verifies the production Resend required set', async () => {
    const production: ResolvedDeployment = {
      ...RESOLVED,
      environment: 'production',
      workerName: 'rch-rugbychampagne-user-service-production',
      vars: { AUTH_MAIL_TRANSPORT: 'resend' },
    };
    const passing = secretListDeps([
      { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
      { name: 'RESEND_API_KEY', type: 'secret_text' },
    ]);
    expect(preflightFailed(await runPreflight({ resolved: production }, passing))).toBe(false);
    const missing = secretListDeps([{ name: 'BETTER_AUTH_SECRET', type: 'secret_text' }]);
    const checks = await runPreflight({ resolved: production }, missing);
    expect(preflightFailed(checks)).toBe(true);
    expect(formatPreflightError(checks).message).toMatch(/RESEND_API_KEY.*missing/);
  });
});
