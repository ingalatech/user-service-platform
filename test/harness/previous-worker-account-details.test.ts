import { execFile } from 'node:child_process';
import { mkdtemp, rm, symlink, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { D1Database } from '@cloudflare/workers-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

const execFileAsync = promisify(execFile);
const PRE_ACCOUNT_DETAILS_WORKER_SHA = '638e599c19da0aa93960adf8efb1e48fb487cb4e';
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const harnessState: {
  temporaryRoot?: string;
  previousWorkerRoot?: string;
  previousWorktreeCreated: boolean;
  server?: TestHarness;
} = { previousWorktreeCreated: false };

function requireHarness(): TestHarness {
  const { server } = harnessState;
  if (server === undefined) throw new Error('The previous Worker harness is not running.');
  return server;
}

// Spec #245/#246 compatibility seam: run the actual pre-#246 Worker source
// from 638e599c19da0aa93960adf8efb1e48fb487cb4e, not the current source,
// against an isolated D1 database migrated through 0009. The only file added
// to that historical worktree is migration 0009; its code remains at the
// recorded commit. CI fetches full history so this test never fetches remotely.
describe('pre-Account-Details Worker against the expanded D1 schema', () => {
  beforeAll(async () => {
    harnessState.temporaryRoot = await mkdtemp(join(tmpdir(), 'user-service-worker-638e599-'));
    harnessState.previousWorkerRoot = join(harnessState.temporaryRoot, 'worker');

    try {
      await execFileAsync(
        'git',
        [
          'worktree',
          'add',
          '--detach',
          harnessState.previousWorkerRoot,
          PRE_ACCOUNT_DETAILS_WORKER_SHA,
        ],
        { cwd: repoRoot, timeout: 30_000 },
      );
      harnessState.previousWorktreeCreated = true;
    } catch (error) {
      throw new Error(
        `Cannot prepare previous-Worker compatibility test at ${PRE_ACCOUNT_DETAILS_WORKER_SHA}; ` +
          'the checkout must include this commit (CI uses fetch-depth: 0).',
        { cause: error },
      );
    }

    const { stdout: checkedOutSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], {
      cwd: harnessState.previousWorkerRoot,
    });
    expect(checkedOutSha.trim()).toBe(PRE_ACCOUNT_DETAILS_WORKER_SHA);

    await symlink(
      join(repoRoot, 'node_modules'),
      join(harnessState.previousWorkerRoot, 'node_modules'),
    );
    await symlink(
      join(repoRoot, 'admin', 'dist'),
      join(harnessState.previousWorkerRoot, 'admin', 'dist'),
    );
    await copyFile(
      join(repoRoot, 'drizzle', '0009_cute_zarek.sql'),
      join(harnessState.previousWorkerRoot, 'drizzle', '0009_cute_zarek.sql'),
    );

    harnessState.server = createTestHarness({
      root: harnessState.previousWorkerRoot,
      workers: [
        {
          configPath: './wrangler.jsonc',
          vars: {
            AUTH_EMAIL_PASSWORD_ENABLED: 'true',
            AUTH_REGISTRATION_ENABLED: 'true',
            AUTH_REQUIRE_EMAIL_VERIFICATION: 'false',
          },
          secrets: { BETTER_AUTH_SECRET: 'isolated-worker-compatibility-test-secret' },
        },
      ],
    });
    await harnessState.server.listen();
    const previousWorker = harnessState.server.getWorker<{ DB: D1Database }>();
    await previousWorker.applyD1Migrations('DB');
    const { DB } = await previousWorker.getEnv();
    const migratedColumns = await DB.prepare('PRAGMA table_info("user")').all<{
      name: string;
    }>();
    expect(migratedColumns.results.map((column) => column.name)).toContain('first_name');
  }, 120_000);

  afterAll(async () => {
    if (harnessState.server !== undefined) await harnessState.server.close();
    if (harnessState.previousWorktreeCreated && harnessState.previousWorkerRoot !== undefined) {
      await execFileAsync(
        'git',
        ['worktree', 'remove', '--force', harnessState.previousWorkerRoot],
        {
          cwd: repoRoot,
          timeout: 30_000,
        },
      );
    }
    if (harnessState.temporaryRoot !== undefined) {
      await rm(harnessState.temporaryRoot, { recursive: true, force: true });
    }
  });

  it('registers, signs in and resolves /v1/me through the previous Worker', async () => {
    const server = requireHarness();
    const email = 'previous-worker@example.test';
    const registration = await server.fetch('/v1/auth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Legacy User', email, password: 'Correct-horse-41' }),
    });
    expect(registration.status).toBe(201);

    const login = await server.fetch('/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password: 'Correct-horse-41' }),
    });
    expect(login.status).toBe(200);
    const sessionCookie = login.headers.get('set-cookie')?.split(';')[0];
    expect(sessionCookie).toBeTruthy();

    const currentUser = await server.fetch('/v1/me', {
      headers: { cookie: sessionCookie ?? '' },
    });
    expect(currentUser.status).toBe(200);
    const body = (await currentUser.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['email', 'emailVerified', 'id']);
    expect(body).toMatchObject({
      email,
      emailVerified: false,
    });
    expect(typeof body.id).toBe('string');
  });
});
