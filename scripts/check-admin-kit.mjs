import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { URL } from 'node:url';

const file = new URL('../admin/src/kit/shadcn-tailwind.css', import.meta.url);
const expected = '4c371f7a1ff5d219ae2f7ff28bd256b4346fd546fe46fbae22092e57db2f0fae';
const actual = createHash('sha256')
  .update(await readFile(file))
  .digest('hex');

if (actual !== expected) {
  throw new Error(`Unexpected shadcn tailwind.css SHA-256: ${actual}`);
}
