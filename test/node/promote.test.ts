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
  it('renders and selects the id from a Wrangler version record', () => {
    const prepared = preparePromotionVersions([
      {
        id: 'immutable-v1',
        metadata: { created_on: '2026-10-20T12:00:00Z' },
        annotations: {
          'workers/message': 'commit=abc branch=main',
          'workers/tag': 'candidate',
        },
      },
    ]);

    expect(prepared.display).toEqual([
      'immutable-v1 2026-10-20T12:00:00Z workers/message=commit=abc branch=main workers/tag=candidate',
    ]);
    expect(prepared.versions[0]?.id).toBe('immutable-v1');
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
