import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Env } from '../../env.js';
import { PROBLEM_JSON, createProblem, type ProblemCode } from '../../shared/problem.js';
import { resolveAdminIdentity } from './authorization.js';
import { getAdminUserById, listAdminUsers } from './admin-users.js';
import {
  bootstrapAdminUser,
  type BootstrapCreateUser,
  type BootstrapDeleteUser,
  type BootstrapSetRole,
} from './admin.js';
import { CONSUMER_CORS_PATHS, createConsumerCorsMiddleware } from './consumer-cors.js';
import { extractReaderStateExpiry } from './reader-state.js';
import type { ConsumerJsonWebKey } from './contract.js';
import type { AuthMailer } from './mailer.js';
import { createIdentityRuntime } from './identity-runtime.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { evaluatePasswordPolicy } from './password-policy.js';
import { isCurrentPasswordResetToken } from './password-reset-token.js';
import {
  adminBootstrapRoute,
  adminMeRoute,
  adminUserDetailRoute,
  adminUsersRoute,
  authConfigRoute,
  checkPasswordResetRoute,
  consumerJwksRoute,
  readerStateRoute,
  currentUserRoute,
  loginRoute,
  registerRoute,
  requestPasswordResetRoute,
  requestVerificationRoute,
  resetPasswordRoute,
  signOutRoute,
  verifyEmailRoute,
} from './route.js';
import { toAuthenticatedUser } from './session.js';
import { consumeLatestVerificationToken } from './verification-token.js';

export interface IdentityRouterOptions {
  // Test seam: an explicitly provided mailer (in-memory in tests) takes
  // precedence over environment resolution.
  readonly authMailer?: AuthMailer;
  // Deterministic lease-clock and engine-failure seams for Worker-runtime tests.
  readonly now?: () => number;
  readonly bootstrapLeaseTtlMs?: number;
  readonly bootstrapCreateUser?: BootstrapCreateUser;
  readonly bootstrapSetRole?: BootstrapSetRole;
  readonly bootstrapDeleteUser?: BootstrapDeleteUser;
}

type IdentityContext = Context<{ Bindings: Env; Variables: { requestId: string } }>;

// Bounded public cache lifetime for the consumer JWKS document, in seconds
// (spec #150). Receiving verifiers may cache fetched keys this long;
// verification keys themselves are retained in D1 through every outstanding
// token lifetime plus the documented clock tolerance.
const CONSUMER_JWKS_CACHE_MAX_AGE_SECONDS = 300;

function requestIdentityRuntime(c: IdentityContext, authMailer?: AuthMailer): IdentityRuntime {
  return createIdentityRuntime({
    env: c.env,
    requestUrl: c.req.url,
    executionContext: {
      waitUntil: (task) => {
        c.executionCtx.waitUntil(task);
      },
    },
    authMailer,
  });
}

// Better Auth failure surfaced either as an error Response (asResponse mode)
// or as a thrown APIError. Only the numeric status and string code cross
// this boundary; messages from the auth engine are never forwarded because
// they are not stable machine contracts.
interface EngineFailure {
  readonly status: number;
  readonly code?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

async function readEngineFailure(response: Response): Promise<EngineFailure> {
  let code: string | undefined;
  try {
    const payload: unknown = await response.json();
    const record = asRecord(payload);
    if (record !== null && typeof record.code === 'string') {
      code = record.code;
    }
  } catch {
    // Non-JSON failure bodies carry no machine contract; status is enough.
  }
  return { status: response.status, code };
}

function thrownEngineFailure(error: unknown): EngineFailure | null {
  const record = asRecord(error);
  const statusCode = record?.statusCode;
  if (typeof statusCode !== 'number') {
    return null;
  }
  const body = asRecord(record?.body);
  const code = body?.code;
  return { status: statusCode, code: typeof code === 'string' ? code : undefined };
}

// Calls a Better Auth server endpoint in asResponse mode so session cookies
// stay visible as Set-Cookie headers. Never throws for engine-level
// failures; only unexpected defects escape to the 500 boundary.
async function callEngine(call: () => Promise<Response>): Promise<Response | EngineFailure> {
  try {
    return await call();
  } catch (error) {
    return thrownEngineFailure(error) ?? { status: 500 };
  }
}

function problem(
  c: IdentityContext,
  status: 400 | 401 | 403 | 404 | 409 | 500,
  code: ProblemCode,
  title: string,
  detail?: string,
  cacheControl?: string,
) {
  return c.json(
    createProblem({
      status,
      code,
      title,
      ...(detail === undefined ? {} : { detail }),
      instance: new URL(c.req.url).pathname,
    }),
    status,
    cacheControl === undefined
      ? { 'Content-Type': PROBLEM_JSON }
      : { 'Content-Type': PROBLEM_JSON, 'Cache-Control': cacheControl },
  );
}

function passwordPolicyProblem(
  c: IdentityContext,
  password: string,
  policy: IdentityRuntime['authPolicy'],
) {
  const evaluation = evaluatePasswordPolicy(password, policy.passwordPolicy);
  if (evaluation.valid) return null;
  return c.json(
    createProblem({
      status: 400,
      code: 'password-policy-violation',
      title: 'Password does not meet policy',
      detail: 'The password does not meet the effective password policy.',
      instance: new URL(c.req.url).pathname,
      failedRules: evaluation.failedRules,
      passwordPolicy: evaluation.policy,
    }),
    400,
    { 'Content-Type': PROBLEM_JSON, 'Cache-Control': 'no-store' },
  );
}

// Explicit Origin/Fetch Metadata protection for cookie-auth mutation
// operations (spec #150, ADR-0013). Returns a rejection response when the
// request must not mutate cookie-authenticated state, null when it may
// proceed. Configuration defects fail closed as 500. The optional cache
// control keeps token-route rejections private, no-store.
function guardCookieMutation(
  c: IdentityContext,
  runtime: IdentityRuntime,
  cacheControl?: string,
): ReturnType<typeof problem> | null {
  let allowed: boolean;
  try {
    allowed = runtime.cookieMutationAllowed(c.req.raw.headers);
  } catch {
    return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, cacheControl);
  }
  if (!allowed) {
    return problem(
      c,
      403,
      'forbidden',
      'Forbidden',
      'The request origin is not allowed for this operation.',
      cacheControl,
    );
  }
  return null;
}

function forwardSessionCookies(c: IdentityContext, source: Response): void {
  const cookies =
    typeof source.headers.getSetCookie === 'function' ? source.headers.getSetCookie() : [];
  for (const cookie of cookies) {
    c.header('Set-Cookie', cookie, { append: true });
  }
}

// Identity feature router (vertical slice, ADR-0002). Contract-bearing
// routes stay on the OpenAPI-aware router so their definitions survive
// mounting under `/v1`. Handlers map Better Auth outcomes onto the
// application-owned contracts; no Better Auth, session-token or D1 row type
// crosses the handler boundary.
export function createIdentityRouter(options: IdentityRouterOptions = {}) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { requestId: string } }>();
  const override = options.authMailer;

  // Direct-browser consumer transport (spec #164, ADR-0013): credentialed
  // CORS is applied to the public consumer identity operations only. It is a
  // browser permission boundary; mutation authorization stays with
  // `guardCookieMutation`. Administrative routes are deliberately excluded.
  const consumerCors = createConsumerCorsMiddleware();
  for (const path of CONSUMER_CORS_PATHS) {
    router.use(path, consumerCors);
  }

  router.openapi(registerRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) {
      return rejected;
    }
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }
    if (!policy.registrationEnabled) {
      return problem(c, 403, 'registration-disabled', 'Registration is disabled');
    }

    const input = c.req.valid('json');
    const passwordFailure = passwordPolicyProblem(c, input.password, policy);
    if (passwordFailure !== null) return passwordFailure;
    const outcome = await callEngine(() =>
      auth.api.signUpEmail({
        body: {
          name: input.name ?? input.email.slice(0, input.email.indexOf('@')),
          email: input.email,
          password: input.password,
        },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        const user = toAuthenticatedUser(await outcome.json().catch(() => null));
        if (user === null) {
          return problem(c, 500, 'internal-error', 'Internal Server Error');
        }
        return c.json(user, 201);
      }
      return problem(c, 400, 'bad-request', 'Bad Request');
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(loginRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) {
      return rejected;
    }
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.signInEmail({
        body: { email: input.email, password: input.password },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        const user = toAuthenticatedUser(await outcome.json().catch(() => null));
        if (user === null) {
          return problem(c, 500, 'internal-error', 'Internal Server Error');
        }
        forwardSessionCookies(c, outcome);
        return c.json(user, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status === 403 && failure.code === 'EMAIL_NOT_VERIFIED') {
        return problem(
          c,
          403,
          'email-verification-required',
          'Email verification required',
          'Verify the email address before signing in.',
        );
      }
      if (failure.status === 401) {
        return problem(c, 401, 'invalid-credentials', 'Invalid credentials');
      }
      return problem(c, 400, 'bad-request', 'Bad Request');
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(verifyEmailRoute, async (c) => {
    const input = c.req.valid('json');
    // This conditional update is the linearization point. It runs before
    // Better Auth can take any verification branch, including its already-
    // verified fast path; later engine failure is intentionally fail-closed.
    let consumed: boolean;
    try {
      consumed = await consumeLatestVerificationToken({ db: c.env.DB, token: input.token });
    } catch {
      consumed = false;
    }
    if (!consumed) {
      return problem(
        c,
        400,
        'verification-invalid',
        'Invalid or expired verification',
        'The verification action is invalid or has expired.',
      );
    }
    const auth = requestIdentityRuntime(c, override).authentication();
    const outcome = await callEngine(() =>
      auth.api.verifyEmail({
        query: { token: input.token },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // The engine returns `{ status: true, user: null }` on this path;
        // the verified address is the one the client submitted the action
        // for, and eligibility is proven by the subsequent login instead of
        // by echoing engine internals.
        return c.json({ emailVerified: true as const }, 200);
      }
      return problem(
        c,
        400,
        'verification-invalid',
        'Invalid or expired verification',
        'The verification action is invalid or has expired.',
      );
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(requestVerificationRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.sendVerificationEmail({
        body: { email: input.email },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // Generic acceptance: the engine answers identically for unknown,
        // verified and unverified addresses, so this response cannot be
        // used for account enumeration and never creates identities.
        return c.json({ status: 'ok' as const }, 202);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.code === 'EMAIL_MISMATCH') {
        return problem(c, 400, 'bad-request', 'Bad Request');
      }
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 202);
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(requestPasswordResetRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const outcome = await callEngine(() =>
      auth.api.requestPasswordReset({
        body: { email: input.email },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // Generic acceptance: the engine answers identically for unknown and
        // known addresses, so this response cannot be used for account
        // enumeration and never creates identities.
        return c.json({ status: 'ok' as const }, 202);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 202);
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(checkPasswordResetRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }
    const input = c.req.valid('json');
    let valid: boolean;
    try {
      valid = await isCurrentPasswordResetToken({ db: c.env.DB, token: input.token });
    } catch {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
    }
    return c.json({ valid }, 200, { 'Cache-Control': 'no-store' });
  });

  router.openapi(resetPasswordRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const passwordFailure = passwordPolicyProblem(c, input.newPassword, policy);
    if (passwordFailure !== null) return passwordFailure;
    const outcome = await callEngine(() =>
      auth.api.resetPassword({
        body: { newPassword: input.newPassword, token: input.token },
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        // The engine consumes the reset action (single use) and revokes
        // existing sessions per the accepted security default.
        return c.json({ status: 'ok' as const }, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return problem(
        c,
        400,
        'reset-invalid',
        'Invalid or expired password reset',
        'The password-reset action is invalid or has expired.',
      );
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(currentUserRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    return c.json(session.user, 200);
  });

  router.openapi(signOutRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) {
      return rejected;
    }
    const auth = runtime.authentication();
    const outcome = await callEngine(() =>
      auth.api.signOut({
        headers: c.req.raw.headers,
        asResponse: true,
      }),
    );
    if (outcome instanceof Response) {
      // Forward the clearing cookie so the browser/API client drops the
      // session. Sign-out stays idempotent: 4xx engine answers still end as
      // `ok` so the response cannot be used to probe session state.
      forwardSessionCookies(c, outcome);
      if (outcome.ok) {
        return c.json({ status: 'ok' as const }, 200);
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error');
      }
      return c.json({ status: 'ok' as const }, 200);
    }
    const failure = outcome;
    if (failure.status >= 500) {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    return c.json({ status: 'ok' as const }, 200);
  });

  // Reader State issue/refresh (spec #195, ticket #196, ADR-0013). The live
  // HttpOnly session is resolved authoritatively (expiry/revocation aware,
  // cookie cache bypassed) before any token handling; the same operation
  // serves initial issue and renewal. All responses are private, no-store.
  router.openapi(readerStateRoute, async (c) => {
    const noStore = 'private, no-store';
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime, noStore);
    if (rejected !== null) {
      return rejected;
    }
    let tokenAuth: ReturnType<typeof runtime.readerState>;
    try {
      tokenAuth = runtime.readerState();
    } catch {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
    }
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, noStore);
    }
    const outcome = await callEngine(() =>
      tokenAuth.api.getToken({ headers: c.req.raw.headers, asResponse: true }),
    );
    if (outcome instanceof Response) {
      if (outcome.ok) {
        const token = asRecord(await outcome.json().catch(() => null))?.token;
        if (typeof token !== 'string' || token.length === 0) {
          return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
        }
        const expiresAt = extractReaderStateExpiry(token);
        if (expiresAt === null) {
          return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
        }
        return c.json({ readerState: token, expiresAt }, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': noStore,
        });
      }
      const failure = await readEngineFailure(outcome);
      if (failure.status >= 500) {
        return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
      }
      // The authoritative session check passed but issuance found no live
      // session (for example revoked between the two reads): deny as
      // unauthenticated rather than minting.
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, noStore);
    }
    if (outcome.status >= 500) {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
    }
    return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, noStore);
  });

  // Consumer verification-key publication (spec #150, ADR-0013). Only public
  // asymmetric key material is ever projected here; private keys stay in D1
  // behind the engine encryption facility. Successful responses carry bounded
  // public caching; failures are never cached.
  router.openapi(consumerJwksRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    let tokenAuth: ReturnType<typeof runtime.readerState>;
    try {
      tokenAuth = runtime.readerState();
    } catch {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
    }
    const outcome = await callEngine(() =>
      tokenAuth.api.getJwks({ headers: c.req.raw.headers, asResponse: true }),
    );
    if (outcome instanceof Response && outcome.ok) {
      const keys = asRecord(await outcome.json().catch(() => null))?.keys;
      if (!Array.isArray(keys)) {
        return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
      }
      const projected: ConsumerJsonWebKey[] = [];
      for (const entry of keys) {
        const record = asRecord(entry);
        if (
          record === null ||
          typeof record.kid !== 'string' ||
          typeof record.kty !== 'string' ||
          typeof record.alg !== 'string'
        ) {
          return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
        }
        const key: ConsumerJsonWebKey = {
          kid: record.kid,
          kty: record.kty,
          alg: record.alg,
        };
        for (const field of ['use', 'crv', 'x', 'y', 'n', 'e'] as const) {
          const value = record[field];
          if (value === undefined) {
            continue;
          }
          if (typeof value !== 'string') {
            return problem(
              c,
              500,
              'internal-error',
              'Internal Server Error',
              undefined,
              'no-store',
            );
          }
          key[field] = value;
        }
        projected.push(key);
      }
      return c.json({ keys: projected }, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': `public, max-age=${CONSUMER_JWKS_CACHE_MAX_AGE_SECONDS.toString()}`,
      });
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
  });

  router.openapi(authConfigRoute, (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const policy = runtime.authPolicy;
    return c.json(
      {
        capabilities: {
          registration: policy.registrationEnabled,
          emailPassword: policy.emailPasswordEnabled,
          emailVerification: policy.requireEmailVerification,
          passwordReset: policy.emailPasswordEnabled,
        },
        passwordPolicy: policy.passwordPolicy,
      },
      200,
      { 'Cache-Control': 'no-store' },
    );
  });

  router.openapi(adminMeRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    const auth = runtime.administration();
    const admin = await resolveAdminIdentity({
      auth,
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    if (admin === null) {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    return c.json(admin, 200);
  });

  router.openapi(adminUsersRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    const auth = runtime.administration();
    const admin = await resolveAdminIdentity({
      auth,
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    if (admin === null) {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    // The permission boundary resolved before this read: anonymous,
    // expired, revoked and non-administrative callers never reach the list.
    const query = c.req.valid('query');
    const listing = await listAdminUsers({
      db: c.env.DB,
      limit: query.limit,
      offset: query.offset,
      email: query.email,
    });
    return c.json(listing, 200);
  });

  router.openapi(adminUserDetailRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    const auth = runtime.administration();
    const admin = await resolveAdminIdentity({
      auth,
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    if (admin === null) {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    // The permission boundary resolved before this lookup: anonymous,
    // expired, revoked and non-administrative callers never reach the read,
    // so a regular User receives 403 even for an identifier that does not
    // exist. Only validated opaque identifiers reach the store.
    const params = c.req.valid('param');
    const detail = await getAdminUserById({ db: c.env.DB, userId: params.userId });
    if (detail === null) {
      return problem(c, 404, 'not-found', 'Not Found', 'No such User.');
    }
    return c.json(detail, 200);
  });

  router.openapi(adminBootstrapRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const auth = runtime.authentication();
    const policy = runtime.authPolicy;
    // Bootstrap provisions an email/password credential, so it honors the
    // credential-mechanism switch. It stays independent of the public
    // registration switch: operators must be able to provision the first
    // administrator of a closed deployment.
    if (!policy.emailPasswordEnabled) {
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    }

    const input = c.req.valid('json');
    const passwordFailure = passwordPolicyProblem(c, input.password, policy);
    if (passwordFailure !== null) return passwordFailure;
    const outcome = await bootstrapAdminUser({
      auth,
      createBootstrapAuth: (userId) => runtime.bootstrapAdministrator(userId),
      db: c.env.DB,
      name: input.name,
      email: input.email,
      password: input.password,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.bootstrapLeaseTtlMs === undefined
        ? {}
        : { leaseTtlMs: options.bootstrapLeaseTtlMs }),
      ...(options.bootstrapCreateUser === undefined
        ? {}
        : { createUser: options.bootstrapCreateUser }),
      ...(options.bootstrapSetRole === undefined ? {} : { setRole: options.bootstrapSetRole }),
      ...(options.bootstrapDeleteUser === undefined
        ? {}
        : { deleteUser: options.bootstrapDeleteUser }),
    });
    if (outcome.status === 'created') {
      return c.json(outcome.admin, 201);
    }
    if (outcome.status === 'already-bootstrapped') {
      return problem(
        c,
        409,
        'admin-already-bootstrapped',
        'Administrator already bootstrapped',
        'An administrative User already exists; bootstrap cannot create another.',
      );
    }
    if (outcome.status === 'in-progress') {
      return problem(
        c,
        409,
        'admin-bootstrap-in-progress',
        'Administrator bootstrap in progress',
        'Another administrator bootstrap is still in progress; retry shortly.',
      );
    }
    return problem(
      c,
      409,
      'admin-email-conflict',
      'Administrator email conflict',
      'The email address is already registered; bootstrap cannot duplicate it.',
    );
  });

  return router;
}
