import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);

// Regenerates the external consumer TypeScript contracts from the
// source-generated OpenAPI document (ADR-0007, ticket #152). The generated
// file is an output: never hand-edit it. CI fails on drift
// (`npm run consumer:check`) so the shipped client cannot silently diverge
// from the published contract. The generator runs in the isolated
// tools/consumer-codegen workspace under its scoped TypeScript 5 exception
// (ADR-0006); application/admin remain on TypeScript 6.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const input = resolve(root, 'openapi', 'openapi.json');
const outDir = resolve(root, 'src', 'features', 'identity', 'consumer-client', 'generated');
const outPath = resolve(outDir, 'api.d.ts');

await mkdir(outDir, { recursive: true });
await exec(process.execPath, ['tools/consumer-codegen/generate.mjs', input, outPath], {
  cwd: root,
  timeout: 120_000,
  maxBuffer: 4 * 1024 * 1024,
});

console.log(`Consumer API types written to ${outPath}`);
