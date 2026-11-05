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
export type AdminAdministrator = components['schemas']['AdminAdministrator'];
export type AdminAdministratorDetail = components['schemas']['AdminAdministratorDetail'];
export type AdminAdministratorActivity = components['schemas']['AdminAdministratorActivity'];
export type AdminAdministratorAccessRequest = components['schemas']['AdminAdministratorAccessRequest'];
export type AdminAdministratorAccessResult = components['schemas']['AdminAdministratorAccessResult'];
export type AdminAdministratorList = components['schemas']['AdminAdministratorList'];
export type AdminAdministratorMessage = components['schemas']['AdminAdministratorMessage'];
export type AdminAuditEvent = components['schemas']['AdminAuditEvent'];
export type AdminAuditEvents = components['schemas']['AdminAuditEvents'];
export type AdminUser = components['schemas']['AdminUser'];
export type AdminReaderDetail = components['schemas']['AdminReaderDetail'];
export type AdminReaderActivity = components['schemas']['AdminReaderActivity'];
export type AdminReaderEmailVerification = components['schemas']['AdminReaderEmailVerification'];
export type AdminReaderEmailChange = components['schemas']['AdminReaderEmailChange'];
export type AdminReaderEmailChangeCancel = components['schemas']['AdminReaderEmailChangeCancel'];
export type AdminReaderEmailChangeMessage = components['schemas']['AdminReaderEmailChangeMessage'];
export type AdminReaderDeletionRequest = components['schemas']['AdminReaderDeletionRequest'];
export type AdminReaderDeletionRequestTransition = components['schemas']['AdminReaderDeletionRequestTransition'];
export type AdminReaderAccessRequest = components['schemas']['AdminReaderAccessRequest'];
export type AdminReaderAccessResult = components['schemas']['AdminReaderAccessResult'];
export type AdminReaderDeletionRequestParams = {
  userId: string;
  requestId: string;
};
export type AdminReaderEmailChangeRequest = components['schemas']['AdminReaderEmailChangeRequest'];
export type AdminReaderEmailChangeCommand = components['schemas']['AdminReaderEmailChangeCommand'];
export type AdminReaderMessage = components['schemas']['AdminReaderMessage'];
export type AdminReaderMessageRequest = components['schemas']['AdminReaderMessageRequest'];
export type AdminUserList = components['schemas']['AdminUserList'];
export type AccountDetails = components['schemas']['AccountDetails'];
export type UpdateAccountDetails = components['schemas']['UpdateAccountDetails'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type ProblemDetails = components['schemas']['ProblemDetails'];

type AdminUserListQueryParameters = NonNullable<
  operations['listAdminUsers']['parameters']['query']
>;
type AdminAdministratorListQueryParameters = NonNullable<
  operations['listAdminAdministrators']['parameters']['query']
>;
type AdminAdministratorPathParameters = operations['getAdminAdministrator']['parameters']['path'];
export type AdminAdministratorParams = {
  administratorId: AdminAdministratorPathParameters['administratorId'];
};
export type AdminAdministratorListQuery = {
  limit: NonNullable<AdminAdministratorListQueryParameters['limit']>;
  offset: NonNullable<AdminAdministratorListQueryParameters['offset']>;
  email?: AdminAdministratorListQueryParameters['email'];
};
type AdminAuditEventsQueryParameters = NonNullable<
  operations['listAdminAuditEvents']['parameters']['query']
>;
export type AdminAuditEventsQuery = {
  limit: NonNullable<AdminAuditEventsQueryParameters['limit']>;
  cursor?: AdminAuditEventsQueryParameters['cursor'];
  actorId?: AdminAuditEventsQueryParameters['actorId'];
  action?: AdminAuditEventsQueryParameters['action'];
  result?: AdminAuditEventsQueryParameters['result'];
  from?: AdminAuditEventsQueryParameters['from'];
  to?: AdminAuditEventsQueryParameters['to'];
};
type AdminUserDetailPathParameters = operations['getAdminUser']['parameters']['path'];
type AdminReaderEmailChangePathParameters =
  operations['resendAdminReaderEmailChangeMessage']['parameters']['path'];
export type AdminUserDetailParams = {
  userId: AdminUserDetailPathParameters['userId'];
};
export type AdminReaderEmailChangeParams = {
  userId: AdminReaderEmailChangePathParameters['userId'];
  emailChangeId: AdminReaderEmailChangePathParameters['emailChangeId'];
};
export type AdminUserListQuery = {
  limit: NonNullable<AdminUserListQueryParameters['limit']>;
  offset: NonNullable<AdminUserListQueryParameters['offset']>;
  email?: AdminUserListQueryParameters['email'];
};

export declare const AdminMeSchema: ZodType<AdminMe>;
export declare const AdminAdministratorSchema: ZodType<AdminAdministrator>;
export declare const AdminAdministratorDetailSchema: ZodType<AdminAdministratorDetail>;
export declare const AdminAdministratorActivitySchema: ZodType<AdminAdministratorActivity>;
export declare const AdminAdministratorAccessRequestSchema: ZodType<AdminAdministratorAccessRequest>;
export declare const AdminAdministratorAccessResultSchema: ZodType<AdminAdministratorAccessResult>;
export declare const AdminAdministratorListSchema: ZodType<AdminAdministratorList>;
export declare const AdminAdministratorMessageSchema: ZodType<AdminAdministratorMessage>;
export declare const AdminAuditEventsQuerySchema: ZodType<AdminAuditEventsQuery>;
export declare const AdminAuditEventsSchema: ZodType<AdminAuditEvents>;
export declare const AdminAdministratorListQuerySchema: ZodType<AdminAdministratorListQuery>;
export declare const AdminAdministratorParamsSchema: ZodType<AdminAdministratorParams>;
export declare const AdminReaderActivitySchema: ZodType<AdminReaderActivity>;
export declare const AdminReaderDetailSchema: ZodType<AdminReaderDetail>;
export declare const AdminReaderEmailVerificationSchema: ZodType<AdminReaderEmailVerification>;
export declare const AdminReaderEmailChangeSchema: ZodType<AdminReaderEmailChange>;
export declare const AdminReaderDeletionRequestSchema: ZodType<AdminReaderDeletionRequest>;
export declare const AdminReaderDeletionRequestTransitionSchema: ZodType<AdminReaderDeletionRequestTransition>;
export declare const AdminReaderDeletionRequestCreateSchema: ZodType<components['schemas']['AdminReaderDeletionRequestCreate']>;
export declare const AdminReaderDeletionRequestStatusSchema: ZodType<components['schemas']['AdminReaderDeletionRequestStatus']>;
export declare const AdminReaderDeletionRequestParamsSchema: ZodType<AdminReaderDeletionRequestParams>;
export declare const AdminReaderAccessRequestSchema: ZodType<AdminReaderAccessRequest>;
export declare const AdminReaderAccessResultSchema: ZodType<AdminReaderAccessResult>;
export declare const AdminReaderEmailChangeCancelSchema: ZodType<AdminReaderEmailChangeCancel>;
export declare const AdminReaderEmailChangeMessageSchema: ZodType<AdminReaderEmailChangeMessage>;
export declare const AdminReaderEmailChangeRequestSchema: ZodType<AdminReaderEmailChangeRequest>;
export declare const AdminReaderEmailChangeCommandSchema: ZodType<AdminReaderEmailChangeCommand>;
export declare const AdminReaderEmailChangeParamsSchema: ZodType<AdminReaderEmailChangeParams>;
export declare const AdminReaderMessageSchema: ZodType<AdminReaderMessage>;
export declare const AdminReaderMessageRequestSchema: ZodType<AdminReaderMessageRequest>;
export declare const AccountDetailsSchema: ZodType<AccountDetails>;
export declare const AdminUserDetailParamsSchema: ZodType<AdminUserDetailParams>;
export declare const AdminUserSchema: ZodType<AdminUser>;
export declare const AdminUserListSchema: ZodType<AdminUserList>;
export declare const AdminUserListQuerySchema: ZodType<AdminUserListQuery>;
export declare const LoginRequestSchema: ZodType<LoginRequest>;
export declare const ProblemDetailsSchema: ZodType<ProblemDetails>;
export declare const UpdateAccountDetailsSchema: ZodType<UpdateAccountDetails>;
`;
await writeFile(runtimeSchemaDeclarationsPath, declarations);

console.log(`Admin contracts generated in ${generatedDirectory}`);
