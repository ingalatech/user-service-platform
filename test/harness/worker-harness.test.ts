import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorkerHarness } from './worker-harness.js';
import type { TestHarness } from 'wrangler';

// Proves the whole-Worker seam is available: the built Worker boots under the
// Wrangler test harness and serves the versioned health operation end to end.
// Ticket #57 extends the proof to anonymous `GET /v1/me` so a clean local
// boot demonstrates both the public liveness and the unauthenticated
// identity boundary through the real HTTP surface.
describe('whole-Worker harness', () => {
  let server: TestHarness;

  beforeAll(async () => {
    server = createWorkerHarness();
    await server.listen();
  });

  afterAll(async () => {
    await server.close();
  });

  it('serves the health operation through the built Worker', async () => {
    const res = await server.fetch('/v1/health');

    expect(res.status).toBe(200);

    const body = (await res.json()) as { status: string };
    expect(body.status).toBe('ok');
  });

  it('rejects anonymous GET /v1/me with RFC 9457 problem details', async () => {
    const res = await server.fetch('/v1/me');

    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('unauthenticated');
    expect(body.status).toBe(401);
  });

  it('routes the integrated Admin boundary through the materialized Worker without mounting Better Auth routes', async () => {
    const adminUsers = await server.fetch('/v1/admin/users');

    expect(adminUsers.status).toBe(401);
    expect(adminUsers.headers.get('content-type')).toContain('application/problem+json');
    expect(adminUsers.headers.get('cache-control')).toBe('private, no-store');
    await expect(adminUsers.json()).resolves.toMatchObject({
      code: 'unauthenticated',
      status: 401,
    });

    const genericAuth = await server.fetch('/api/auth/session');
    expect(genericAuth.status).toBe(404);
    expect(genericAuth.headers.get('content-type')).toContain('application/problem+json');
  });
});
