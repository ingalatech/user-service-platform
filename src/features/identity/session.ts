import type { Env } from '../../env.js';
import { readEffectiveEnvironment, resolveEffectiveConfig } from '../../config/index.js';
import { createIdentityAuth } from './auth.js';
import { deferredAuthMailer, type AuthMailer } from './mailer.js';
import { resolveAuthPolicy } from './policy.js';
import { resolveAuthSecret } from './secret.js';

// Stable application-owned authenticated identity (ADR-0005, GLOSSARY.md).
// Feature slices consume this contract instead of Better Auth persistence
// models, provider-specific types, session tokens or D1 row representations.
// It mirrors the public `/v1/me` representation: only the stable identity
// fields cross the boundary.
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

// Stable application-facing session data available to authenticated feature
// slices. It carries the resolved user; session mechanics (tokens, cookies,
// storage rows) stay inside the identity slice.
export interface SessionContext {
  readonly user: AuthenticatedUser;
}

export interface ResolveSessionInput {
  readonly env: Env;
  readonly headers: Headers;
  readonly baseURL: string;
  readonly authMailer?: AuthMailer;
  // Request execution-context scheduler for provider-latency work. Callers
  // with an execution context (request handlers) pass it through so session
  // resolution shares the slice's background semantics; callers without one
  // fall back to supervised fire-and-forget. Session reads never trigger
  // mail, so this only preserves consistent wiring.
  readonly background?: (task: Promise<unknown>) => void;
  // Correlation id for failure telemetry (ADR-0009). The `/v1/me` handler
  // forwards the request id set by the composition-root middleware so session
  // failures join the same request trace as the request/error logs.
  readonly requestId?: string;
}

// Stable session-resolution failure phase (ticket #93, ADR-0009). Every
// unexpected session defect is logged with one of these phases before it
// reaches the 500 boundary so operators can distinguish configuration,
// auth-construction and session-store failures without raw exception text.
export type SessionResolvePhase = 'config' | 'auth' | 'session';

// Redacted failure telemetry (ADR-0009): stable level/event/phase plus safe
// correlation metadata only. Exception messages, credentials, cookies,
// tokens, email addresses and action URLs never enter this record.
function logSessionResolveFailure(input: {
  readonly phase: SessionResolvePhase;
  readonly requestId?: string;
  readonly environment?: string;
}): void {
  console.log(
    JSON.stringify({
      level: 'error',
      event: 'session.resolve-failed',
      phase: input.phase,
      ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
      ...(input.environment === undefined ? {} : { environment: input.environment }),
    }),
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Pure boundary mapper: engine session payloads become application-owned
// users. Returns null when the payload does not carry the stable shape so
// callers treat unknown shapes as unauthenticated rather than crash.
export function toAuthenticatedUser(payload: unknown): AuthenticatedUser | null {
  const user = asRecord(asRecord(payload)?.user);
  if (
    user === null ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    typeof user.emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export function toSessionContext(payload: unknown): SessionContext | null {
  const user = toAuthenticatedUser(payload);
  if (user === null) {
    return null;
  }
  return { user };
}

// Request-scoped session resolver for future feature slices (ticket #11).
// Callers pass Worker env, request headers and request origin; this module
// owns the Better Auth wiring internally so no Better Auth type crosses the
// public slice boundary. Returns null when no valid session resolves;
// unexpected infrastructure defects throw to the caller's 500 boundary and
// are logged first with a stable redacted failure phase (never 401: an
// unexpected defect must not masquerade as "unauthenticated").
//
// Session resolution depends only on the dependencies required to resolve a
// session: effective non-secret config, auth policy, signing secret, D1
// binding, request headers and base URL. The transactional-mail transport is
// resolved lazily (see `deferredAuthMailer`) so a mail-boundary
// configuration defect cannot surface as a session-read failure.
export async function resolveSessionContext(
  input: ResolveSessionInput,
): Promise<SessionContext | null> {
  // Application boundary (ticket #57, PR #61 review): compose one effective
  // non-secret configuration from the selected versioned profile + same-name
  // runtime overrides before touching Better Auth or D1. Secrets/bindings
  // continue directly from runtime and never enter the effective config.
  let effective: ReturnType<typeof resolveEffectiveConfig>;
  let policy: ReturnType<typeof resolveAuthPolicy>;
  let secret: string;
  try {
    effective = resolveEffectiveConfig({
      environment: input.env.ENVIRONMENT,
      runtime: { ...input.env },
    });
    policy = resolveAuthPolicy(effective.config);
    secret = resolveAuthSecret({
      ENVIRONMENT: effective.config.ENVIRONMENT,
      BETTER_AUTH_SECRET: input.env.BETTER_AUTH_SECRET,
    });
  } catch (error) {
    logSessionResolveFailure({
      phase: 'config',
      requestId: input.requestId,
      environment: readEffectiveEnvironment(input.env),
    });
    throw error;
  }
  const background =
    input.background ??
    ((task) => {
      task.catch(() => {
        console.log(JSON.stringify({ level: 'error', event: 'auth-mail.failed' }));
      });
    });
  let auth: ReturnType<typeof createIdentityAuth>;
  try {
    auth = createIdentityAuth({
      db: input.env.DB,
      policy,
      mailer: deferredAuthMailer(
        {
          ...effective.config,
          RESEND_API_KEY: input.env.RESEND_API_KEY,
          SMTP_USER: input.env.SMTP_USER,
          SMTP_PASSWORD: input.env.SMTP_PASSWORD,
        },
        input.authMailer,
      ),
      secret,
      baseURL: input.baseURL,
      verifyEmailActionURL: effective.config.AUTH_VERIFY_EMAIL_ACTION_URL,
      resetPasswordActionURL: effective.config.AUTH_RESET_PASSWORD_ACTION_URL,
      background,
    });
  } catch (error) {
    logSessionResolveFailure({
      phase: 'auth',
      requestId: input.requestId,
      environment: effective.environment,
    });
    throw error;
  }

  let session: unknown;
  try {
    // Bypass the signed cookie cache so a revoked session cannot authorize
    // through cached payload after sign-out; the D1 store is authoritative.
    session = await auth.api.getSession({
      headers: input.headers,
      query: { disableCookieCache: true },
    });
  } catch (error) {
    logSessionResolveFailure({
      phase: 'session',
      requestId: input.requestId,
      environment: effective.environment,
    });
    throw error;
  }
  if (session === null) {
    return null;
  }
  return toSessionContext(session);
}
