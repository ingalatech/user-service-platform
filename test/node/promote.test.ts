import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
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
  vars: {},
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
      '1) immutable-v1 2026-10-20T12:00:00Z workers/message=commit=abc branch=main workers/tag=candidate',
    ]);
    expect(prepared.versions[0]?.id).toBe('immutable-v1');
  });

  it('spawns readiness with only the versioned sandbox URL and execution path', async () => {
    let invocation:
      | {
          readonly command: string;
          readonly args: readonly string[];
          readonly env: NodeJS.ProcessEnv;
        }
      | undefined;
    const child = new EventEmitter();
    const spawnFn: PromotionSmokeSpawn = (command, args, options) => {
      invocation = { command, args, env: options.env };
      queueMicrotask(() => child.emit('close', 0));
      return child;
    };
    process.env.SMOKE_SANDBOX_BASE_URL = 'https://inherited.example.test';
    process.env.SMTP_PASSWORD = 'must-not-enter-smoke';
    try {
      await runPromotionSmoke(SANDBOX, spawnFn);
    } finally {
      delete process.env.SMOKE_SANDBOX_BASE_URL;
      delete process.env.SMTP_PASSWORD;
    }

    expect(invocation).toEqual({
      command: 'npm',
      args: ['run', 'smoke:readiness'],
      env: {
        PATH: process.env.PATH,
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.test',
      },
    });
  });
});
