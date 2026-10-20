import { describe, expect, it } from 'vitest';
import { runPreflight } from '../../scripts/deploy/preflight.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';

const resolved: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b',
  vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
};

function deps(secretOutput: string, secretExitCode = 0) {
  const commands: { command: string; args: string[] }[] = [];
  return {
    commands,
    nodeVersion: 'v24.21.0',
    run: (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args.includes('secret'))
        return Promise.resolve({ exitCode: secretExitCode, stdout: secretOutput });
      if (args.includes('deployments')) return Promise.resolve({ exitCode: 0, stdout: '[{}]' });
      if (args.includes('status')) return Promise.resolve({ exitCode: 0, stdout: '' });
      return Promise.resolve({ exitCode: 0, stdout: '' });
    },
  };
}

describe('deployment preflight secret gate', () => {
  it('requires SMTP and auth secrets as secret_text bindings', async () => {
    const d = deps(
      JSON.stringify([
        { name: 'BETTER_AUTH_SECRET', type: 'secret_text' },
        { name: 'SMTP_USER', type: 'secret_text' },
        { name: 'SMTP_PASSWORD', type: 'secret_text' },
      ]),
    );
    const checks = await runPreflight({ resolved }, d);
    expect(checks.find((check) => check.name === 'worker-secrets')?.ok).toBe(true);
  });

  it('rejects a plaintext binding and never includes secret values', async () => {
    const d = deps(
      JSON.stringify([{ name: 'BETTER_AUTH_SECRET', type: 'plain_text' }, { value: 'canary' }]),
    );
    const checks = await runPreflight({ resolved }, d);
    const check = checks.find((entry) => entry.name === 'worker-secrets');
    expect(check?.ok).toBe(false);
    expect(JSON.stringify(checks)).not.toContain('canary');
  });
});
