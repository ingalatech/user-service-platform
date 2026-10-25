import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectory = resolve(root, 'admin', 'src', 'generated');
const openApiPath = resolve(root, 'openapi', 'openapi.json');
const generatedTypesPath = resolve(generatedDirectory, 'api.d.ts');
const runtimeSchemasPath = resolve(generatedDirectory, 'contracts.js');
const runtimeSchemaDeclarationsPath = resolve(generatedDirectory, 'contracts.d.ts');

// Types come from the generated OpenAPI document. Runtime schemas are bundled
// from their canonical Identity/Problem Details Zod source modules so Admin
// does not import the server source tree and does not maintain duplicate
// validators.
await mkdir(generatedDirectory, { recursive: true });
await exec(
  process.execPath,
  ['tools/consumer-codegen/generate.mjs', openApiPath, generatedTypesPath],
  { cwd: root, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
);

const bundle = await build({
  entryPoints: [resolve(root, 'scripts', 'admin-contract-source.ts')],
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'es2022',
  external: ['@hono/zod-openapi', 'zod'],
  outfile: runtimeSchemasPath,
  write: false,
  logLevel: 'silent',
});
const runtimeSchemaBundle = bundle.outputFiles[0];
if (runtimeSchemaBundle === undefined) {
  throw new Error('Admin runtime contract bundling produced no output.');
}
await writeFile(runtimeSchemasPath, runtimeSchemaBundle.contents);

const declarations = `import type { ZodType } from 'zod';
import type { components, operations } from './api.js';

export type AdminMe = components['schemas']['AdminMe'];
export type AdminUser = components['schemas']['AdminUser'];
export type AdminUserList = components['schemas']['AdminUserList'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type ProblemDetails = components['schemas']['ProblemDetails'];

type AdminUserListQueryParameters = NonNullable<
  operations['listAdminUsers']['parameters']['query']
>;
type AdminUserDetailPathParameters = operations['getAdminUser']['parameters']['path'];
export type AdminUserDetailParams = {
  userId: AdminUserDetailPathParameters['userId'];
};
export type AdminUserListQuery = {
  limit: NonNullable<AdminUserListQueryParameters['limit']>;
  offset: NonNullable<AdminUserListQueryParameters['offset']>;
  email?: AdminUserListQueryParameters['email'];
};

export declare const AdminMeSchema: ZodType<AdminMe>;
export declare const AdminUserDetailParamsSchema: ZodType<AdminUserDetailParams>;
export declare const AdminUserSchema: ZodType<AdminUser>;
export declare const AdminUserListSchema: ZodType<AdminUserList>;
export declare const AdminUserListQuerySchema: ZodType<AdminUserListQuery>;
export declare const LoginRequestSchema: ZodType<LoginRequest>;
export declare const ProblemDetailsSchema: ZodType<ProblemDetails>;
`;
await writeFile(runtimeSchemaDeclarationsPath, declarations);

console.log(`Admin contracts generated in ${generatedDirectory}`);
