// Captured Cloudflare API envelope for an absent Worker (error code 10007).
// Keep the provider shape: classification must not depend on our own wording.
export const CLOUDFLARE_ABSENT_WORKER_10007 = JSON.stringify({
  success: false,
  errors: [{ code: 10007, message: 'workers.api.error.script_not_found' }],
  messages: [],
  result: null,
});
