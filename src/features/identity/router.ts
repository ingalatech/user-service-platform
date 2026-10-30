import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Env } from '../../env.js';
import { PROBLEM_JSON, createProblem, type ProblemCode } from '../../shared/problem.js';
import { createAdminUserReader } from './admin-users.js';
import { createAdminAccountDetailsOperations } from './admin-account-details.js';
import { readAdminReaderActivity } from './admin-reader-activity.js';
import { createAccountDetailsOperations } from './account-details-operations.js';
import type { AccountDetailsUpdateOutcome } from './account-details-operations.js';
import { createAccountPhotoOperations } from './account-photo-operations.js';
import type {
  AccountPhotoLockTiming,
  AccountPhotoReferenceWriter,
} from './account-photo-operations.js';
import {
  bootstrapAdminUser,
  type BootstrapAdminOutcome,
  type BootstrapCreateUser,
  type BootstrapDeleteUser,
  type BootstrapSetRole,
} from './admin.js';
import { createCredentialOperations, type CredentialFailure } from './credential-operations.js';
import {
  ACCOUNT_PHOTO_CORS_ALLOWED_METHODS,
  CONSUMER_CORS_PATHS,
  createConsumerCorsMiddleware,
} from './consumer-cors.js';
import { createReaderStateOperations } from './reader-state-operations.js';
import type { AuthMailer } from './mailer.js';
import type { AdminBootstrapRequest } from './contract.js';
import { createIdentityRuntime } from './identity-runtime.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { createPasswordPolicyProblemDetails } from './problem.js';
import {
  adminBootstrapRoute,
  adminBootstrapLegacyRoute,
  adminCheckPasswordResetRoute,
  adminLoginRoute,
  accountDetailsRoute,
  uploadAccountPhotoRoute,
  getAccountPhotoRoute,
  deleteAccountPhotoRoute,
  adminMeRoute,
  adminRequestPasswordResetRoute,
  adminRequestVerificationRoute,
  adminResetPasswordRoute,
  adminSignOutRoute,
  adminUserDetailRoute,
  adminReaderActivityRoute,
  adminUserAccountDetailsRoute,
  adminUsersRoute,
  adminVerifyEmailRoute,
  authConfigRoute,
  checkPasswordResetRoute,
  consumerJwksRoute,
  readerStateRoute,
  currentUserRoute,
  loginRoute,
  registerRoute,
  registerWithoutNameRoute,
  requestPasswordResetRoute,
  requestVerificationRoute,
  resetPasswordRoute,
  signOutRoute,
  updateAccountDetailsRoute,
  updateAdminUserAccountDetailsRoute,
  verifyEmailRoute,
} from './route.js';

export interface IdentityRouterOptions {
  // Test seam: an explicitly provided mailer (in-memory in tests) takes
  // precedence over environment resolution.
  readonly authMailer?: AuthMailer;
  // Identity-engine seam for proving post-commit response failures on Account
  // Photo reference writes. Production uses Better Auth directly.
  readonly accountPhotoReferenceWriter?: AccountPhotoReferenceWriter;
  readonly accountDetailsImageUpdater?: (
    update: () => Promise<AccountDetailsUpdateOutcome>,
  ) => Promise<AccountDetailsUpdateOutcome>;
  // Short-lease/heartbeat seam for Worker tests that hold an upload longer
  // than one lease period. Production uses the default long lease and renewal.
  readonly accountPhotoLockTiming?: AccountPhotoLockTiming;
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

function problem<const TStatus extends 400 | 401 | 403 | 404 | 409 | 413 | 500 | 503>(
  c: IdentityContext,
  status: TStatus,
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

// An Administrator endpoint never resolves a Reader cookie. It reports the
// explicitly foreign realm as forbidden for the SPA's denied-session UX while
// keeping anonymous and invalid Administrator credentials unauthenticated.
function administratorSessionProblem(c: IdentityContext) {
  const cookie = c.req.header('cookie') ?? '';
  return /(?:^|;\s*)(?:__Secure-)?rch-reader\.session_token=/.test(cookie)
    ? problem(c, 403, 'forbidden', 'Forbidden', 'Reader sessions cannot access Administration.')
    : problem(c, 401, 'unauthenticated', 'Unauthenticated');
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
      return c.json(createPasswordPolicyProblemDetails(failure, new URL(c.req.url).pathname), 400, {
        'Content-Type': PROBLEM_JSON,
        'Cache-Control': 'no-store',
      });
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

type AdministratorBootstrapOutcome =
  | BootstrapAdminOutcome
  | { readonly status: 'credential-failure'; readonly failure: CredentialFailure };

async function runAdministratorBootstrap(input: {
  readonly c: IdentityContext;
  readonly runtime: IdentityRuntime;
  readonly options: IdentityRouterOptions;
  readonly request: AdminBootstrapRequest;
}): Promise<AdministratorBootstrapOutcome> {
  const credentials = createCredentialOperations({
    runtime: input.runtime,
    db: input.c.env.DB,
    realm: 'administrator',
  });
  const validation = credentials.validateBootstrapPassword(input.request.password);
  if (validation.kind === 'failure') {
    return { status: 'credential-failure', failure: validation.failure };
  }
  return bootstrapAdminUser({
    auth: input.runtime.administration(),
    createBootstrapAuth: (userId) => input.runtime.bootstrapAdministrator(userId),
    db: input.c.env.DB,
    name: input.request.name,
    email: input.request.email,
    password: input.request.password,
    ...(input.options.now === undefined ? {} : { now: input.options.now }),
    ...(input.options.bootstrapLeaseTtlMs === undefined
      ? {}
      : { leaseTtlMs: input.options.bootstrapLeaseTtlMs }),
    ...(input.options.bootstrapCreateUser === undefined
      ? {}
      : { createUser: input.options.bootstrapCreateUser }),
    ...(input.options.bootstrapSetRole === undefined
      ? {}
      : { setRole: input.options.bootstrapSetRole }),
    ...(input.options.bootstrapDeleteUser === undefined
      ? {}
      : { deleteUser: input.options.bootstrapDeleteUser }),
  });
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

  const privateAdminReaderResponse = async (c: IdentityContext, next: () => Promise<void>) => {
    await next();
    c.res.headers.set('Cache-Control', 'private, no-store');
  };
  router.use('/admin/users', privateAdminReaderResponse);
  router.use('/admin/users/*', privateAdminReaderResponse);

  // Direct-browser consumer transport (spec #164, ADR-0013): credentialed
  // CORS is applied to the public consumer identity operations only. It is a
  // browser permission boundary; mutation authorization stays with
  // `guardCookieMutation`. Administrative routes are deliberately excluded.
  const consumerCors = createConsumerCorsMiddleware();
  const accountPhotoCors = createConsumerCorsMiddleware(ACCOUNT_PHOTO_CORS_ALLOWED_METHODS);
  for (const path of CONSUMER_CORS_PATHS) {
    router.use(
      path,
      path === '/account-photo' || path === '/account-photo/*' ? accountPhotoCors : consumerCors,
    );
  }

  router.openapi(accountDetailsRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const result = await createAccountDetailsOperations(runtime).read(c.req.raw.headers);
    if (result.kind === 'unauthenticated') {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    if (result.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    if (result.value.image?.startsWith('/v1/account-photo/')) {
      const availability = await createAccountPhotoOperations({
        runtime,
        db: c.env.DB,
        files: c.env.FILES,
        background: (task) => {
          c.executionCtx.waitUntil(task);
        },
      }).availability(c.req.raw.headers, result.value.image);
      if (availability === 'unauthenticated') {
        return problem(
          c,
          401,
          'unauthenticated',
          'Unauthenticated',
          undefined,
          'private, no-store',
        );
      }
      if (availability === 'service-unavailable') {
        return problem(
          c,
          503,
          'service-unavailable',
          'Service Unavailable',
          undefined,
          'private, no-store',
        );
      }
      if (availability === 'missing') return c.json({ ...result.value, image: null }, 200);
    }
    return c.json(result.value, 200);
  });

  router.openapi(updateAccountDetailsRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime, 'private, no-store');
    if (rejected !== null) return rejected;
    const patch = c.req.valid('json');
    const accountDetails = createAccountDetailsOperations(runtime);
    const updateDetails = () => accountDetails.update(c.req.raw.headers, patch);
    const result =
      patch.image === undefined
        ? await updateDetails()
        : await createAccountPhotoOperations({
            runtime,
            db: c.env.DB,
            files: c.env.FILES,
            ...(options.accountPhotoLockTiming === undefined
              ? {}
              : { lockTiming: options.accountPhotoLockTiming }),
            background: (task) => {
              c.executionCtx.waitUntil(task);
            },
          }).updateAccountDetailsImage(
            c.req.raw.headers,
            patch.image,
            () =>
              options.accountDetailsImageUpdater === undefined
                ? updateDetails()
                : options.accountDetailsImageUpdater(updateDetails),
            undefined,
            () => Promise.resolve({ kind: 'success', cookies: [] }),
          );
    if (result.kind === 'unauthenticated') {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated');
    }
    if (result.kind === 'bad-request') return problem(c, 400, 'bad-request', 'Bad Request');
    if (result.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    if (result.kind === 'conflict') return problem(c, 409, 'conflict', 'Conflict');
    if (result.kind === 'service-unavailable') {
      return problem(c, 503, 'service-unavailable', 'Service Unavailable');
    }
    if ('cookies' in result) {
      forwardSessionCookies(c, result.cookies);
      return c.body(null, 204);
    }
    return problem(c, 500, 'internal-error', 'Internal Server Error');
  });

  router.openapi(uploadAccountPhotoRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime, 'private, no-store');
    if (rejected !== null) return rejected;
    const result = await createAccountPhotoOperations({
      runtime,
      db: c.env.DB,
      files: c.env.FILES,
      ...(options.accountPhotoLockTiming === undefined
        ? {}
        : { lockTiming: options.accountPhotoLockTiming }),
      ...(options.accountPhotoReferenceWriter === undefined
        ? {}
        : { referenceWriter: options.accountPhotoReferenceWriter }),
      background: (task) => {
        c.executionCtx.waitUntil(task);
      },
    }).upload(
      c.req.raw.headers,
      c.req.raw.body,
      c.req.header('content-type'),
      c.req.header('content-length'),
    );
    if (result.kind === 'unauthenticated') {
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, 'private, no-store');
    }
    if (result.kind === 'bad-request')
      return problem(c, 400, 'bad-request', 'Bad Request', undefined, 'private, no-store');
    if (result.kind === 'payload-too-large')
      return problem(
        c,
        413,
        'payload-too-large',
        'Payload Too Large',
        undefined,
        'private, no-store',
      );
    if (result.kind === 'conflict')
      return problem(c, 409, 'conflict', 'Conflict', undefined, 'private, no-store');
    if (result.kind === 'service-unavailable')
      return problem(
        c,
        503,
        'service-unavailable',
        'Service Unavailable',
        undefined,
        'private, no-store',
      );
    if (result.kind === 'internal-error')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    if (result.kind !== 'success')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    forwardSessionCookies(c, result.cookies);
    return c.body(null, 204);
  });

  router.openapi(getAccountPhotoRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const result = await createAccountPhotoOperations({
      runtime,
      db: c.env.DB,
      files: c.env.FILES,
      background: (task) => {
        c.executionCtx.waitUntil(task);
      },
    }).read(c.req.raw.headers, c.req.valid('param').photoId);
    if (result.kind === 'unauthenticated')
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, 'private, no-store');
    if (result.kind === 'not-found')
      return problem(c, 404, 'not-found', 'Not Found', undefined, 'private, no-store');
    if (result.kind === 'service-unavailable')
      return problem(
        c,
        503,
        'service-unavailable',
        'Service Unavailable',
        undefined,
        'private, no-store',
      );
    if (result.kind === 'internal-error')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    if (result.kind !== 'success')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    return new Response(result.body, {
      status: 200,
      headers: {
        'Content-Type': result.contentType,
        'Content-Length': String(result.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  router.openapi(deleteAccountPhotoRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime, 'private, no-store');
    if (rejected !== null) return rejected;
    const result = await createAccountPhotoOperations({
      runtime,
      db: c.env.DB,
      files: c.env.FILES,
      ...(options.accountPhotoLockTiming === undefined
        ? {}
        : { lockTiming: options.accountPhotoLockTiming }),
      ...(options.accountPhotoReferenceWriter === undefined
        ? {}
        : { referenceWriter: options.accountPhotoReferenceWriter }),
      background: (task) => {
        c.executionCtx.waitUntil(task);
      },
    }).remove(c.req.raw.headers);
    if (result.kind === 'unauthenticated')
      return problem(c, 401, 'unauthenticated', 'Unauthenticated', undefined, 'private, no-store');
    if (result.kind === 'conflict')
      return problem(c, 409, 'conflict', 'Conflict', undefined, 'private, no-store');
    if (result.kind === 'service-unavailable')
      return problem(
        c,
        503,
        'service-unavailable',
        'Service Unavailable',
        undefined,
        'private, no-store',
      );
    if (result.kind === 'internal-error')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    if (result.kind !== 'success')
      return problem(
        c,
        500,
        'internal-error',
        'Internal Server Error',
        undefined,
        'private, no-store',
      );
    forwardSessionCookies(c, result.cookies);
    return c.body(null, 204);
  });

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
    const session = await runtime.resolveAdministratorSessionContext(
      c.req.raw.headers,
      c.get('requestId'),
    );
    if (session === null) {
      return administratorSessionProblem(c);
    }
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.administrator.id,
      headers: c.req.raw.headers,
    });
    const outcome = await reader.current();
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(adminLoginRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) return rejected;
    const result = await createCredentialOperations({
      runtime,
      db: c.env.DB,
      realm: 'administrator',
    }).login(c.req.valid('json'), c.req.raw.headers);
    if (result.kind === 'failure') return credentialProblem(c, result.failure);
    forwardSessionCookies(c, result.cookies);
    return c.json(result.value, 200);
  });

  router.openapi(adminSignOutRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) return rejected;
    const result = await createCredentialOperations({
      runtime,
      db: c.env.DB,
      realm: 'administrator',
    }).signOut(c.req.raw.headers);
    forwardSessionCookies(c, result.cookies);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
  });

  router.openapi(adminVerifyEmailRoute, async (c) => {
    const result = await createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
      realm: 'administrator',
    }).verifyEmail(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
  });

  router.openapi(adminRequestVerificationRoute, async (c) => {
    const result = await createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
      realm: 'administrator',
    }).requestVerification(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 202);
  });

  router.openapi(adminRequestPasswordResetRoute, async (c) => {
    const result = await createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
      realm: 'administrator',
    }).requestPasswordReset(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 202);
  });

  router.openapi(adminCheckPasswordResetRoute, async (c) => {
    const result = await createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
      realm: 'administrator',
    }).checkPasswordReset(c.req.valid('json'));
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure, 'no-store')
      : c.json(result.value, 200, { 'Cache-Control': 'no-store' });
  });

  router.openapi(adminResetPasswordRoute, async (c) => {
    const result = await createCredentialOperations({
      runtime: requestIdentityRuntime(c, override),
      db: c.env.DB,
      realm: 'administrator',
    }).resetPassword(c.req.valid('json'), c.req.raw.headers);
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 200);
  });

  router.openapi(adminUsersRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveAdministratorSessionContext(
      c.req.raw.headers,
      c.get('requestId'),
    );
    if (session === null) {
      return administratorSessionProblem(c);
    }
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.administrator.id,
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
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(adminUserDetailRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveAdministratorSessionContext(
      c.req.raw.headers,
      c.get('requestId'),
    );
    if (session === null) {
      return administratorSessionProblem(c);
    }
    const reader = createAdminUserReader({
      auth: runtime.administration(),
      db: c.env.DB,
      userId: session.administrator.id,
      headers: c.req.raw.headers,
    });
    const params = c.req.valid('param');
    const outcome = await reader.get(params.userId);
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    if (outcome.kind === 'not-found') {
      return problem(c, 404, 'reader-not-found', 'Reader not found');
    }
    c.header('ETag', `"${String(outcome.value.revision)}"`);
    return c.json(outcome.value, 200);
  });

  router.openapi(adminReaderActivityRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const session = await runtime.resolveAdministratorSessionContext(
      c.req.raw.headers,
      c.get('requestId'),
    );
    if (session === null) return administratorSessionProblem(c);
    const params = c.req.valid('param');
    const query = c.req.valid('query');
    const outcome = await readAdminReaderActivity({
      auth: runtime.administration(),
      db: c.env.DB,
      administratorId: session.administrator.id,
      headers: c.req.raw.headers,
      readerId: params.userId,
      limit: query.limit,
      cursor: query.cursor,
    });
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    if (outcome.kind === 'reader-not-found') {
      return problem(c, 404, 'reader-not-found', 'Reader not found');
    }
    if (outcome.kind === 'bad-cursor') return problem(c, 400, 'bad-request', 'Bad Request');
    return c.json(outcome.value, 200);
  });

  router.openapi(adminUserAccountDetailsRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const params = c.req.valid('param');
    const outcome = await createAdminAccountDetailsOperations({ runtime, db: c.env.DB }).get(
      params.userId,
      c.req.raw.headers,
    );
    if (outcome.kind === 'unauthenticated') {
      return administratorSessionProblem(c);
    }
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    if (outcome.kind === 'not-found') {
      return problem(c, 404, 'not-found', 'Not Found', 'No such User.');
    }
    if (outcome.kind === 'bad-request') return problem(c, 400, 'bad-request', 'Bad Request');
    if (outcome.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    if (!('value' in outcome)) {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(updateAdminUserAccountDetailsRoute, async (c) => {
    c.header('Cache-Control', 'private, no-store');
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime, 'private, no-store');
    if (rejected !== null) return rejected;
    const params = c.req.valid('param');
    const adminDetails = createAdminAccountDetailsOperations({ runtime, db: c.env.DB });
    const patch = c.req.valid('json');
    const outcome = await adminDetails.update(params.userId, c.req.raw.headers, patch);
    if (outcome.kind === 'unauthenticated') {
      return administratorSessionProblem(c);
    }
    if (outcome.kind === 'forbidden') {
      return problem(c, 403, 'forbidden', 'Forbidden', 'Administrator access is required.');
    }
    if (outcome.kind === 'administrator-disabled') {
      return problem(c, 403, 'administrator-disabled', 'Administrator disabled');
    }
    if (outcome.kind === 'not-found') {
      return problem(c, 404, 'not-found', 'Not Found', 'No such User.');
    }
    if (outcome.kind === 'bad-request') return problem(c, 400, 'bad-request', 'Bad Request');
    if (outcome.kind === 'internal-error') {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    if (!('value' in outcome)) {
      return problem(c, 500, 'internal-error', 'Internal Server Error');
    }
    return c.json(outcome.value, 200);
  });

  router.openapi(adminBootstrapRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) return rejected;
    const outcome = await runAdministratorBootstrap({
      c,
      runtime,
      options,
      request: c.req.valid('json'),
    });
    if (outcome.status === 'credential-failure') return credentialProblem(c, outcome.failure);
    if (outcome.status === 'created') return c.json(outcome.admin, 201);
    if (outcome.status === 'already-bootstrapped') {
      return problem(c, 409, 'admin-already-bootstrapped', 'Administrator already bootstrapped');
    }
    if (outcome.status === 'in-progress') {
      return problem(c, 409, 'admin-bootstrap-in-progress', 'Administrator bootstrap in progress');
    }
    return problem(c, 409, 'admin-email-conflict', 'Administrator email conflict');
  });

  router.openapi(adminBootstrapLegacyRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) return rejected;
    const outcome = await runAdministratorBootstrap({
      c,
      runtime,
      options,
      request: c.req.valid('json'),
    });
    if (outcome.status === 'credential-failure') return credentialProblem(c, outcome.failure);
    if (outcome.status === 'created') return c.json(outcome.admin, 201);
    if (outcome.status === 'already-bootstrapped') {
      return problem(c, 409, 'admin-already-bootstrapped', 'Administrator already bootstrapped');
    }
    if (outcome.status === 'in-progress') {
      return problem(c, 409, 'admin-bootstrap-in-progress', 'Administrator bootstrap in progress');
    }
    return problem(c, 409, 'admin-email-conflict', 'Administrator email conflict');
  });

  return router;
}

// Explicit V2 registration transition. Only this no-public-name operation is
// mounted under `/v2`; all accepted Identity operations retain their `/v1`
// contracts and are not duplicated into a generic versioned API router.
export function createIdentityV2Router(options: IdentityRouterOptions = {}) {
  const router = new OpenAPIHono<{ Bindings: Env; Variables: { requestId: string } }>();
  const override = options.authMailer;
  router.use('/auth/register', createConsumerCorsMiddleware());

  router.openapi(registerWithoutNameRoute, async (c) => {
    const runtime = requestIdentityRuntime(c, override);
    const rejected = guardCookieMutation(c, runtime);
    if (rejected !== null) return rejected;
    const credentialOperations = createCredentialOperations({ runtime, db: c.env.DB });
    const result = await credentialOperations.registerWithoutName(
      c.req.valid('json'),
      c.req.raw.headers,
    );
    return result.kind === 'failure'
      ? credentialProblem(c, result.failure)
      : c.json(result.value, 201);
  });

  return router;
}
