import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { LOCAL_PROFILE } from '../../src/config/index.js';
import {
  preparePromotionVersions,
  runPromotionSmoke,
  type PromotionSmokeSpawn,
} from '../../scripts/promote.js';
import type { ResolvedDeployment } from '../../scripts/deploy/environment-config.js';
import { CONTRACT_SANDBOX_DATABASE_ID } from './deploy-test-utils.js';

const SANDBOX: ResolvedDeployment = {
  targetKey: 'rch-rugbychampagne',
  company: 'rch',
  site: 'rugbychampagne',
  service: 'user-service',
  environment: 'sandbox',
  workerName: 'rch-rugbychampagne-user-service-sandbox',
  workerUrl: 'https://sandbox.example.test',
  databaseName: 'rch-rugbychampagne-user-service-sandbox-db',
  databaseId: CONTRACT_SANDBOX_DATABASE_ID,
  applicationConfig: { ...LOCAL_PROFILE, ENVIRONMENT: 'sandbox' },
};

const PRODUCTION: ResolvedDeployment = {
  ...SANDBOX,
  environment: 'production',
  workerName: 'rch-rugbychampagne-user-service-production',
  workerUrl: 'https://production.example.test',
  databaseName: 'rch-rugbychampagne-user-service-production-db',
};

describe('promotion CLI version selection', () => {
  it('shows every version in descending order as one-line clean options', () => {
    const prepared = preparePromotionVersions(
      Array.from({ length: 12 }, (_, index) => ({
        id: `immutable-v${String(index + 1)}`,
        metadata: { created_on: `2026-10-${String(index + 1).padStart(2, '0')}T12:00:00Z` },
        annotations: {
          'workers/message': `very long technical annotation ${'x'.repeat(200)}`,
          ...(index % 2 === 0 ? { 'workers/tag': `candidate-${String(index + 1)}` } : {}),
        },
      })),
    );

    expect(prepared.versions.map((version) => version.id)).toEqual([
      'immutable-v12',
      'immutable-v11',
      'immutable-v10',
      'immutable-v9',
      'immutable-v8',
      'immutable-v7',
      'immutable-v6',
      'immutable-v5',
      'immutable-v4',
      'immutable-v3',
      'immutable-v2',
      'immutable-v1',
    ]);
    expect(prepared.display).toEqual([
      'untagged — immutable-v12 — 2026-10-12T12:00:00.000Z',
      'candidate-11 — immutable-v11 — 2026-10-11T12:00:00.000Z',
      'untagged — immutable-v10 — 2026-10-10T12:00:00.000Z',
      'candidate-9 — immutable-v9 — 2026-10-09T12:00:00.000Z',
      'untagged — immutable-v8 — 2026-10-08T12:00:00.000Z',
      'candidate-7 — immutable-v7 — 2026-10-07T12:00:00.000Z',
      'untagged — immutable-v6 — 2026-10-06T12:00:00.000Z',
      'candidate-5 — immutable-v5 — 2026-10-05T12:00:00.000Z',
      'untagged — immutable-v4 — 2026-10-04T12:00:00.000Z',
      'candidate-3 — immutable-v3 — 2026-10-03T12:00:00.000Z',
      'untagged — immutable-v2 — 2026-10-02T12:00:00.000Z',
      'candidate-1 — immutable-v1 — 2026-10-01T12:00:00.000Z',
    ]);
    expect(prepared.display.every((choice) => !choice.includes('technical annotation'))).toBe(true);
  });

  it('spawns environment-specific promotion smokes with only versioned URLs', async () => {
    const invocations: {
      readonly command: string;
      readonly args: readonly string[];
      readonly env: NodeJS.ProcessEnv;
    }[] = [];
    const spawnFn: PromotionSmokeSpawn = (command, args, options) => {
      const child = new EventEmitter();
      invocations.push({ command, args, env: options.env });
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    process.env.SMOKE_SANDBOX_BASE_URL = 'https://inherited.example.test';
    process.env.SMTP_PASSWORD = 'must-not-enter-smoke';
    try {
      await runPromotionSmoke(SANDBOX, SANDBOX.workerUrl, spawnFn);
      await runPromotionSmoke(PRODUCTION, PRODUCTION.workerUrl, spawnFn);
    } finally {
      delete process.env.SMOKE_SANDBOX_BASE_URL;
      delete process.env.SMTP_PASSWORD;
    }

    expect(invocations).toEqual([
      {
        command: 'npm',
        args: ['run', 'smoke:readiness'],
        env: {
          PATH: process.env.PATH,
          SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.test',
        },
      },
      {
        command: 'npm',
        args: ['run', 'smoke:production'],
        env: {
          PATH: process.env.PATH,
          SMOKE_PRODUCTION_BASE_URL: 'https://production.example.test',
        },
      },
    ]);
  });
});
