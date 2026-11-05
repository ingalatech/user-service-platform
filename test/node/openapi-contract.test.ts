import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { openApiConfig } from '../../src/openapi.js';

// Seam under test: the generated OpenAPI artifact (ticket #9). These tests prove
// that the committed document describes the public operations and that
// regeneration from source contracts is byte-deterministic, so CI drift checks
// are meaningful.
const artifactPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'openapi',
  'openapi.json',
);

describe('generated OpenAPI artifact', () => {
  it('describes the health operation', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      openapi: string;
      paths: Record<string, Record<string, { operationId?: string }>>;
    };

    expect(document.openapi).toMatch(/^3\.1\./);
    expect(document.paths['/v1/health']?.get?.operationId).toBe('getHealth');
  });

  it('publishes the Problem Details error contract (PR #15 acceptance)', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
      };
      paths: Record<
        string,
        Record<
          string,
          {
            responses?: Record<
              string,
              { content?: Record<string, { schema?: { $ref?: string } }> }
            >;
          }
        >
      >;
    };

    expect(document.components.schemas.ProblemDetails?.required).toEqual([
      'type',
      'title',
      'status',
      'code',
    ]);
    expect(document.components.schemas.ProblemDetails?.properties).not.toHaveProperty(
      'failedRules',
    );
    expect(document.components.schemas.ProblemDetails?.properties).not.toHaveProperty(
      'passwordPolicy',
    );
    expect(document.components.schemas.IdentityProblemDetails?.properties).toHaveProperty(
      'failedRules',
    );
    expect(document.components.schemas.IdentityProblemDetails?.properties).toHaveProperty(
      'passwordPolicy',
    );

    const healthGet = document.paths['/v1/health']?.get;
    expect(healthGet?.responses?.default?.content?.['application/problem+json']?.schema?.$ref).toBe(
      '#/components/schemas/ProblemDetails',
    );
    expect(
      document.paths['/v1/auth/register']?.post?.responses?.default?.content?.[
        'application/problem+json'
      ]?.schema?.$ref,
    ).toBe('#/components/schemas/IdentityProblemDetails');
  });

  it('describes the current-User and sign-out operations (ticket #11)', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
      };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            responses?: Record<
              string,
              { content?: Record<string, { schema?: { $ref?: string } }> }
            >;
          }
        >
      >;
    };

    expect(document.paths['/v1/me']?.get?.operationId).toBe('getCurrentUser');
    expect(document.paths['/v1/auth/sign-out']?.post?.operationId).toBe('signOutIdentity');

    // Application-owned success contracts without server-implementation refs.
    expect(
      document.paths['/v1/me']?.get?.responses?.['200']?.content?.['application/json']?.schema
        ?.$ref,
    ).toBe('#/components/schemas/CurrentUser');
    expect(
      document.paths['/v1/auth/sign-out']?.post?.responses?.['200']?.content?.['application/json']
        ?.schema?.$ref,
    ).toBe('#/components/schemas/SignOutResult');

    // Identity responses use the Identity-owned Problem Details extension.
    expect(
      document.paths['/v1/me']?.get?.responses?.default?.content?.['application/problem+json']
        ?.schema?.$ref,
    ).toBe('#/components/schemas/IdentityProblemDetails');

    // The current-User representation exposes only stable identity fields.
    expect(document.components.schemas.CurrentUser?.required).toEqual([
      'id',
      'email',
      'emailVerified',
      'realm',
    ]);
    const serialized = JSON.stringify(document.components.schemas.CurrentUser);
    expect(serialized).not.toContain('password');
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('session');
  });

  it('describes the consumer token and JWKS operations (spec #150)', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
      };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            responses?: Record<
              string,
              { content?: Record<string, { schema?: { $ref?: string } }> }
            >;
          }
        >
      >;
    };

    expect(document.paths['/v1/auth/reader-state']?.post?.operationId).toBe('issueReaderState');
    expect(document.paths['/v1/auth/jwks']?.get?.operationId).toBe('getConsumerJwks');
    expect(
      document.paths['/v1/auth/reader-state']?.post?.responses?.['200']?.content?.[
        'application/json'
      ]?.schema?.$ref,
    ).toBe('#/components/schemas/ReaderState');
    expect(
      document.paths['/v1/auth/jwks']?.get?.responses?.['200']?.content?.['application/json']
        ?.schema?.$ref,
    ).toBe('#/components/schemas/ConsumerJwks');

    // Reader State is explicitly not a Bearer-shaped response.
    expect(document.components.schemas.ReaderState?.required).toEqual(['readerState', 'expiresAt']);
    const serialized = JSON.stringify(document.components.schemas);
    expect(serialized).not.toContain('privateKey');
  });

  it('describes the non-consuming password-reset check operation', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: { schemas: Record<string, { required?: string[] }> };
      paths: Record<
        string,
        Record<
          string,
          {
            operationId?: string;
            responses?: Record<
              string,
              { content?: Record<string, { schema?: { $ref?: string } }> }
            >;
          }
        >
      >;
    };

    const operation = document.paths['/v1/auth/check-password-reset']?.post;
    expect(operation?.operationId).toBe('checkPasswordReset');
    expect(operation?.responses?.['200']?.content?.['application/json']?.schema?.$ref).toBe(
      '#/components/schemas/CheckPasswordResetResult',
    );
    expect(document.components.schemas.CheckPasswordResetResult?.required).toEqual(['valid']);
  });

  it('regenerates byte-identically from source contracts', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const regenerated = `${JSON.stringify(createApp().getOpenAPI31Document(openApiConfig), null, 2)}\n`;

    expect(regenerated).toBe(raw);
  });

  it('documents atomic Reader email-change completion outcomes and stable problems', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            oneOf?: {
              required?: string[];
              properties?: Record<string, { description?: string }>;
            }[];
          }
        >;
      };
      paths: Record<
        string,
        Record<
          string,
          {
            description?: string;
            responses?: Record<string, { description?: string }>;
          }
        >
      >;
    };
    const operation = document.paths['/v1/auth/verify-email']?.post;
    expect(operation?.description).toContain('administrative Reader email-change');
    expect(operation?.description).toContain('revoked');
    expect(operation?.responses?.['200']?.description).toContain('atomically');
    expect(operation?.responses?.['400']?.description).toContain('verification-invalid');
    expect(operation?.responses?.['500']?.description).toContain('no partial');
  });

  it('publishes the application-owned Reader deletion-request operations', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            oneOf?: {
              required?: string[];
              properties?: Record<string, { description?: string }>;
            }[];
            allOf?: { properties?: Record<string, unknown> }[];
          }
        >;
      };
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    expect(document.paths['/v1/admin/users/{userId}/deletion-requests']?.post?.operationId).toBe(
      'createAdminReaderDeletionRequest',
    );
    expect(
      document.paths['/v1/admin/users/{userId}/deletion-requests']?.post?.responses,
    ).toHaveProperty('201');
    expect(
      document.paths['/v1/admin/users/{userId}/deletion-requests/{requestId}/status']?.put
        ?.operationId,
    ).toBe('transitionAdminReaderDeletionRequest');
    expect(
      document.paths['/v1/admin/users/{userId}/deletion-requests/{requestId}/status']?.put
        ?.responses,
    ).toHaveProperty('200');
    expect(document.components.schemas.AdminReaderDeletionRequest?.required).toEqual(
      expect.arrayContaining([
        'requestId',
        'state',
        'previousAccessState',
        'changed',
        'revision',
        'accountRevision',
      ]),
    );
    expect(document.components.schemas.AdminReaderDeletionRequestStatus?.oneOf).toHaveLength(4);
    for (const index of [1, 2]) {
      expect(
        document.components.schemas.AdminReaderDeletionRequestStatus?.oneOf?.[index]?.required,
      ).toContain('note');
      expect(
        document.components.schemas.AdminReaderDeletionRequestStatus?.oneOf?.[index]?.properties
          ?.note?.description,
      ).toContain('Required for');
    }
    expect(document.components.schemas.AdminReaderDetail?.allOf?.[1]?.properties).toHaveProperty(
      'deletionState',
    );
    expect(document.paths['/v1/admin/users/{userId}/access']?.put?.operationId).toBe(
      'updateAdminReaderAccess',
    );
    expect(document.paths['/v1/admin/users/{userId}/access']?.put?.responses).toHaveProperty('200');
  });
});
