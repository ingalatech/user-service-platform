import { createApp } from './app.js';
import { retryAccountPhotoCleanup } from './features/identity/account-photo-operations.js';
import type { Env } from './env.js';
import type { ExecutionContext, ScheduledController } from '@cloudflare/workers-types';

// Cloudflare Worker entrypoint: the composed application is the Worker.
const app = createApp();

export default {
  async fetch(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
    return app.fetch(request, env, context);
  },
  scheduled(_controller: ScheduledController, env: Env, context: ExecutionContext): void {
    if (env.FILES === undefined) return;
    context.waitUntil(retryAccountPhotoCleanup(env.DB, env.FILES).catch(() => undefined));
  },
};
