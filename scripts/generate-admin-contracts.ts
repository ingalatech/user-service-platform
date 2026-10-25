import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import * as ts from 'typescript';
import { assertAdminBrowserSafeImports } from './admin-contract-safety.js';

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDirectory = resolve(root, 'admin', 'src', 'generated');
const openApiPath = resolve(root, 'openapi', 'openapi.json');
const generatedTypesPath = resolve(generatedDirectory, 'api.d.ts');
const runtimeSchemasPath = resolve(generatedDirectory, 'contracts.js');
const runtimeSchemaDeclarationsPath = resolve(generatedDirectory, 'contracts.d.ts');

function browserSafeZodSource(path: string, sourceText: string): string {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true);
  let removedOpenApiMetadata = 0;
  let rewrittenImports = 0;

  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => {
    const visit: ts.Visitor = (node) => {
      if (
        ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === '@hono/zod-openapi'
      ) {
        const bindings = node.importClause?.namedBindings;
        if (
          !bindings ||
          !ts.isNamedImports(bindings) ||
          bindings.elements.length !== 1 ||
          bindings.elements[0]?.name.text !== 'z'
        ) {
          throw new Error(`Unsupported server-only schema import in ${path}.`);
        }
        rewrittenImports += 1;
        return context.factory.updateImportDeclaration(
          node,
          node.modifiers,
          node.importClause,
          context.factory.createStringLiteral('zod'),
          node.attributes,
        );
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'openapi'
      ) {
        // Visit the schema receiver bottom-up so nested field annotations are
        // removed too. Only the OpenAPI metadata call is discarded; all Zod
        // validation/transformation calls remain in the generated browser code.
        removedOpenApiMetadata += 1;
        return ts.visitNode(node.expression.expression, visit);
      }

      return ts.visitEachChild(node, visit, context);
    };
    return (sourceFile) => ts.visitNode(sourceFile, visit) as ts.SourceFile;
  };

  const transformed = ts.transform(source, [transformer]);
  try {
    if (sourceText.includes('@hono/zod-openapi') && rewrittenImports === 0) {
      throw new Error(`Expected the server-only schema import in ${path}.`);
    }
    if (sourceText.includes('.openapi(') && removedOpenApiMetadata === 0) {
      throw new Error(`Expected OpenAPI metadata calls in schema source ${path}.`);
    }
    const transformedSource = transformed.transformed[0];
    if (transformedSource === undefined)
      throw new Error(`Unable to transform schema source ${path}.`);
    return ts.createPrinter({ newLine: ts.NewLineKind.LineFeed }).printFile(transformedSource);
  } finally {
    transformed.dispose();
  }
}

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
  minify: true,
  external: ['zod'],
  plugins: [
    {
      name: 'browser-safe-admin-zod-schemas',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => {
          if (
            !path.startsWith(resolve(root, 'src', 'features', 'identity')) &&
            !path.startsWith(resolve(root, 'src', 'shared'))
          ) {
            return null;
          }
          const source = await readFile(path, 'utf8');
          if (!source.includes('@hono/zod-openapi') && !source.includes('.openapi(')) return null;
          return { contents: browserSafeZodSource(path, source), loader: 'ts' };
        });
      },
    },
  ],
  outfile: runtimeSchemasPath,
  write: false,
  logLevel: 'silent',
});
const runtimeSchemaBundle = bundle.outputFiles[0];
if (runtimeSchemaBundle === undefined) {
  throw new Error('Admin runtime contract bundling produced no output.');
}
assertAdminBrowserSafeImports(runtimeSchemaBundle.text, 'Generated Admin runtime contracts');
if (runtimeSchemaBundle.text.includes('.openapi(')) {
  const offset = runtimeSchemaBundle.text.indexOf('.openapi(');
  throw new Error(
    `Generated Admin runtime contracts retain server-only OpenAPI annotations: ${runtimeSchemaBundle.text.slice(offset, offset + 160)}`,
  );
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
