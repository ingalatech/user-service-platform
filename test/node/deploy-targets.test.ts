import { describe, expect, it } from 'vitest';
import {
  isProvisionedDatabaseId,
  loadTargetsFile,
  resolveTargetDeployment,
  type TargetsFile,
} from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo, provisionedTargetsForContract } from './deploy-test-utils.js';

function readTargetsFile(): TargetsFile {
  return loadTargetsFromRepo();
}

// Real database ids are provisioned out-of-band and recorded in
// deploy/targets.json (see docs/operations/sandbox-release-runbook.md), so
// resolution tests run against a provisioned copy of the versioned file.
function provisionedCopy(file: TargetsFile): TargetsFile {
  return provisionedTargetsForContract(file);
}

const CANARY = 'canary-secret-value-9f8e7d6c5b4a';

// Versioned secret-free deployment targets (ticket #78): one file owns every
// company/site target; application code never hard-codes RCH behavior.
describe('deployment targets', () => {
  it('loads the versioned target file with the first RCH target', () => {
    const targets = readTargetsFile();
    expect(targets.version).toBe(1);
    expect(targets.service).toBe('user-service');
    expect(targets.targets.map((target) => target.key)).toContain('rch-rugbychampagne');
  });

  it('resolves the RCH sandbox deployment with the ticket mail values', () => {
    const resolved = resolveTargetDeployment(provisionedCopy(readTargetsFile()), {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(resolved.environment).toBe('sandbox');
    // Ticket #88: current RCH sandbox acceptance uses provider-neutral SMTP
    // (Gmail submission via ordinary SMTP configuration, no Gmail branch).
    expect(resolved.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
    expect(resolved.vars.SMTP_HOST).toBe('smtp.gmail.com');
    expect(resolved.vars.SMTP_PORT).toBe('587');
    expect(resolved.vars.SMTP_SECURE).toBe('false');
    expect(resolved.vars.AUTH_MAIL_FROM).toBe('User Service <jonatangarbuyo@gmail.com>');
    expect(resolved.vars.AUTH_MAIL_ALLOWLIST).toBe(
      'jonatangarbuyo@gmail.com,cronistadev@gmail.com,ingaladev@gmail.com',
    );
  });

  it('resolves the RCH production worker name deterministically', () => {
    const resolved = resolveTargetDeployment(provisionedCopy(readTargetsFile()), {
      target: 'rch-rugbychampagne',
      environment: 'production',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-production');
  });

  it('rejects unknown targets and lists the available keys', () => {
    expect(() =>
      resolveTargetDeployment(readTargetsFile(), {
        target: 'unknown-site',
        environment: 'sandbox',
      }),
    ).toThrow(/rch-rugbychampagne/);
  });

  it('rejects staging as a deployment environment', () => {
    expect(() =>
      resolveTargetDeployment(readTargetsFile(), {
        target: 'rch-rugbychampagne',
        environment: 'staging',
      }),
    ).toThrow(/staging/i);
  });

  it('rejects target vars that carry runtime secrets without echoing values', () => {
    for (const secret of [
      'BETTER_AUTH_SECRET',
      'RESEND_API_KEY',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      const file = readTargetsFile();
      const target = file.targets.find((entry) => entry.key === 'rch-rugbychampagne');
      expect(target).toBeDefined();
      const poisoned: TargetsFile = {
        ...file,
        targets: file.targets.map((entry) =>
          entry.key === 'rch-rugbychampagne'
            ? {
                ...entry,
                environments: {
                  ...entry.environments,
                  sandbox: {
                    ...entry.environments.sandbox,
                    vars: { ...entry.environments.sandbox.vars, [secret]: CANARY },
                  },
                },
              }
            : entry,
        ),
      };
      let message = '';
      try {
        loadTargetsFile(poisoned);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toMatch(new RegExp(secret));
      expect(message).not.toContain(CANARY);
    }
  });

  it('rejects unknown and ENVIRONMENT vars in target configuration', () => {
    const file = readTargetsFile();
    const withUnknown: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: {
            ...entry.environments.sandbox,
            vars: { ...entry.environments.sandbox.vars, MADE_UP_VAR: 'x' },
          },
        },
      })),
    };
    expect(() => loadTargetsFile(withUnknown)).toThrow(/MADE_UP_VAR/);
  });

  it('requires a provisioned D1 database id before resolving', () => {
    const file = readTargetsFile();
    const unprovisioned: TargetsFile = {
      ...file,
      targets: file.targets.map((entry) => ({
        ...entry,
        environments: {
          ...entry.environments,
          sandbox: { ...entry.environments.sandbox, databaseId: '' },
        },
      })),
    };
    expect(() =>
      resolveTargetDeployment(unprovisioned, {
        target: 'rch-rugbychampagne',
        environment: 'sandbox',
      }),
    ).toThrow(/provision/i);
  });

  it('rejects placeholder database ids rather than deploying against them', () => {
    const file = readTargetsFile();
    for (const databaseId of [
      // Legacy synthetic 32-hex fixture (ticket #78 era, never Wrangler-issued).
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      // Uniform UUID placeholders (never real Cloudflare-issued identifiers).
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      '00000000-0000-0000-0000-000000000000',
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    ]) {
      const placeholder: TargetsFile = {
        ...file,
        targets: file.targets.map((entry) => ({
          ...entry,
          environments: {
            ...entry.environments,
            sandbox: {
              ...entry.environments.sandbox,
              databaseId,
            },
          },
        })),
      };
      expect(() =>
        resolveTargetDeployment(placeholder, {
          target: 'rch-rugbychampagne',
          environment: 'sandbox',
        }),
      ).toThrow(/provision|placeholder/i);
    }
  });

  // Ticket #83: the deployer must accept the canonical Wrangler-provisioned
  // D1 identifier shape while failing closed for empty, malformed,
  // placeholder or obviously synthetic ids (never arbitrary strings).
  it('accepts the real provisioned Cloudflare D1 UUID shape', () => {
    expect(isProvisionedDatabaseId('5a35dea8-f472-4760-b8ee-c4cbbd56ef06')).toBe(true);
  });

  it('rejects empty, malformed, placeholder and synthetic database ids', () => {
    for (const databaseId of [
      '',
      'not-a-uuid',
      'provision-later',
      'YOUR_DATABASE_ID',
      // Legacy synthetic 32-hex: never a Wrangler-issued id.
      'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      // Wrong UUID group lengths / non-hex / missing hyphens / padding.
      '5a35dea8f4724760b8eec4cbbd56ef06',
      '5a35dea8-f472-4760-b8ee-c4cbbd56ef0',
      '5a35dea8-f472-4760-b8ee-c4cbbd56ef060',
      'ga35dea8-f472-4760-b8ee-c4cbbd56ef06',
      '5a35dea8_f472_4760_b8ee_c4cbbd56ef06',
      ' 5a35dea8-f472-4760-b8ee-c4cbbd56ef06',
      '5a35dea8-f472-4760-b8ee-c4cbbd56ef06 ',
      // Uniform placeholders in UUID form.
      'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      '00000000-0000-0000-0000-000000000000',
      'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF',
    ]) {
      expect(isProvisionedDatabaseId(databaseId)).toBe(false);
    }
  });

  it('resolves the versioned RCH sandbox target with its recorded real D1 id', () => {
    const file = readTargetsFile();
    const recorded = file.targets.find((entry) => entry.key === 'rch-rugbychampagne')?.environments
      .sandbox.databaseId;
    expect(recorded).toBe('5a35dea8-f472-4760-b8ee-c4cbbd56ef06');
    const resolved = resolveTargetDeployment(file, {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    expect(resolved.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(resolved.databaseName).toBe('rch-rugbychampagne-user-service-sandbox-db');
    expect(resolved.databaseId).toBe('5a35dea8-f472-4760-b8ee-c4cbbd56ef06');
  });

  it('rejects malformed target files', () => {
    expect(() => loadTargetsFile(null)).toThrow();
    expect(() => loadTargetsFile({ version: 2, targets: [] })).toThrow(/version/);
    expect(() => loadTargetsFile({ version: 1, targets: [] })).toThrow(/target/);
  });

  it('rejects malformed non-secret Cloudflare account IDs', () => {
    const file = readTargetsFile();
    const malformed: TargetsFile = {
      ...file,
      targets: file.targets.map((target) => ({
        ...target,
        environments: {
          ...target.environments,
          sandbox: { ...target.environments.sandbox, accountId: 'not-a-cloudflare-account-id' },
        },
      })),
    };
    expect(() => loadTargetsFile(malformed)).toThrow(/32-character hexadecimal/);
  });
});
