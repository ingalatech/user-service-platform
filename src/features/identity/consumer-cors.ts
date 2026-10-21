import type { Context } from 'hono';
import { createMiddleware } from 'hono/factory';
import { resolveEffectiveConfig } from '../../config/index.js';
import type { Env } from '../../env.js';
import { PROBLEM_JSON, createProblem } from '../../shared/problem.js';
import { resolveConsumerOrigins } from './origin-guard.js';

// Credentialed CORS for the direct-browser consumer transport (spec #164,
// ADR-0013). A browser document served from an exact deployment-configured
// consumer origin calls the service Worker directly with `credentials:
// include`. Only named origins receive a grant; wildcard, `null` and
// arbitrary reflection are never emitted, and CORS is a browser permission
// boundary — not authentication. Cookie-auth mutation authorization stays
// with the Origin/Fetch Metadata guard (`origin-guard.ts`).
export const CONSUMER_CORS_PREFLIGHT_MAX_AGE_SECONDS = 600;

// Methods the consumer identity operations actually use: POST for auth
// mutations and GET for `/v1/me` and the public JWKS document.
export const CONSUMER_CORS_ALLOWED_METHODS = ['GET', 'POST'] as const;

// Request headers the consumer identity operations actually send: JSON
// bodies. `authorization` is admitted for receiving APIs that verify the
// access token; these cookie-based identity operations do not require it.
export const CONSUMER_CORS_ALLOWED_HEADERS = ['content-type', 'authorization'] as const;

export interface ConsumerCorsOriginInput {
  // Raw `Origin` request header value, or null when absent.
  readonly origin: string | null;
  // Exact deployment-owned direct-browser consumer origins.
  readonly consumerOrigins: readonly string[];
}

// Pure origin decision: returns the exact origin to grant, or null. The
// browser sends an already-serialized origin, so exact string membership is
// the only match — no normalization that could widen a grant.
export function evaluateConsumerCorsOrigin(input: ConsumerCorsOriginInput): string | null {
  const origin = (input.origin ?? '').trim();
  if (origin.length === 0) {
    return null;
  }
  return input.consumerOrigins.includes(origin) ? origin : null;
}

export function isAllowedConsumerCorsMethod(method: string): boolean {
  const normalized = method.trim().toUpperCase();
  return (CONSUMER_CORS_ALLOWED_METHODS as readonly string[]).includes(normalized);
}

// Parses a preflight `Access-Control-Request-Headers` list. Returns whether
// every requested header is permitted; an absent/empty list is permitted.
export function areRequestedHeadersAllowed(raw: string | null): boolean {
  const trimmed = (raw ?? '').trim();
  if (trimmed.length === 0) {
    return true;
  }
  return trimmed
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0)
    .every((entry) => (CONSUMER_CORS_ALLOWED_HEADERS as readonly string[]).includes(entry));
}

// Operation paths that carry the direct-browser consumer contract: every
// public identity operation plus `/v1/me`. The administrative surface is
// deliberately excluded — it stays same-origin and is not a consumer grant.
export const CONSUMER_CORS_PATHS = [
  '/auth/register',
  '/auth/login',
  '/auth/verify-email',
  '/auth/request-verification',
  '/auth/request-password-reset',
  '/auth/reset-password',
  '/auth/sign-out',
  '/auth/token',
  '/auth/jwks',
  '/me',
] as const;

type ConsumerCorsContext = Context<{ Bindings: Env; Variables: { requestId: string } }>;

function problem(c: ConsumerCorsContext) {
  // Early malformed-configuration failures bypass route handlers, so they
  // must preserve the personal/token cache boundary (`private, no-store`)
  // and `Vary: Origin` themselves instead of relying on post-`next()`
  // handling. No CORS grant is emitted: the configuration fails closed.
  return c.json(
    createProblem({ status: 500, code: 'internal-error', title: 'Internal Server Error' }),
    500,
    { 'Content-Type': PROBLEM_JSON, 'Cache-Control': 'private, no-store', Vary: 'Origin' },
  );
}

// Hono middleware applying the consumer CORS contract. When a request carries
// the exact configured origin, the response (success or error) receives the
// exact `Access-Control-Allow-Origin`, `Access-Control-Allow-Credentials:
// true` and `Vary: Origin`. Preflight (`OPTIONS` with
// `Access-Control-Request-Method`) needs no session, restricts the method and
// headers to the consumer operations and uses a bounded cache. Unapproved
// origins receive no grant, so the browser cannot read the response; mutated
// state remains protected by the mutation origin guard regardless.
export function createConsumerCorsMiddleware() {
  return createMiddleware<{ Bindings: Env; Variables: { requestId: string } }>(async (c, next) => {
    const origin = c.req.header('origin') ?? null;

    let origins: string[];
    try {
      const effective = resolveEffectiveConfig({
        environment: c.env.ENVIRONMENT,
        runtime: { ...c.env },
      });
      origins = resolveConsumerOrigins(effective.config.AUTH_CONSUMER_ORIGINS);
    } catch {
      // A malformed origin configuration fails closed for browser callers
      // without breaking documented headerless non-browser flows.
      if ((origin ?? '').trim().length > 0) {
        return problem(c);
      }
      origins = [];
    }

    const allowedOrigin = evaluateConsumerCorsOrigin({ origin, consumerOrigins: origins });

    if (c.req.method === 'OPTIONS') {
      const requestedMethod = c.req.header('access-control-request-method');
      if (requestedMethod !== undefined) {
        if (
          allowedOrigin === null ||
          !isAllowedConsumerCorsMethod(requestedMethod) ||
          !areRequestedHeadersAllowed(c.req.header('access-control-request-headers') ?? null)
        ) {
          return c.body(null, 403, { Vary: 'Origin' });
        }
        return c.body(null, 204, {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Allow-Methods': CONSUMER_CORS_ALLOWED_METHODS.join(', '),
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': String(CONSUMER_CORS_PREFLIGHT_MAX_AGE_SECONDS),
          Vary: 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers',
        });
      }
    }

    await next();
    // Always vary on Origin so shared caches never reuse a granted response
    // for an unapproved origin (and vice versa).
    c.res.headers.set('Vary', 'Origin');
    if (allowedOrigin !== null) {
      c.res.headers.set('Access-Control-Allow-Origin', allowedOrigin);
      c.res.headers.set('Access-Control-Allow-Credentials', 'true');
    }
  });
}
