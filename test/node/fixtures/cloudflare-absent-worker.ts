// Captured Cloudflare API envelope for an absent Worker (error code 10007).
// Keep the provider shape: classification must not depend on our own wording.
export const CLOUDFLARE_ABSENT_WORKER_10007 = JSON.stringify({
  success: false,
  errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }],
  messages: [],
  result: null,
});

export const CLOUDFLARE_ABSENT_WORKER_WRANGLER_STDERR =
  '\u001b[31m✘ [ERROR]\u001b[0m A request to the Cloudflare API ' +
  '(/accounts/example/workers/scripts/rch-rugbychampagne-user-service-sandbox/deployments) failed.\n' +
  '  Code: 10007\n' +
  '  Message: workers.api.error.script_not_found\n';
