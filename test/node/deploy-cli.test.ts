import { describe, expect, it } from 'vitest';
import { parseDeployArgs, resolveDeploySelection } from '../../scripts/deploy/cli.js';
import { promptDeploySelection } from '../../scripts/deploy.js';

describe('deploy CLI selection', () => {
  it('accepts only --env and non-secret confirmation controls', () => {
    expect(parseDeployArgs(['--env', 'sandbox', '--non-interactive'])).toMatchObject({
      environment: 'sandbox',
      nonInteractive: true,
    });
    expect(() => parseDeployArgs(['--target', 'rch-rugbychampagne'])).toThrow(/unknown/i);
  });

  it('requires an environment in non-interactive mode', () => {
    expect(() =>
      resolveDeploySelection(parseDeployArgs(['--non-interactive']), { interactive: false }),
    ).toThrow(/environment/i);
  });

  it('visually selects a dry-run environment while preserving dry-run', async () => {
    let prompts = 0;
    let question = '';
    const selected = await promptDeploySelection(parseDeployArgs(['--dry-run']), true, (prompt) => {
      prompts += 1;
      question = prompt;
      return Promise.resolve(1);
    });

    expect(selected).toMatchObject({ environment: 'production', dryRun: true });
    expect(prompts).toBe(1);
    expect(question).toContain('dry-run: no changes will be made');
  });

  it('does not prompt when --env accompanies --dry-run', async () => {
    const selected = await promptDeploySelection(
      parseDeployArgs(['--env', 'sandbox', '--dry-run']),
      true,
      () => Promise.reject(new Error('prompt must not run')),
    );

    expect(selected).toMatchObject({ environment: 'sandbox', dryRun: true });
  });
});
