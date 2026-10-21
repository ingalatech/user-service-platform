import { describe, expect, it } from 'vitest';
import { runHealthSmoke } from '../../scripts/smoke-health.js';
import { runReadinessSmoke } from '../../scripts/smoke-readiness.js';

const baseUrl = 'https://sandbox.example.test';

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

describe('sandbox health smoke entrypoint', () => {
  it.each(['', 'not-a-url', 'ftp://sandbox.example.test'])('rejects URL %j', async (url) => {
    await expect(runHealthSmoke({ baseUrl: url, fetchImpl: failFetch })).rejects.toThrow(
      /required|HTTP\(S\)/,
    );
  });

  it('accepts a successful health response', async () => {
    const requests: string[] = [];
    await runHealthSmoke({
      baseUrl: `${baseUrl}/`,
      fetchImpl: (input) => {
        requests.push(requestUrl(input));
        return Promise.resolve(response(200, JSON.stringify({ status: 'ok' })));
      },
    });
    expect(requests).toEqual([`${baseUrl}/v1/health`]);
  });

  it.each([
    [503, JSON.stringify({ status: 'ok' })],
    [200, JSON.stringify({ status: 'degraded' })],
  ] as const)('rejects incorrect health status/payload: %s', async (status, body) => {
    await expect(
      runHealthSmoke({ baseUrl, fetchImpl: () => Promise.resolve(response(status, body)) }),
    ).rejects.toThrow('Sandbox health smoke failed');
  });

  it('rejects non-JSON and failed fetch responses', async () => {
    await expect(
      runHealthSmoke({ baseUrl, fetchImpl: () => Promise.resolve(response(200, 'not json')) }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(runHealthSmoke({ baseUrl, fetchImpl: failFetch })).rejects.toThrow('network');
  });
});

describe('sandbox readiness smoke entrypoint', () => {
  it.each(['', 'not-a-url', 'ftp://sandbox.example.test'])('rejects URL %j', async (url) => {
    await expect(runReadinessSmoke({ baseUrl: url, fetchImpl: failFetch })).rejects.toThrow(
      /required|HTTP\(S\)/,
    );
  });

  it('accepts health and anonymous unauthenticated Identity', async () => {
    const requests: string[] = [];
    await runReadinessSmoke({
      baseUrl,
      fetchImpl: (input) => {
        const path = requestUrl(input);
        requests.push(path);
        return Promise.resolve(
          path.endsWith('/health')
            ? response(200, JSON.stringify({ status: 'ok' }))
            : response(401, JSON.stringify({ code: 'unauthenticated' })),
        );
      },
    });
    expect(requests).toEqual([`${baseUrl}/v1/health`, `${baseUrl}/v1/me`]);
  });

  it.each([
    [503, JSON.stringify({ status: 'ok' }), /health/],
    [200, JSON.stringify({ status: 'degraded' }), /health/],
  ] as const)('rejects incorrect health readiness response: %s', async (status, body, message) => {
    await expect(
      runReadinessSmoke({ baseUrl, fetchImpl: () => Promise.resolve(response(status, body)) }),
    ).rejects.toThrow(message);
  });

  it.each([
    [200, JSON.stringify({ code: 'unauthenticated' })],
    [401, JSON.stringify({ code: 'authenticated' })],
  ] as const)('rejects incorrect anonymous Identity response: %s', async (status, body) => {
    let requestCount = 0;
    await expect(
      runReadinessSmoke({
        baseUrl,
        fetchImpl: () => {
          requestCount += 1;
          return Promise.resolve(
            requestCount === 1
              ? response(200, JSON.stringify({ status: 'ok' }))
              : response(status, body),
          );
        },
      }),
    ).rejects.toThrow('anonymous identity');
  });

  it('rejects non-JSON and failed fetch responses', async () => {
    await expect(
      runReadinessSmoke({
        baseUrl,
        fetchImpl: () => Promise.resolve(response(200, 'not json')),
      }),
    ).rejects.toThrow(/not valid JSON/);
    await expect(runReadinessSmoke({ baseUrl, fetchImpl: failFetch })).rejects.toThrow('network');
  });
});

const failFetch: typeof fetch = () => Promise.reject(new Error('network failure'));
