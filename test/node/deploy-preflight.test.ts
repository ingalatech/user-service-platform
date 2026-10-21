import { describe, expect, it } from 'vitest';
import { runPreflight } from '../../scripts/deploy/preflight.js';
import {
  CLOUDFLARE_ABSENT_WORKER_10007,
  CLOUDFLARE_ABSENT_WORKER_WRANGLER_STDERR,
} from './fixtures/cloudflare-absent-worker.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';

const resolved: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  workerUrl: 'https://sandbox.example.test',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b',
  vars: { AUTH_MAIL_TRANSPORT: 'smtp' },
};

function deps(
  workerResult: { exitCode: number; stdout: string; stderr?: string } = {
    exitCode: 0,
    stdout: '[{}]',
  },
) {
  const commands: { command: string; args: string[] }[] = [];
  return {
    commands,
    nodeVersion: 'v24.21.0',
    run: (command: string, args: string[]) => {
      commands.push({ command, args });
      if (args.includes('deployments')) return Promise.resolve(workerResult);
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

  it('classifies the provider absent-Worker 10007 fixture as first-deploy safe', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({ exitCode: 1, stdout: '', stderr: CLOUDFLARE_ABSENT_WORKER_10007 }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toEqual({
      name: 'worker-presence',
      ok: true,
      detail: 'Worker absent; first deploy is allowed',
    });
  });

  it('fails closed for a discovery error other than Cloudflare 10007', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({ exitCode: 1, stdout: '', stderr: 'Code: 10006\nMessage: forbidden' }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toMatchObject({
      ok: false,
    });
    expect(checks.map((check) => check.detail).join('\n')).not.toContain('forbidden');
  });

  it('does not classify 10007 embedded in another Cloudflare error message', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({
        exitCode: 1,
        stdout: '',
        stderr: JSON.stringify({
          success: false,
          errors: [{ code: 10006, message: 'upstream code: 10007' }],
        }),
      }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toMatchObject({ ok: false });
  });

  it('does not classify 10007 nested in metadata as a Cloudflare error', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({
        exitCode: 1,
        stdout: '',
        stderr: JSON.stringify({
          success: false,
          errors: [{ code: 10006, message: 'forbidden', metadata: { code: 10007 } }],
        }),
      }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toMatchObject({ ok: false });
  });

  it('does not classify malformed provider output', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({
        exitCode: 1,
        stdout: '',
        stderr:
          '{"errors":[{"code":10007,"message":"workers.api.error.script_not_found"}], ' +
          '"success":false',
      }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toMatchObject({ ok: false });
  });

  it('classifies the ANSI-rendered Wrangler absent-Worker fixture', async () => {
    const checks = await runPreflight(
      { resolved },
      deps({ exitCode: 1, stdout: '', stderr: CLOUDFLARE_ABSENT_WORKER_WRANGLER_STDERR }),
    );
    expect(checks.find((check) => check.name === 'worker-presence')).toMatchObject({ ok: true });
  });
});
