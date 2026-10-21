import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const exec = promisify(execFile);

// Seam under test (ADR-0007, ticket #152): the generated external consumer
// contracts. These tests prove the committed artifact regenerates
// byte-identically from the source OpenAPI document with openapi-typescript
// (drift fails the gate), covers the consumer operations, and stays
// independent of server internals — generated code is never hand edited.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const generatedPath = join(
  root,
  'src',
  'features',
  'identity',
  'consumer-client',
  'generated',
  'api.d.ts',
);

describe('generated consumer contracts', () => {
  it('regenerates byte-identically from the source OpenAPI document', async () => {
    const committed = await readFile(generatedPath, 'utf8');
    const state = await mkdtemp(join(tmpdir(), 'consumer-client-drift-'));
    try {
      const outPath = join(state, 'api.d.ts');
      await exec(
        process.execPath,
        [
          join(root, 'tools', 'consumer-codegen', 'generate.mjs'),
          join(root, 'openapi', 'openapi.json'),
          outPath,
        ],
        { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      );
      expect(await readFile(outPath, 'utf8')).toBe(committed);
    } finally {
      await rm(state, { recursive: true, force: true });
    }
  }, 120_000);

  it('covers the consumer operations without server-internal dependencies', async () => {
    const generated = await readFile(generatedPath, 'utf8');

    for (const operation of [
      'registerIdentity',
      'loginIdentity',
      'getCurrentUser',
      'signOutIdentity',
      'issueConsumerToken',
      'getConsumerJwks',
    ]) {
      expect(generated).toContain(operation);
    }
    for (const internal of ['hono', 'better-auth', 'drizzle-orm', 'drizzle-kit', 'D1Database']) {
      expect(generated).not.toContain(internal);
    }
  });
});
