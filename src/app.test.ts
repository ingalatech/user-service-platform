import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { LOCAL_PROFILE } from './config/index.js';
import type { Env } from './env.js';

// Seam under test: unhandled public API paths through the built Worker. Ticket #9
// requires the RFC 9457-compatible Problem Details shape for invalid/unhandled
// failures; this pins the envelope, the stable machine code and the media type.
describe('unhandled routes', () => {
  it('returns RFC 9457 problem details for unknown operations', async () => {
    const app = createApp();
    const res = await app.request('/v1/does-not-exist');

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');

    const body = await res.json();
    expect(body).toEqual({
      type: 'urn:problem:not-found',
      title: 'Not Found',
      status: 404,
      code: 'not-found',
      instance: '/v1/does-not-exist',
    });
  });
});

describe('compiled configuration boundary', () => {
  it('keeps health and anonymous readiness working with reserved runtime bindings', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('__USER_SERVICE_COMPILED_CONFIG__', {
      ...LOCAL_PROFILE,
      ENVIRONMENT: 'sandbox',
      AUTH_APP_NAME: 'Compiled User Service',
      AUTH_MAIL_TRANSPORT: 'inmemory',
    });
    const app = createApp();
    const runtime: Env = {
      DB: env.DB,
      ENVIRONMENT: 'dashboard-override',
      AUTH_APP_NAME: 'Dashboard Override',
      BETTER_AUTH_SECRET: 'test-runtime-secret',
    };

    try {
      const health = await app.request('/v1/health', {}, runtime);
      const anonymous = await app.request('/v1/me', {}, runtime);

      expect(health.status).toBe(200);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: 'unauthenticated' });
      expect(warn).toHaveBeenCalledWith(
        JSON.stringify({
          level: 'warn',
          event: 'config.runtime-binding-ignored',
          bindings: ['ENVIRONMENT', 'AUTH_APP_NAME'],
        }),
      );
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls.join(' ')).not.toContain('Dashboard Override');
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('does not warn for an unknown runtime binding', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('__USER_SERVICE_COMPILED_CONFIG__', {
      ...LOCAL_PROFILE,
      ENVIRONMENT: 'sandbox',
      AUTH_MAIL_TRANSPORT: 'inmemory',
    });
    const app = createApp();
    const runtime: Env = { DB: env.DB, BETTER_AUTH_SECRET: 'test-runtime-secret' };
    Object.assign(runtime, { UNKNOWN_DASHBOARD_BINDING: 'ignored-value' });

    try {
      const anonymous = await app.request('/v1/me', {}, runtime);

      expect(anonymous.status).toBe(401);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

// Seam under test (ticket #124, ADR-0012): administration SPA routing through
// the built Worker with a substituted Static Assets binding. These tests prove
// the routing precedence — exact asset hits stream through, misses under
// `/admin` fall back to the SPA entry, unknown `/v1` routes stay JSON — and
// the graceful JSON degradation when no asset pipeline is bound. Real asset
// bytes are covered by the browser integration test, not here.
describe('administration SPA assets', () => {
  const workerEnv = env;

  function assetsEnv(handler: (path: string, request: Request) => Response | null): Env {
    return {
      DB: workerEnv.DB,
      ENVIRONMENT: 'test',
      ASSETS: {
        fetch: (request: Request): Promise<Response> => {
          const path = new URL(request.url).pathname;
          return Promise.resolve(
            handler(path, request) ?? new Response('missing', { status: 404 }),
          );
        },
      },
    };
  }

  function entryHtml(): Response {
    return new Response('<html>admin</html>', {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }

  it('streams exact asset hits through untouched', async () => {
    const app = createApp();
    const res = await app.request(
      '/admin/assets/app.js',
      { method: 'GET' },
      assetsEnv((path) =>
        path === '/assets/app.js'
          ? new Response('console.log(1)', {
              status: 200,
              headers: { 'content-type': 'text/javascript' },
            })
          : null,
      ),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toBe('console.log(1)');
  });

  it('falls back to the SPA entry for client routes such as the sign-in deep link', async () => {
    const app = createApp();
    const res = await app.request(
      '/admin/inicio-sesion',
      { method: 'GET' },
      assetsEnv((path) => (path === '/index.html' ? entryHtml() : null)),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<html>admin</html>');
  });

  it('falls back to the SPA entry for the User detail deep link', async () => {
    const app = createApp();
    const res = await app.request(
      '/admin/users/some-opaque-user-id',
      { method: 'GET' },
      assetsEnv((path) => (path === '/index.html' ? entryHtml() : null)),
    );

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toBe('<html>admin</html>');
  });

  it('serves the SPA entry at /admin', async () => {
    const app = createApp();
    const seen: string[] = [];
    const res = await app.request(
      '/admin',
      { method: 'GET' },
      assetsEnv((path) => {
        seen.push(path);
        return path === '/index.html' ? entryHtml() : null;
      }),
    );

    expect(res.status).toBe(200);
    expect(seen).toEqual(['/index.html']);
  });

  it('preserves a cached client-route entry on conditional revalidation', async () => {
    const etag = '"admin-entry-validator"';
    const assets = assetsEnv((path, request) => {
      if (path !== '/index.html') return null;
      return request.headers.get('if-none-match') === etag
        ? new Response(null, { status: 304, headers: { etag } })
        : entryHtml();
    });
    const app = createApp();
    const revalidated = await app.request(
      '/admin/unknown-route',
      { headers: { 'if-none-match': etag } },
      assets,
    );

    expect(revalidated.status).toBe(304);
    expect(revalidated.headers.get('etag')).toBe(etag);
    expect(await revalidated.text()).toBe('');

    const fresh = await app.request('/admin/unknown-route', {}, assets);
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get('content-type')).toContain('text/html');
  });

  it('returns a real 404 for missing hashed assets rather than SPA HTML', async () => {
    const res = await createApp().request(
      '/admin/assets/missing.js',
      { method: 'GET' },
      assetsEnv((path) => (path === '/index.html' ? entryHtml() : null)),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).not.toContain('text/html');
  });

  it('keeps unknown /v1 routes as JSON Problem Details when assets are bound', async () => {
    const app = createApp();
    const res = await app.request(
      '/v1/does-not-exist',
      { method: 'GET' },
      assetsEnv(() => entryHtml()),
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'not-found', status: 404 });
  });

  it('degrades /admin to JSON Problem Details without an asset pipeline', async () => {
    const app = createApp();
    const res = await app.request(
      '/admin/inicio-sesion',
      { method: 'GET' },
      { DB: workerEnv.DB, ENVIRONMENT: 'test' },
    );

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toMatchObject({ code: 'not-found', status: 404 });
  });
});
