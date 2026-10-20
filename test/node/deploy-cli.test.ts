import { describe, expect, it } from 'vitest';
import { parseDeployArgs, resolveDeploySelection } from '../../scripts/deploy/cli.js';

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
});
