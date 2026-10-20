export {};

const baseUrl = (process.env.SMOKE_PRODUCTION_BASE_URL ?? '').trim().replace(/\/+$/, '');

if (baseUrl.length === 0) {
  throw new Error('SMOKE_PRODUCTION_BASE_URL is required.');
}
const url = new URL(baseUrl);
if (url.protocol !== 'https:') {
  throw new Error('Production smoke requires an HTTPS base URL.');
}

const health = await fetch(`${baseUrl}/v1/health`);
const healthPayload = (await health.json()) as { readonly status?: unknown };
if (health.status !== 200 || healthPayload.status !== 'ok') {
  throw new Error('Production smoke failed at health.');
}

const anonymous = await fetch(`${baseUrl}/v1/me`);
const anonymousPayload = (await anonymous.json()) as { readonly code?: unknown };
if (anonymous.status !== 401 || anonymousPayload.code !== 'unauthenticated') {
  throw new Error('Production smoke failed at anonymous identity.');
}

console.log('Production smoke passed: health and anonymous identity.');
