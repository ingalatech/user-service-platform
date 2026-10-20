export {};

const baseUrl = (process.env.SMOKE_SANDBOX_BASE_URL ?? '').trim().replace(/\/+$/, '');

if (baseUrl.length === 0) {
  throw new Error('SMOKE_SANDBOX_BASE_URL is required.');
}

const url = new URL(baseUrl);
if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  throw new Error('Health smoke requires an HTTP(S) base URL.');
}

const response = await fetch(`${baseUrl}/v1/health`);
const payload = (await response.json()) as { readonly status?: unknown };
if (response.status !== 200 || payload.status !== 'ok') {
  throw new Error('Sandbox health smoke failed.');
}

console.log('Sandbox health smoke passed.');
