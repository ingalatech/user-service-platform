import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { compareOpenApiDocuments } from '../../scripts/openapi-compat.js';

// Seam under test (ADR-0007, ticket #152): the OpenAPI compatibility gate
// that protects the first external consumer. These tests prove the check
// permits additive evolution (including the real #151 token/JWKS increment
// against the agreed a88774e baseline) while detecting breaking changes with
// meaningful fixtures — never by comparing a file only to itself.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(resolve(root, path), 'utf8')) as unknown;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe('OpenAPI compatibility gate', () => {
  it('rejects a response that no longer guarantees a required field', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const schemas = (current.components as { schemas: Record<string, { required: string[] }> })
      .schemas;
    const user = schemas.CurrentUser;
    if (user === undefined) throw new Error('CurrentUser missing');
    user.required = user.required.filter((name) => name !== 'email');
    expect(
      compareOpenApiDocuments(baseline, current).some(
        (finding) => finding.message.includes('response') && finding.message.includes('email'),
      ),
    ).toBe(true);
  });

  it('rejects expansion of a response enum that callers handle exhaustively', () => {
    const baseline = {
      paths: {
        '/v1/example': {
          get: {
            responses: {
              200: {
                content: { 'application/json': { schema: { type: 'string', enum: ['ready'] } } },
              },
            },
          },
        },
      },
    };
    const current = clone(baseline);
    current.paths['/v1/example'].get.responses[200].content['application/json'].schema.enum.push(
      'pending',
    );
    expect(compareOpenApiDocuments(baseline, current).some((finding) => finding.breaking)).toBe(
      true,
    );
  });

  it('detects a newly required query parameter', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const paths = current.paths as Record<string, Record<string, unknown>>;
    const operation = paths['/v1/me']?.get as Record<string, unknown>;
    operation.parameters = [
      { in: 'query', name: 'requiredMode', required: true, schema: { type: 'string' } },
    ];
    expect(
      compareOpenApiDocuments(baseline, current).some((f) => f.message.includes('requiredMode')),
    ).toBe(true);
  });

  it('detects removed response content even when its component is retained', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const paths = current.paths as Record<string, Record<string, unknown>>;
    const operation = paths['/v1/me']?.get as { responses: Record<string, { content?: unknown }> };
    delete operation.responses['200']?.content;
    expect(compareOpenApiDocuments(baseline, current).some((f) => f.breaking)).toBe(true);
  });

  it('detects a tightened request constraint', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const schemas = (
      current.components as {
        schemas: Record<string, { properties: Record<string, Record<string, unknown>> }>;
      }
    ).schemas;
    const password = schemas.LoginRequest?.properties.password;
    if (password === undefined) throw new Error('Login password schema missing');
    password.minLength = 100;
    expect(
      compareOpenApiDocuments(baseline, current).some((f) => f.message.includes('password')),
    ).toBe(true);
  });
  it('accepts the current document against the agreed previous-main baseline', async () => {
    const baseline = await readJson('openapi/baseline/a88774e.json');
    const current = await readJson('openapi/openapi.json');

    const findings = compareOpenApiDocuments(baseline, current).filter(
      (finding) => finding.breaking,
    );
    expect(findings).toEqual([]);
  });

  it('permits additive paths and optional fields', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const paths = current.paths as Record<string, Record<string, unknown>>;
    paths['/v1/example-new'] = {
      get: { operationId: 'getExampleNew', responses: { 200: { description: 'New.' } } },
    };
    const schemas = (current.components as Record<string, unknown>).schemas as Record<
      string,
      Record<string, unknown>
    >;
    const user = schemas.CurrentUser as { properties: Record<string, unknown> };
    user.properties.nickname = { type: 'string', description: 'Additive optional field.' };

    const findings = compareOpenApiDocuments(baseline, current).filter(
      (finding) => finding.breaking,
    );
    expect(findings).toEqual([]);
  });

  it('detects a removed operation as breaking', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const token = (current.paths as Record<string, Record<string, unknown>>)['/v1/auth/token'];
    if (token !== undefined) {
      delete token.post;
    }

    const breaking = compareOpenApiDocuments(baseline, current).filter(
      (finding) => finding.breaking,
    );
    expect(breaking.length).toBeGreaterThan(0);
    expect(breaking.map((finding) => finding.message).join('\n')).toContain('/v1/auth/token');
  });

  it('detects a newly required request field as breaking', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const current = clone(baseline);
    const schemas = (current.components as Record<string, unknown>).schemas as Record<
      string,
      Record<string, unknown>
    >;
    const login = schemas.LoginRequest as { required: string[] };
    login.required = [...login.required, 'captchaToken'];

    const breaking = compareOpenApiDocuments(baseline, current).filter(
      (finding) => finding.breaking,
    );
    expect(breaking.length).toBeGreaterThan(0);
    expect(breaking.map((finding) => finding.message).join('\n')).toContain('LoginRequest');
  });

  it('detects a removed response field and a type change as breaking', async () => {
    const baseline = (await readJson('openapi/openapi.json')) as Record<string, unknown>;
    const removed = clone(baseline);
    const removedSchemas = (removed.components as Record<string, unknown>).schemas as Record<
      string,
      Record<string, unknown>
    >;
    const token = removedSchemas.ConsumerToken as { properties: Record<string, unknown> };
    delete token.properties.expiresAt;

    const removedBreaking = compareOpenApiDocuments(baseline, removed).filter(
      (finding) => finding.breaking,
    );
    expect(removedBreaking.length).toBeGreaterThan(0);
    expect(removedBreaking.map((finding) => finding.message).join('\n')).toContain('ConsumerToken');

    const retyped = clone(baseline);
    const retypedSchemas = (retyped.components as Record<string, unknown>).schemas as Record<
      string,
      Record<string, unknown>
    >;
    const currentUser = retypedSchemas.CurrentUser as { properties: Record<string, unknown> };
    currentUser.properties.emailVerified = { type: 'string' };
    const retypedBreaking = compareOpenApiDocuments(baseline, retyped).filter(
      (finding) => finding.breaking,
    );
    expect(retypedBreaking.length).toBeGreaterThan(0);
  });
});
