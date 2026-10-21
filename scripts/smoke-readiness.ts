export {};

export interface ReadinessSmokeOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export async function runReadinessSmoke(options: ReadinessSmokeOptions): Promise<void> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (baseUrl.length === 0) throw new Error('SMOKE_SANDBOX_BASE_URL is required.');

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Readiness smoke requires an HTTP(S) base URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Readiness smoke requires an HTTP(S) base URL.');
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const health = await fetchImpl(`${baseUrl}/v1/health`);
  let healthPayload: { readonly status?: unknown };
  try {
    healthPayload = (await health.json()) as { readonly status?: unknown };
  } catch {
    throw new Error('Sandbox readiness failed at health: response was not valid JSON.');
  }
  if (health.status !== 200 || healthPayload.status !== 'ok') {
    throw new Error('Sandbox readiness failed at health.');
  }

  const anonymous = await fetchImpl(`${baseUrl}/v1/me`);
  let anonymousPayload: { readonly code?: unknown };
  try {
    anonymousPayload = (await anonymous.json()) as { readonly code?: unknown };
  } catch {
    throw new Error('Sandbox readiness failed at anonymous identity: response was not valid JSON.');
  }
  if (anonymous.status !== 401 || anonymousPayload.code !== 'unauthenticated') {
    throw new Error('Sandbox readiness failed at anonymous identity.');
  }
}

if (process.argv[1]?.endsWith('smoke-readiness.ts') === true) {
  runReadinessSmoke({ baseUrl: process.env.SMOKE_SANDBOX_BASE_URL ?? '' })
    .then(() => {
      console.log('Sandbox readiness passed: health and anonymous identity.');
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'unknown readiness smoke failure');
      process.exitCode = 1;
    });
}
