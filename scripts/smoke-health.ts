export {};

export interface HealthSmokeOptions {
  readonly baseUrl: string;
  readonly fetchImpl?: typeof fetch;
}

export async function runHealthSmoke(options: HealthSmokeOptions): Promise<void> {
  const baseUrl = options.baseUrl.trim().replace(/\/+$/, '');
  if (baseUrl.length === 0) throw new Error('SMOKE_SANDBOX_BASE_URL is required.');

  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error('Health smoke requires an HTTP(S) base URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Health smoke requires an HTTP(S) base URL.');
  }

  const response = await (options.fetchImpl ?? fetch)(`${baseUrl}/v1/health`);
  let payload: { readonly status?: unknown };
  try {
    payload = (await response.json()) as { readonly status?: unknown };
  } catch {
    throw new Error('Sandbox health smoke failed: response was not valid JSON.');
  }
  if (response.status !== 200 || payload.status !== 'ok') {
    throw new Error('Sandbox health smoke failed.');
  }
}

if (process.argv[1]?.endsWith('smoke-health.ts') === true) {
  runHealthSmoke({ baseUrl: process.env.SMOKE_SANDBOX_BASE_URL ?? '' })
    .then(() => {
      console.log('Sandbox health smoke passed.');
    })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : 'unknown health smoke failure');
      process.exitCode = 1;
    });
}
