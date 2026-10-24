import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Env } from '../../env.js';
import { PROBLEM_JSON, createProblem, type ProblemCode } from '../../shared/problem.js';
import { createAdminUserReader } from './admin-users.js';
import {
  bootstrapAdminUser,
  type BootstrapCreateUser,
  type BootstrapDeleteUser,
  type BootstrapSetRole,
} from './admin.js';
import { createCredentialOperations, type CredentialFailure } from './credential-operations.js';
import { CONSUMER_CORS_PATHS, createConsumerCorsMiddleware } from './consumer-cors.js';
import { createReaderStateOperations } from './reader-state-operations.js';
import type { AuthMailer } from './mailer.js';
import { createIdentityRuntime } from './identity-runtime.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { evaluatePasswordPolicy } from './password-policy.js';
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

function credentialProblem(c: IdentityContext, failure: CredentialFailure, cacheControl?: string) {
  switch (failure.kind) {
    case 'email-password-disabled':
      return problem(c, 403, 'email-password-disabled', 'Email authentication is disabled');
    case 'registration-disabled':
      return problem(
        c,
        403,
        'registration-disabled',
        'Registration is disabled',
        'Registration is disabled.',
      );
    case 'password-policy-violation':
      return c.json(
        createProblem({
          status: 400,
          code: 'password-policy-violation',
          title: 'Password does not meet policy',
          detail: 'The password does not meet the effective password policy.',
          instance: new URL(c.req.url).pathname,
          failedRules: failure.failedRules,
          passwordPolicy: failure.passwordPolicy,
        }),
        400,
        { 'Content-Type': PROBLEM_JSON, 'Cache-Control': 'no-store' },
      );
    case 'email-verification-required':
      return problem(
        c,
        403,
        'email-verification-required',
        'Email verification required',
        'Verify the email address before signing in.',
      );
    case 'invalid-credentials':
      return problem(c, 401, 'invalid-credentials', 'Invalid credentials');
    case 'verification-invalid':
      return problem(
        c,
        400,
        'verification-invalid',
        'Invalid or expired verification',
        'The verification action is invalid or has expired.',
      );
    case 'reset-invalid':
      return problem(
        c,
        400,
        'reset-invalid',
        'Invalid or expired password reset',
        'The password-reset action is invalid or has expired.',
      );
    case 'bad-request':
      return problem(c, 400, 'bad-request', 'Bad Request');
    case 'internal-error':
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, cacheControl);
  }
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

function forwardSessionCookies(c: IdentityContext, cookies: readonly string[]): void {
  for (const cookie of cookies) {
    c.header('Set-Cookie', cookie, { append: true });
  }
}

// Identity feature router (vertical slice, ADR-0002). Contract-bearing
// routes stay on the OpenAPI-aware router so their definitions survive
// mounting under `/v1`. Application operation modules map engine and D1
// outcomes onto the contracts; this router adapts those outcomes to HTTP
// without exposing Better Auth, session-token or D1 row types.
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
    const credentialOperations = createCredentialOperations({ runtime, db: c.env.DB });
    const result = await credentialOperations.register(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 201);
  });

  router.openapi(loginRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) {
      return rejected;
    }
    const credentialOperations = createCredentialOperations({ runtime, db: c.env.DB });
    const result = await credentialOperations.login(c.req.valid('json'), c.req.raw.headers);
    if (result.kind === 'failure') return credentialProblem(c, result.failure);
    forwardSessionCookies(c, result.cookies);
    return c.json(result.value, 200);
  });

  router.openapi(verifyEmailRoute, async (c) => {
    const credentialOperations = createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
    });
    const result = await credentialOperations.verifyEmail(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
  });

  router.openapi(requestVerificationRoute, async (c) => {
    const credentialOperations = createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
    });
    const result = await credentialOperations.requestVerification(
      c.req.valid('json'),
      c.req.raw.headers,
    );
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 202);
  });

  router.openapi(requestPasswordResetRoute, async (c) => {
    const credentialOperations = createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
    });
    const result = await credentialOperations.requestPasswordReset(
      c.req.valid('json'),
      c.req.raw.headers,
    );
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 202);
  });

  router.openapi(checkPasswordResetRoute, async (c) => {
    const credentialOperations = createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
    });
    const result = await credentialOperations.checkPasswordReset(c.req.valid('json'));
    if (result.kind === 'failure') {
      return credentialProblem(c, result.failure, 'no-store');
    }
    return c.json(result.value, 200, { 'Cache-Control': 'no-store' });
  });

  router.openapi(resetPasswordRoute, async (c) => {
    const credentialOperations = createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
    });
    const result = await credentialOperations.resetPassword(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
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
    const credentialOperations = createCredentialOperations({
      runtime,
      db: c.env.DB,
    });
    const result = await credentialOperations.signOut(c.req.raw.headers);
    // Sign-out forwards clearing cookies even when the engine reports a
    // recoverable failure.
    forwardSessionCookies(c, result.cookies);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
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
    const result = await createReaderStateOperations(runtime).issue(
      c.req.raw.headers,
      c.get('requestId'),
    );
    if (result.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, noStore);
    }
    if (result.kind === 'unauthenticated') {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, noStore);
    }
    return c.json(result.value, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': noStore,
    });
  });

  // Consumer verification-key publication (spec #150, ADR-0013). Only public
  // asymmetric key material is ever projected here; private keys stay in D1
  // behind the engine encryption facility. Successful responses carry bounded
  // public caching; failures are never cached.
  router.openapi(consumerJwksRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const result = await createReaderStateOperations(runtime).publishJwks(c.req.raw.headers);
    if (result.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error', undefined, 'no-store');
    }
    return c.json(result.value, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': `public, max-age=${CONSUMER_JWKS_CACHE_MAX_AGE_SECONDS.toString()}`,
    });
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
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    const outcome = await reader.current();
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(adminUsersRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    const query = c.req.valid('query');
    const outcome = await reader.list({
      limit: query.limit,
      offset: query.offset,
      email: query.email,
    });
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(adminUserDetailRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveSessionContext(c.req.raw.headers, c.get('requestId'));
    if (session === null) {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.user.id,
      headers: c.req.raw.headers,
    });
    const params = c.req.valid('param');
    const outcome = await reader.get(params.userId);
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'not-found') {
      return problem(c, 404, 'not-found', 'Not Found', 'No such User.');
    }
    return c.json(outcome.value, 200);
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
