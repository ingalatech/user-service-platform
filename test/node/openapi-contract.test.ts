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
  it('matches the approved integrated Administrator route inventory without generic Better Auth routes', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      paths: Record<string, Record<string, unknown>>;
    };
    const actual = Object.entries(document.paths)
      .filter(([path]) => path.startsWith('/v1/admin'))
      .flatMap(([path, operations]) =>
        Object.keys(operations).map((method) => `${method.toUpperCase()} ${path}`),
      )
      .sort();
    const approved = [
      'POST /v1/admin/auth/invitations/inspect',
      'POST /v1/admin/auth/invitations/accept',
      'GET /v1/admin/administrator-invitations',
      'POST /v1/admin/administrator-invitations',
      'POST /v1/admin/administrator-invitations/{invitationId}/messages',
      'DELETE /v1/admin/administrator-invitations/{invitationId}',
      'GET /v1/admin/me',
      'POST /v1/admin/auth/login',
      'POST /v1/admin/auth/sign-out',
      'POST /v1/admin/auth/verify-email',
      'POST /v1/admin/auth/request-verification',
      'POST /v1/admin/auth/request-password-reset',
      'POST /v1/admin/auth/check-password-reset',
      'POST /v1/admin/auth/reset-password',
      'GET /v1/admin/users',
      'GET /v1/admin/administrators',
      'GET /v1/admin/administrators/{administratorId}',
      'GET /v1/admin/administrators/{administratorId}/activity',
      'PUT /v1/admin/administrators/{administratorId}/access',
      'POST /v1/admin/administrators/{administratorId}/email-verification/messages',
      'POST /v1/admin/administrators/{administratorId}/password-recovery/messages',
      'GET /v1/admin/audit-events',
      'GET /v1/admin/users/{userId}',
      'GET /v1/admin/users/{userId}/activity',
      'GET /v1/admin/users/{userId}/sessions',
      'DELETE /v1/admin/users/{userId}/sessions',
      'DELETE /v1/admin/users/{userId}/sessions/{sessionId}',
      'PUT /v1/admin/users/{userId}/access',
      'DELETE /v1/admin/users/{userId}/social-identities/{associationId}',
      'PUT /v1/admin/users/{userId}/email-verification',
      'POST /v1/admin/users/{userId}/email-verification/messages',
      'POST /v1/admin/users/{userId}/password-recovery/messages',
      'POST /v1/admin/users/{userId}/email-changes',
      'POST /v1/admin/users/{userId}/email-changes/{emailChangeId}/messages',
      'DELETE /v1/admin/users/{userId}/email-changes/{emailChangeId}',
      'POST /v1/admin/users/{userId}/deletion-requests',
      'PUT /v1/admin/users/{userId}/deletion-requests/{requestId}/status',
      'GET /v1/admin/users/{userId}/account-details',
      'PATCH /v1/admin/users/{userId}/account-details',
      'POST /v1/admin/auth/bootstrap',
    ].sort();

    expect(actual).toEqual(approved);
    expect(Object.keys(document.paths).some((path) => path.startsWith('/api/auth'))).toBe(false);
    expect(Object.keys(document.paths).some((path) => path.startsWith('/v1/admin/api/auth'))).toBe(
      false,
    );
  });

  it('publishes Administrator verification and recovery command contracts', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      paths: Record<
        string,
        Record<
          string,
          | undefined
          | {
              operationId?: string;
              parameters?: {
                name: string;
                in: string;
                required?: boolean;
                schema?: { minLength?: number; maxLength?: number };
              }[];
              responses?: Record<
                string,
                { headers?: Record<string, { schema?: { type?: string; minimum?: number } }> }
              >;
            }
        >
      >;
    };
    const verification =
      document.paths['/v1/admin/administrators/{administratorId}/email-verification/messages']
        ?.post;
    const recovery =
      document.paths['/v1/admin/administrators/{administratorId}/password-recovery/messages']?.post;
    expect(verification?.operationId).toBe('requestAdminAdministratorEmailVerificationMessage');
    expect(recovery?.operationId).toBe('requestAdminAdministratorPasswordRecoveryMessage');
    expect(verification?.responses).toHaveProperty('200');
    expect(recovery?.responses).not.toHaveProperty('200');
    for (const operation of [verification, recovery]) {
      expect(operation?.responses).toHaveProperty('202');
      for (const status of ['400', '401', '403', '404', '409', '428', '429', '500', '503']) {
        expect(operation?.responses).toHaveProperty(status);
      }
      expect(operation?.parameters).toContainEqual(
        expect.objectContaining({
          name: 'idempotency-key',
          in: 'header',
          required: false,
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        }),
      );
      expect(operation?.responses?.['429']?.headers?.['Retry-After']?.schema).toEqual({
        type: 'integer',
        minimum: 1,
      });
    }
  });

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

  it('publishes a redacted Reader social association projection and targeted unlink operation', async () => {
    const raw = await readFile(artifactPath, 'utf8');
    const document = JSON.parse(raw) as {
      components: {
        schemas: Record<
          string,
          {
            required?: string[];
            properties?: Record<string, { enum?: string[] }>;
            allOf?: { properties?: Record<string, unknown> }[];
          }
        >;
      };
      paths: Record<
        string,
        Record<string, { operationId?: string; responses?: Record<string, unknown> }>
      >;
    };
    const detailProperties = document.components.schemas.AdminReaderDetail?.allOf?.[1]?.properties;
    expect(detailProperties).toHaveProperty('socialIdentities');
    expect(document.components.schemas.AdminReaderSocialIdentity?.required).toEqual(
      expect.arrayContaining([
        'associationId',
        'provider',
        'providerDisplayName',
        'linkedAt',
        'state',
      ]),
    );
    expect(document.components.schemas.AdminReaderSocialIdentity?.properties?.state?.enum).toEqual([
      'available',
      'unavailable',
    ]);
    expect(
      document.components.schemas.AdminReaderActivityEvent?.properties?.metadata,
    ).toBeDefined();
    expect(document.components.schemas.AdminAuditMetadata?.properties).toHaveProperty(
      'associationId',
    );
    expect(document.components.schemas.AdminAuditMetadata?.properties).toHaveProperty('provider');
    expect(
      document.paths['/v1/admin/users/{userId}/social-identities/{associationId}']?.delete
        ?.operationId,
    ).toBe('unlinkAdminReaderSocialIdentity');
    expect(
      document.paths['/v1/admin/users/{userId}/social-identities/{associationId}']?.delete
        ?.responses,
    ).toHaveProperty('200');
  });
});
