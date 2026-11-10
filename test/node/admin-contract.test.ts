import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  AdminAdministratorDetailSchema,
  AdminAdministratorInvitationSchema,
  AdminReaderSessionSchema,
  AdminReaderSessionRevocationSchema,
  AdminReaderSessionsSchema,
} from '../../admin/src/generated/contracts.js';

// Published generated contracts: admin identity is exact and existing login,
// logout and public identity operations keep their application-owned shapes.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const artifactPath = resolve(root, 'openapi', 'openapi.json');

interface Operation {
  readonly operationId?: string;
  readonly responses?: Record<
    string,
    {
      description?: string;
      content?: Record<string, { schema?: unknown }>;
      headers?: Record<
        string,
        { description?: string; schema?: { type?: string; minimum?: number } }
      >;
    }
  >;
  readonly parameters?: {
    readonly name?: string;
    readonly in?: string;
    readonly required?: boolean;
  }[];
}

async function document(): Promise<{
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<
      string,
      {
        required?: string[];
        properties?: Record<string, unknown>;
        items?: { $ref?: string };
        allOf?: {
          $ref?: string;
          required?: string[];
          properties?: Record<string, unknown>;
          items?: { $ref?: string };
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
          items?: { $ref?: string };
          allOf?: {
            $ref?: string;
            required?: string[];
            properties?: Record<string, unknown>;
            items?: { $ref?: string };
          }[];
        }
      >;
    };
  };
}

describe('administration API contract', () => {
  it('publishes invitation routes and strict safe invitation contracts', async () => {
    const doc = await document();
    const list = doc.paths['/v1/admin/administrator-invitations']?.get;
    const create = doc.paths['/v1/admin/administrator-invitations']?.post;
    const resend = doc.paths['/v1/admin/administrator-invitations/{invitationId}/messages']?.post;
    const cancel = doc.paths['/v1/admin/administrator-invitations/{invitationId}']?.delete;
    const inspect = doc.paths['/v1/admin/auth/invitations/inspect']?.post;
    const accept = doc.paths['/v1/admin/auth/invitations/accept']?.post;
    expect(list?.operationId).toBe('listAdminAdministratorInvitations');
    expect(Object.keys(list?.responses ?? {}).sort()).toEqual(['200', '400', '401', '403', '500']);
    expect(Object.keys(create?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '401',
      '403',
      '409',
      '428',
      '500',
      '503',
    ]);
    expect(Object.keys(resend?.responses ?? {}).sort()).toEqual([
      '202',
      '400',
      '401',
      '403',
      '404',
      '409',
      '428',
      '429',
      '500',
      '503',
    ]);
    expect(Object.keys(cancel?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '409',
      '412',
      '428',
      '500',
    ]);
    expect(Object.keys(inspect?.responses ?? {}).sort()).toEqual(['200', '400', '404']);
    expect(Object.keys(accept?.responses ?? {}).sort()).toEqual([
      '201',
      '400',
      '403',
      '404',
      '409',
      '500',
    ]);
    expect(resend?.responses?.['404']?.description).toContain('invitation-not-found');
    expect(resend?.responses?.['409']?.description).toContain('invalid-transition');
    expect(resend?.responses?.['409']?.description).toContain('idempotency-key-reused');
    expect(resend?.responses?.['429']?.description).toContain('cooldown-active');
    expect(resend?.responses?.['429']?.headers?.['Retry-After']?.schema).toMatchObject({
      type: 'integer',
      minimum: 1,
    });
    expect(resend?.responses?.['503']?.description).toContain('delivery-scheduling-failed');
    expect(cancel?.responses?.['412']?.description).toContain('stale-revision');
    expect(cancel?.responses?.['428']?.description).toContain('If-Match and Idempotency-Key');
    expect(inspect?.responses?.['404']?.description).toContain('Terminal workflows');
    expect(accept?.responses?.['404']?.description).toContain('failure cases share');
    const headerParameters = (operation: Operation | undefined) =>
      operation?.parameters
        ?.filter(({ in: location }) => location === 'header')
        .map(({ name, in: location, required }) => ({ name, in: location, required }))
        .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
    expect(headerParameters(create)).toEqual([
      { name: 'idempotency-key', in: 'header', required: true },
    ]);
    expect(headerParameters(resend)).toEqual([
      { name: 'idempotency-key', in: 'header', required: true },
    ]);
    expect(headerParameters(cancel)).toEqual([
      { name: 'idempotency-key', in: 'header', required: true },
      { name: 'if-match', in: 'header', required: true },
    ]);
    for (const operation of [list, create, resend, cancel, inspect, accept]) {
      expect(operation?.responses?.default).toBeUndefined();
      expect(
        Object.values(operation?.responses ?? {}).every(
          ({ description }) => description !== undefined,
        ),
      ).toBe(true);
    }
    expect(JSON.stringify([list, create, resend, cancel, inspect, accept])).not.toMatch(
      /Reader not found|Reader state/i,
    );
    const parsed = AdminAdministratorInvitationSchema.safeParse({
      id: 'opaque-invitation',
      email: 'admin@example.com',
      state: 'pending',
      expiresAt: '2026-01-01T00:00:00.000Z',
      revision: 1,
      createdAt: '2025-12-31T00:00:00.000Z',
    });
    expect(parsed.success).toBe(true);
    expect(
      AdminAdministratorInvitationSchema.safeParse({ ...parsed.data, token: 'never' }).success,
    ).toBe(false);
  });

  it('publishes the additive safe Administrator message workflow detail projection', async () => {
    const doc = await document();
    const detail = doc.components.schemas.AdminAdministratorDetail;
    expect(detail?.allOf?.[1]?.required).toContain('messageWorkflows');
    expect(detail?.allOf?.[1]?.properties?.messageWorkflows).toMatchObject({
      type: 'object',
      required: ['emailVerification', 'passwordRecovery'],
    });

    const parsed = AdminAdministratorDetailSchema.safeParse({
      id: 'admin-1',
      email: 'admin@example.com',
      emailVerified: false,
      realm: 'administrator',
      role: 'admin',
      access: { state: 'disabled' },
      revision: 3,
      summary: {
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      methods: [{ type: 'password' }],
      messageWorkflows: {
        emailVerification: {
          kind: 'email-verification',
          state: 'pending',
          cooldownUntil: '2026-01-02T00:01:00.000Z',
          lastScheduledAt: null,
          updatedAt: '2026-01-02T00:00:00.000Z',
        },
        passwordRecovery: null,
      },
    });
    expect(parsed.success).toBe(true);
    expect(
      AdminAdministratorDetailSchema.safeParse({
        ...(parsed.success ? parsed.data : {}),
        messageWorkflows: {
          emailVerification: {
            kind: 'email-verification',
            state: 'scheduled',
            cooldownUntil: '2026-01-02T00:01:00.000Z',
            lastScheduledAt: null,
            updatedAt: '2026-01-02T00:00:00.000Z',
            retryPayload: 'must-not-be-accepted',
          },
          passwordRecovery: null,
        },
      }).success,
    ).toBe(false);
  });

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
      'deletionState',
      'methods',
      'revision',
      'socialIdentities',
      'summary',
    ]);
    expect(adminReader?.allOf?.[1]?.properties?.socialIdentities).toEqual({
      $ref: '#/components/schemas/AdminReaderSocialIdentityList',
    });
    expect(doc.components.schemas.AdminReaderSocialIdentityList).toMatchObject({
      items: { $ref: '#/components/schemas/AdminReaderSocialIdentity' },
    });
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

  it('publishes safe Reader session listing and revocation contracts', async () => {
    const doc = await document();
    const listPath = '/v1/admin/users/{userId}/sessions';
    const onePath = '/v1/admin/users/{userId}/sessions/{sessionId}';
    const list = doc.paths[listPath]?.get;
    const revokeOne = doc.paths[onePath]?.delete;
    const revokeAll = doc.paths[listPath]?.delete;

    expect(list?.operationId).toBe('listAdminReaderSessions');
    expect(revokeOne?.operationId).toBe('revokeAdminReaderSession');
    expect(revokeAll?.operationId).toBe('revokeAllAdminReaderSessions');
    expect(Object.keys(list?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    expect(Object.keys(revokeOne?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    expect(Object.keys(revokeAll?.responses ?? {}).sort()).toEqual([
      '200',
      '400',
      '401',
      '403',
      '404',
      '500',
    ]);
    expect(revokeOne?.parameters?.some((parameter) => parameter.name === 'if-match')).toBe(false);
    expect(revokeOne?.parameters?.some((parameter) => parameter.name === 'idempotency-key')).toBe(
      false,
    );

    expect(doc.components.schemas.AdminReaderSession?.required?.slice().sort()).toEqual([
      'createdAt',
      'expiresAt',
      'selector',
      'updatedAt',
    ]);
    expect(Object.keys(doc.components.schemas.AdminReaderSession?.properties ?? {}).sort()).toEqual(
      ['createdAt', 'expiresAt', 'selector', 'updatedAt'],
    );
    expect(doc.components.schemas.AdminReaderSessions?.required?.slice().sort()).toEqual([
      'items',
      'nextCursor',
      'total',
    ]);
    expect(list?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/AdminReaderSessions',
    });
    expect(revokeOne?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/AdminReaderSessionRevocation',
    });
    expect(revokeAll?.responses?.['200']?.content?.['application/json']?.schema).toEqual({
      $ref: '#/components/schemas/AdminReaderSessionRevocation',
    });
  });

  it('generates runtime Admin session validators with exact safe projections', () => {
    const session = {
      selector: `s1_${'A'.repeat(39)}`,
      createdAt: '2026-11-09T12:00:00.000Z',
      updatedAt: '2026-11-09T12:01:00.000Z',
      expiresAt: '2026-11-10T12:00:00.000Z',
    };
    expect(AdminReaderSessionSchema.safeParse(session).success).toBe(true);
    expect(AdminReaderSessionSchema.safeParse({ ...session, token: 'never' }).success).toBe(false);
    expect(
      AdminReaderSessionsSchema.safeParse({ items: [session], total: 1, nextCursor: null }).success,
    ).toBe(true);
    expect(
      AdminReaderSessionRevocationSchema.safeParse({
        state: 'active',
        revision: 1,
        changed: true,
      }).success,
    ).toBe(true);
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
