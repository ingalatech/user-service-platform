import { describe, expect, it } from 'vitest';
import {
  parseProvisionArgs,
  PROVISION_HELP,
  resolveProvisionSelection,
} from '../../scripts/deploy/provision-cli.js';

describe('provision CLI selection', () => {
  it('accepts sandbox environment selection and apply mode', () => {
    const parsed = parseProvisionArgs(['--env', 'sandbox', '--apply']);
    expect(parsed).toMatchObject({ environment: 'sandbox', mode: 'apply' });
    expect(resolveProvisionSelection(parsed, { interactive: false })).toEqual({
      environment: 'sandbox',
    });
  });

  it('rejects target selection and production provisioning selection', () => {
    expect(() => parseProvisionArgs(['--target', 'rch-rugbychampagne'])).toThrow(/unknown/i);
    expect(parseProvisionArgs(['--env', 'production']).environment).toBe('production');
  });

  it('documents sandbox-only provisioning without a production confirmation flag', () => {
    expect(PROVISION_HELP).toContain('--env <sandbox>');
    expect(PROVISION_HELP).toContain('sandbox environment');
    expect(PROVISION_HELP).not.toContain('--confirm <worker-name>');
    expect(PROVISION_HELP).not.toContain('production apply');
  });
});
