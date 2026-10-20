import { describe, expect, it } from 'vitest';
import {
  loadEnvironmentFile,
  type EnvironmentFile,
} from '../../scripts/deploy/environment-config.js';
import { runProvision } from '../../scripts/deploy/provision.js';

const D1_ID = 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b';

function environment(overrides: Partial<EnvironmentFile> = {}): EnvironmentFile {
  return { ...loadEnvironmentFile('config/environments/.env.sandbox'), ...overrides };
}

function runner(outputs: string[]) {
  const calls: string[][] = [];
  return {
    calls,
    run: (_command: string, args: readonly string[]) => {
      calls.push([...args]);
      return Promise.resolve({ exitCode: 0, stdout: outputs.shift() ?? '[]' });
    },
  };
}

describe('sandbox D1 provisioning', () => {
  it('creates and stages an exact-name D1 id', async () => {
    const ioFile = environment();
    const io = { file: ioFile, logs: [] as string[] };
    const commands = runner([
      '[]',
      '{}',
      JSON.stringify([{ name: ioFile.D1_NAME, uuid: D1_ID }]),
      '[]',
    ]);
    const outcome = await runProvision(
      { environment: 'sandbox', mode: 'apply' },
      {
        loadEnvironment: () => io.file,
        writeEnvironment: (file) => {
          io.file = file;
        },
        log: (message) => io.logs.push(message),
      },
      commands.run,
    );
    expect(outcome.d1Action).toBe('created');
    expect(io.file.D1_ID).toBe(D1_ID);
    expect(commands.calls.some((args) => args.includes('d1') && args.includes('create'))).toBe(
      true,
    );
  });

  it('adopts an existing exact-name D1 and rejects mismatches', async () => {
    const file = environment({ D1_ID: D1_ID });
    const commands = runner([JSON.stringify([{ name: file.D1_NAME, uuid: D1_ID }]), '[]']);
    const outcome = await runProvision(
      { environment: 'sandbox', mode: 'plan' },
      { loadEnvironment: () => file, writeEnvironment: () => undefined, log: () => undefined },
      commands.run,
    );
    expect(outcome.d1Action).toBe('ok');

    const mismatch = runner([
      JSON.stringify([{ name: file.D1_NAME, uuid: 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c' }]),
    ]);
    await expect(
      runProvision(
        { environment: 'sandbox', mode: 'plan' },
        { loadEnvironment: () => file, writeEnvironment: () => undefined, log: () => undefined },
        mismatch.run,
      ),
    ).rejects.toThrow(/disagrees/);
  });

  it('rejects duplicate exact-name discovery before creation', async () => {
    const file = environment();
    const commands = runner([
      JSON.stringify([
        { name: file.D1_NAME, uuid: D1_ID },
        { name: file.D1_NAME, uuid: 'b2c3d4e5-f607-4828-b4c5-d6e7f90a1b2c' },
      ]),
    ]);
    await expect(
      runProvision(
        { environment: 'sandbox', mode: 'apply' },
        { loadEnvironment: () => file, writeEnvironment: () => undefined, log: () => undefined },
        commands.run,
      ),
    ).rejects.toThrow(/duplicate/);
    expect(commands.calls).toHaveLength(1);
  });
});
