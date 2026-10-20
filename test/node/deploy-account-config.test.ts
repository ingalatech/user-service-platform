import { describe, expect, it } from 'vitest';
import {
  applyAccountOverrides,
  loadAccountOverrides,
  resolveCloudflareAccountId,
} from '../../scripts/deploy/account-config.js';
import { loadTargetsFromRepo } from './deploy-test-utils.js';

const VERSIONED = '11111111111111111111111111111111';
const LOCAL = '22222222222222222222222222222222';
const PROCESS = '33333333333333333333333333333333';

describe('Cloudflare account configuration', () => {
  it('uses versioned account id when there are no overrides', () => {
    expect(resolveCloudflareAccountId(VERSIONED)).toBe(VERSIONED);
  });

  it('applies local per-target/environment override after versioned configuration', () => {
    const overrides = loadAccountOverrides({
      version: 1,
      targets: { 'rch-rugbychampagne': { sandbox: LOCAL } },
    });
    expect(
      resolveCloudflareAccountId(VERSIONED, overrides.targets['rch-rugbychampagne']?.sandbox),
    ).toBe(LOCAL);
  });

  it('gives CLOUDFLARE_ACCOUNT_ID final precedence', () => {
    expect(resolveCloudflareAccountId(VERSIONED, LOCAL, PROCESS)).toBe(PROCESS);
  });

  it('applies account precedence only to the matching target and environment', () => {
    const base = loadTargetsFromRepo();
    const overridden = applyAccountOverrides(
      base,
      loadAccountOverrides({
        version: 1,
        targets: { 'rch-rugbychampagne': { sandbox: LOCAL } },
      }),
    );
    expect(overridden.targets[0]?.environments.sandbox.accountId).toBe(LOCAL);
    expect(overridden.targets[0]?.environments.production.accountId).toBe('');
    expect(
      applyAccountOverrides(base, loadAccountOverrides({ version: 1, targets: {} }), PROCESS)
        .targets[0]?.environments.production.accountId,
    ).toBe(PROCESS);
  });

  it('rejects malformed IDs without echoing configured values', () => {
    const malformed = 'not-an-account-id-secretish';
    let message = '';
    try {
      resolveCloudflareAccountId(malformed);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/account id/i);
    expect(message).not.toContain(malformed);
  });

  it('fails closed when no account is configured for the selected target', () => {
    expect(() => resolveCloudflareAccountId('')).toThrow(/no Cloudflare account ID configured/i);
  });
});
