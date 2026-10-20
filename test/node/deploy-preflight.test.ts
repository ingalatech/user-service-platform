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

function deps() {
  const commands: { command: string; args: string[] }[] = [];
  return {
    commands,
    nodeVersion: 'v24.21.0',
    run: (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args.includes('deployments')) return Promise.resolve({ exitCode: 0, stdout: '[{}]' });
      if (args.includes('status')) return Promise.resolve({ exitCode: 0, stdout: '' });
      return Promise.resolve({ exitCode: 0, stdout: '' });
    },
  };
}

describe('deployment preflight secret boundary', () => {
  it('never invokes Wrangler secret operations', async () => {
    const d = deps();
    const checks = await runPreflight({ resolved }, d);
    expect(checks.some((check) => check.name === 'worker-secrets')).toBe(false);
    expect(d.commands.some(({ args }) => args.includes('secret'))).toBe(false);
  });
});
