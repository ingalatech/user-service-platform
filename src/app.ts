import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import { requestId } from 'hono/request-id';
import { routePath } from 'hono/route';
import { readEffectiveEnvironment } from './config/index.js';
import type { Env } from './env.js';
import { createHealthRouter } from './features/health/index.js';
import {
  createAuthActionsRouter,
  createIdentityRouter,
  createIdentityV2Router,
  type IdentityRouterOptions,
} from './features/identity/index.js';
import { openApiConfig } from './openapi.js';
import { PROBLEM_JSON, createProblem } from './shared/problem.js';

interface AppVariables {
  requestId: string;
}

export interface AppBindings {
  Bindings: Env;
  Variables: AppVariables;
}

// Reads the deployment environment without assuming bindings are present.
// Hono types `c.env` as always defined, but requests driven via
// `app.request()` without an explicit Env leave it undefined at runtime;
// liveness and error paths must never crash on that.
function readEnvironment(c: Context<AppBindings>, warningState: Set<string>): string {
  const bindings = c.env as Partial<Env> | undefined;
  return readEffectiveEnvironment(bindings, warningState);
}

// Telemetry-safe request path (ticket #126, ADR-0009): parameterized routes
// such as `/v1/admin/users/{userId}` must never leak raw User identifiers or
// personal data into ordinary request/error logs. The matched route pattern
// (for example `/v1/admin/users/:userId`) carries the operation identity
// without values; unmatched paths fall back to the raw pathname.
function loggedPath(c: Context<AppBindings>): string {
  try {
    const pattern = routePath(c);
    if (typeof pattern === 'string' && pattern.length > 0) {
      return pattern;
    }
  } catch {
    // No matched route (unknown paths, early failures): the raw pathname is
    // the only operation identity available. Unknown paths carry no
    // parameter values by construction; only matched parameterized patterns
    // redact values.
  }
  return new URL(c.req.url).pathname;
}

// Application composition root. Feature slices register their OpenAPI-aware
// routers here under the `/v1` namespace; cross-feature imports must stay on
// public slice interfaces (AGENTS.md change rules).
// Serves one administration SPA path through the Static Assets binding
// (ticket #124). Exact asset hits stream through untouched; misses under
// `/admin` fall back to the SPA entry. Without a bound asset pipeline
// (notably unit-test boots and checkouts without a prior `build:admin`)
// the request ends as JSON Problem Details instead of crashing; the deploy
// preflight fails closed when distributable assets are missing.
async function serveAdminAsset(c: Context<AppBindings>, path: string): Promise<Response> {
  const assets = (c.env as Partial<Env> | undefined)?.ASSETS;
  if (assets === undefined) {
    return c.json(
      createProblem({
        status: 404,
        code: 'not-found',
        title: 'Not Found',
        instance: new URL(c.req.url).pathname,
      }),
      404,
      { 'Content-Type': PROBLEM_JSON },
    );
  }
  const origin = new URL(c.req.url).origin;
  // Vite's dist contains index.html and assets/ at its root. Public URLs
  // retain /admin; only the binding request removes that mount prefix.
  const assetPath =
    path === '/admin' || path === '/admin/' ? '/index.html' : path.slice('/admin'.length);
  const hit = await assets.fetch(new Request(`${origin}${assetPath}`, c.req.raw));
  if (hit.status !== 404) {
    return hit;
  }
  // Single-page-application fallback, scoped to `/admin` only: client routes
  // (including the sign-in deep link) boot from the same entry document.
  // Missing hashed assets must stay 404; returning HTML would disguise an
  // invalid deployment as a JavaScript parse failure.
  if (assetPath.startsWith('/assets/')) return hit;
  const entry = await assets.fetch(new Request(`${origin}/index.html`, c.req.raw));
  // A conditional navigation can revalidate the cached SPA entry. Preserve
  // its 304 so the browser reuses HTML rather than replacing it with JSON 404.
  if (entry.ok || entry.status === 304) {
    return entry;
  }
  return c.json(
    createProblem({
      status: 404,
      code: 'not-found',
      title: 'Not Found',
      instance: new URL(c.req.url).pathname,
    }),
    404,
    { 'Content-Type': PROBLEM_JSON },
  );
}

export function createApp(identityOptions: IdentityRouterOptions = {}) {
  const warningState = new Set<string>();
  const app = new OpenAPIHono<AppBindings>({
    // Contract-wide validation failure shape: invalid public API input uses the
    // RFC 9457 Problem Details envelope instead of the framework default.
    defaultHook: (result, c) => {
      if (!result.success) {
        return c.json(
          createProblem({
            status: 400,
            code: 'bad-request',
            title: 'Bad Request',
            detail: 'The request did not match the public contract.',
            instance: new URL(c.req.url).pathname,
          }),
          400,
          { 'Content-Type': PROBLEM_JSON, 'Cache-Control': 'no-store' },
        );
      }
      return undefined;
    },
  });

  app.use(requestId());

  // Structured request log (ADR-0009): correlation id, matched route
  // pattern, status and duration. Credentials, tokens and personal data are
  // never logged. Parameterized feature routes log the matched pattern
  // (for example `/v1/admin/users/:userId`) instead of raw paths that could
  // carry User identifiers or search values.
  app.use(async (c, next) => {
    const started = Date.now();
    await next();
    const record = {
      level: c.error === undefined ? 'info' : 'error',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: loggedPath(c),
      status: c.res.status,
      durationMs: Date.now() - started,
      environment: readEnvironment(c, warningState),
    };
    console.log(JSON.stringify(record));
  });

  app.route('/v1', createHealthRouter());
  app.route('/v1', createIdentityRouter(identityOptions));
  // ADR-0007 versioned transition: only the no-public-name registration
  // operation is mounted in V2; the accepted V1 Identity surface is unchanged.
  app.route('/v2', createIdentityV2Router(identityOptions));
  // Service-owned fallback browser action pages (ticket #77). Plain HTML
  // handlers outside the versioned JSON API: they complete through the
  // existing POST `/v1` contracts and never enter the OpenAPI document.
  app.route('/auth-actions', createAuthActionsRouter());
  // Administration SPA (ticket #124, ADR-0012). The built client-only assets
  // are served on this same origin under `/admin` through the Static Assets
  // binding, so browser navigation keeps the HttpOnly session cookie.
  // Precedence is explicit: `/v1/*` and `/auth-actions/*` above keep their
  // behavior, asset misses under `/admin` fall back to the SPA entry so the
  // sign-in deep link survives refresh, and the fallback never applies
  // outside `/admin` (unknown versioned API routes stay JSON Problem Details).
  app.get('/admin', (c) => serveAdminAsset(c, '/admin/index.html'));
  app.get('/admin/*', (c) => serveAdminAsset(c, new URL(c.req.url).pathname));

  app.doc('/v1/openapi.json', openApiConfig);

  app.notFound((c) =>
    c.json(
      createProblem({
        status: 404,
        code: 'not-found',
        title: 'Not Found',
        instance: new URL(c.req.url).pathname,
      }),
      404,
      { 'Content-Type': PROBLEM_JSON },
    ),
  );

  // Exception messages are never logged: future auth/DB/provider errors can
  // carry secrets, so the log carries only stable identifiers and safe
  // metadata (ADR-0009, PR #15 acceptance review). The path is the matched
  // route pattern so parameterized detail failures cannot leak identifiers.
  app.onError((_err, c) => {
    console.log(
      JSON.stringify({
        level: 'error',
        requestId: c.get('requestId'),
        method: c.req.method,
        path: loggedPath(c),
        status: 500,
        code: 'internal-error',
        environment: readEnvironment(c, warningState),
      }),
    );
    return c.json(
      createProblem({
        status: 500,
        code: 'internal-error',
        title: 'Internal Server Error',
      }),
      500,
      { 'Content-Type': PROBLEM_JSON },
    );
  });

  return app;
}
