export {};

const baseUrl = (process.env.SMOKE_SANDBOX_BASE_URL ?? '').trim().replace(/\/+$/, '');

if (baseUrl.length === 0) {
  throw new Error('SMOKE_SANDBOX_BASE_URL is required.');
}

const url = new URL(baseUrl);
if (url.protocol !== 'https:' && url.protocol !== 'http:') {
  throw new Error('Readiness smoke requires an HTTP(S) base URL.');
}

const health = await fetch(`${baseUrl}/v1/health`);
const healthPayload = (await health.json()) as { readonly status?: unknown };
if (health.status !== 200 || healthPayload.status !== 'ok') {
  throw new Error('Sandbox readiness failed at health.');
}

const anonymous = await fetch(`${baseUrl}/v1/me`);
const anonymousPayload = (await anonymous.json()) as { readonly code?: unknown };
if (anonymous.status !== 401 || anonymousPayload.code !== 'unauthenticated') {
  throw new Error('Sandbox readiness failed at anonymous identity.');
}

console.log('Sandbox readiness passed: health and anonymous identity.');
