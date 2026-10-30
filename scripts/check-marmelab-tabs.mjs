import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const file = new URL('../admin/src/kit/components/ui/tabs.tsx', import.meta.url);
const expectedSource =
  'https://raw.githubusercontent.com/marmelab/shadcn-admin-kit/11983abe4afc60a3904991820526aafe4d0588d3/src/components/ui/tabs.tsx';
const expectedSha256 = '2c1e1d8a7f37b51ff9f2b200b2ff765fef9a9b083d670f25d6e2c4de37bf4a2d';
const actual = await readFile(file);
const actualSha256 = createHash('sha256').update(actual).digest('hex');

if (actualSha256 !== expectedSha256) {
  throw new Error(
    `Marmelab Tabs provenance mismatch for ${expectedSource}: expected ${expectedSha256}, got ${actualSha256}`,
  );
}
