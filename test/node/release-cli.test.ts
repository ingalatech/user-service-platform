import { describe, expect, it } from 'vitest';
import { parseDeployArgs } from '../../scripts/deploy/cli.js';
import { parseProvisionArgs } from '../../scripts/deploy/provision-cli.js';

describe('release command selection', () => {
  it('selects only a canonical deploy environment', () => {
    expect(parseDeployArgs(['--env', 'sandbox', '--non-interactive'])).toMatchObject({
      environment: 'sandbox',
      nonInteractive: true,
    });
    expect(() => parseDeployArgs(['--target', 'rch-rugbychampagne'])).toThrow(/unknown/i);
  });

  it('selects sandbox provisioning without a target or account override', () => {
    expect(parseProvisionArgs(['--env', 'sandbox', '--apply'])).toMatchObject({
      environment: 'sandbox',
      mode: 'apply',
    });
    expect(() => parseProvisionArgs(['--target', 'rch-rugbychampagne'])).toThrow(/unknown/i);
  });
});
