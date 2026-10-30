import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Published generated contracts: admin identity is exact and existing login,
// logout and public identity operations keep their application-owned shapes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifactPath = resolve(root, 'openapi', 'openapi.json');

interface Operation {
  readonly operationId?: string;
  readonly responses?: Record<string, { content?: Record<string, { schema?: unknown }> }>;
}

async function document(): Promise<{
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<
      string,
      {
        required?: string[];
        properties?: Record<string, unknown>;
        allOf?: {
          $ref?: string;
          required?: string[];
          properties?: Record<string, unknown>;
        }[];
      }
    >;
  };
}> {
  const raw = await readFile(artifactPath, 'utf8');
  return JSON.parse(raw) as {
    paths: Record<string, Record<string, Operation>>;
    components: {
      schemas: Record<
        string,
        {
          required?: string[];
          properties?: Record<string, unknown>;
          allOf?: {
            $ref?: string;
            required?: string[];
            properties?: Record<string, unknown>;
          }[];
        }
      >;
    };
  };
}

describe('administration API contract', () => {
  it('publishes GET /v1/admin/me with the exact administrative representation', async () => {
    const doc = await document();

    const operation = doc.paths['/v1/admin/me']?.get;
    expect(operation?.operationId).toBe('getAdminMe');

    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema as
      { $ref?: string } | undefined;
    expect(schema?.$ref).toBe('#/components/schemas/AdminMe');

    const adminMe = doc.components.schemas.AdminMe;
    expect(adminMe?.required?.slice().sort()).toEqual([
      'email',
      'emailVerified',
      'id',
      'realm',
      'role',
    ]);
    expect(Object.keys(adminMe?.properties ?? {}).sort()).toEqual([
      'email',
      'emailVerified',
      'id',
      'realm',
      'role',
    ]);
  });

  it('publishes GET /v1/admin/users/{userId} with the exact administrative representation', async () => {
    const doc = await document();

    const operation = doc.paths['/v1/admin/users/{userId}']?.get;
    expect(operation?.operationId).toBe('getAdminUser');

    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema as
      { $ref?: string } | undefined;
    expect(schema?.$ref).toBe('#/components/schemas/AdminReaderDetail');

    const adminReader = doc.components.schemas.AdminReaderDetail;
    expect(adminReader?.allOf?.[0]?.$ref).toBe('#/components/schemas/AdminUser');
    expect(adminReader?.allOf?.[1]?.required?.slice().sort()).toEqual([
      'access',
      'activeWorkflows',
      'methods',
      'revision',
      'summary',
    ]);
  });

  it('publishes the paged Reader activity route with explicit statuses', async () => {
    const doc = await document();
    const operation = doc.paths['/v1/admin/users/{userId}/activity']?.get;
    expect(operation?.operationId).toBe('getAdminReaderActivity');
    expect(Object.keys(operation?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    const schema = operation?.responses?.['200']?.content?.['application/json']?.schema as
      { $ref?: string } | undefined;
    expect(schema?.$ref).toBe('#/components/schemas/AdminReaderActivity');
  });

  it('keeps Reader and Administrator login and sign-out contracts separate', async () => {
    const doc = await document();

    expect(doc.paths['/v1/auth/login']?.post?.operationId).toBe('loginIdentity');
    expect(doc.paths['/v1/auth/sign-out']?.post?.operationId).toBe('signOutIdentity');
    expect(doc.paths['/v1/admin/auth/login']?.post?.operationId).toBe('loginAdministrator');
    expect(doc.paths['/v1/admin/auth/sign-out']?.post?.operationId).toBe('signOutAdministrator');
    expect(doc.paths['/v1/me']?.get?.operationId).toBe('getCurrentUser');
  });
});
