import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChildProcessReleaseAdapter } from '../../scripts/deploy/process.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('child-process release adapter', () => {
  it('captures the process result without writing captured output to operator logs', async () => {
    const processAdapter = createChildProcessReleaseAdapter();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(
      processAdapter.run(process.execPath, ['-e', 'process.stdout.write("captured")']),
    ).resolves.toEqual({ exitCode: 0, stdout: 'captured' });
    expect(log).not.toHaveBeenCalled();
  });

  it('normalizes a child-process failure to a nonzero outcome', async () => {
    const processAdapter = createChildProcessReleaseAdapter();

    await expect(
      processAdapter.run(process.execPath, ['-e', 'process.exitCode = 7']),
    ).resolves.toMatchObject({ exitCode: 1 });
  });
});
