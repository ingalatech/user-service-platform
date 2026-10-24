import {
  readEffectiveEnvironment,
  resolveEffectiveConfig,
  type EffectiveConfig,
} from '../../config/index.js';
import type { Env } from '../../env.js';
import { createBootstrapIdentityAuth, createIdentityAuth, createReaderStateAuth } from './auth.js';
import type { IdentityAuthInput, ReaderStateOptions } from './auth.js';
import { resolveReaderStateConfig } from './reader-state.js';
import {
  evaluateCookieMutationOrigin,
  resolveConsumerOrigins,
  resolveGatewayOrigins,
} from './origin-guard.js';
import type { AuthMailer } from './mailer.js';
import { deferredAuthMailer, resolveAuthMailer } from './mailer.js';
import { resolveAuthPolicy } from './policy.js';
import type { AuthPolicy } from './policy.js';
import { resolveAuthSecret } from './secret.js';
import type { ResolveSessionInput, SessionContext, SessionResolvePhase } from './session.js';
import { toSessionContext } from './session.js';

// A tagged mode describes the behavior the caller needs; mail transport
// construction and execution-context scheduling remain implementation details.
type MailResolution = 'eager' | 'deferred';

export interface IdentityRuntimeInput {
  readonly env: Env;
  readonly requestUrl: string;
  readonly authMailer?: AuthMailer;
  readonly executionContext?: { waitUntil(task: Promise<unknown>): void };
  // Adapter kept for the established `resolveSessionContext` interface. HTTP
  // handlers provide the Worker execution context instead.
  readonly background?: (task: Promise<unknown>) => void;
}

interface ResolvedSettings {
  readonly effective: EffectiveConfig;
  readonly policy: AuthPolicy;
}

export interface IdentityRuntime {
  readonly authPolicy: AuthPolicy;
  authentication(): ReturnType<typeof createIdentityAuth>;
  administration(): ReturnType<typeof createIdentityAuth>;
  bootstrapAdministrator(userId: string): ReturnType<typeof createBootstrapIdentityAuth>;
  readerState(): ReturnType<typeof createReaderStateAuth>;
  cookieMutationAllowed(headers: Headers): boolean;
  resolveSessionContext(headers: Headers, requestId?: string): Promise<SessionContext | null>;
}

class RuntimeBuildFailure extends Error {
  constructor(
    readonly phase: SessionResolvePhase,
    readonly original: unknown,
    readonly environment?: string,
  ) {
    super('Identity runtime construction failed.');
    this.name = 'RuntimeBuildFailure';
  }
}

function asRuntimeBuildFailure(
  error: unknown,
  phase: SessionResolvePhase,
  environment?: string,
): RuntimeBuildFailure {
  return error instanceof RuntimeBuildFailure
    ? error
    : new RuntimeBuildFailure(phase, error, environment);
}

function buildFailureEnvironment(env: Env): string | undefined {
  try {
    return readEffectiveEnvironment(env);
  } catch {
    return typeof env.ENVIRONMENT === 'string' ? env.ENVIRONMENT : undefined;
  }
}

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

function requestOrigin(requestUrl: string): string {
  try {
    return new URL(requestUrl).origin;
  } catch {
    // Keep a malformed legacy session input on Better Auth's established
    // request/session failure path rather than adding an eager URL phase.
    return requestUrl;
  }
}

function createBackgroundScheduler(input: IdentityRuntimeInput): (task: Promise<unknown>) => void {
  if (input.background !== undefined) return input.background;
  return (task) => {
    try {
      input.executionContext?.waitUntil(task);
      if (input.executionContext !== undefined) return;
    } catch {
      // Bare unit calls have no Worker execution context; supervise below.
    }
    task.catch(() => {
      console.log(JSON.stringify({ level: 'error', event: 'auth-mail.failed' }));
    });
  };
}

// Request-scoped Identity runtime. One instance owns effective configuration,
// policy, secret, mail resolution, action URLs, request origin, scheduling and
// Better Auth construction. Its engine builders stay private to the Identity
// slice and preserve their inferred plugin-specific types.
export function createIdentityRuntime(input: IdentityRuntimeInput) {
  let settings: ResolvedSettings | undefined;
  const authInputs = new Map<MailResolution, IdentityAuthInput>();
  const authInstances = new Map<MailResolution, ReturnType<typeof createIdentityAuth>>();
  let readerStateInstance: ReturnType<typeof createReaderStateAuth> | undefined;
  const background = createBackgroundScheduler(input);

  function resolveSettings(): ResolvedSettings {
    if (settings !== undefined) return settings;
    try {
      const effective = resolveEffectiveConfig({
        environment: input.env.ENVIRONMENT,
        runtime: { ...input.env },
      });
      settings = { effective, policy: resolveAuthPolicy(effective.config) };
      return settings;
    } catch (error) {
      throw new RuntimeBuildFailure('config', error, buildFailureEnvironment(input.env));
    }
  }

  function resolveAuthInput(mailResolution: MailResolution): IdentityAuthInput {
    const cached = authInputs.get(mailResolution);
    if (cached !== undefined) return cached;
    const { effective, policy } = resolveSettings();
    let secret: string;
    try {
      secret = resolveAuthSecret({
        ENVIRONMENT: effective.config.ENVIRONMENT,
        BETTER_AUTH_SECRET: input.env.BETTER_AUTH_SECRET,
      });
    } catch (error) {
      throw new RuntimeBuildFailure('config', error, effective.environment);
    }

    const mailConfiguration = {
      ...effective.config,
      RESEND_API_KEY: input.env.RESEND_API_KEY,
      SMTP_USER: input.env.SMTP_USER,
      SMTP_PASSWORD: input.env.SMTP_PASSWORD,
    };
    let mailer: AuthMailer;
    try {
      mailer =
        mailResolution === 'deferred'
          ? deferredAuthMailer(mailConfiguration, input.authMailer)
          : resolveAuthMailer(mailConfiguration, input.authMailer);
    } catch (error) {
      throw new RuntimeBuildFailure('auth', error, effective.environment);
    }
    const authInput: IdentityAuthInput = {
      db: input.env.DB,
      policy,
      mailer,
      secret,
      baseURL: requestOrigin(input.requestUrl),
      verifyEmailActionURL: effective.config.AUTH_VERIFY_EMAIL_ACTION_URL,
      resetPasswordActionURL: effective.config.AUTH_RESET_PASSWORD_ACTION_URL,
      background,
    };
    authInputs.set(mailResolution, authInput);
    return authInput;
  }

  function auth(mailResolution: MailResolution): ReturnType<typeof createIdentityAuth> {
    const cached = authInstances.get(mailResolution);
    if (cached !== undefined) return cached;
    try {
      const instance = createIdentityAuth(resolveAuthInput(mailResolution));
      authInstances.set(mailResolution, instance);
      return instance;
    } catch (error) {
      const environment = settings?.effective.environment ?? buildFailureEnvironment(input.env);
      throw asRuntimeBuildFailure(error, 'auth', environment);
    }
  }

  function createBootstrapAuth(
    provisionalUserId: string,
  ): ReturnType<typeof createBootstrapIdentityAuth> {
    try {
      return createBootstrapIdentityAuth(resolveAuthInput('eager'), provisionalUserId);
    } catch (error) {
      const environment = settings?.effective.environment ?? buildFailureEnvironment(input.env);
      throw asRuntimeBuildFailure(error, 'auth', environment);
    }
  }

  function readerStateAuth(): ReturnType<typeof createReaderStateAuth> {
    if (readerStateInstance !== undefined) return readerStateInstance;
    // Reader State is presentation output from an authoritative session; it
    // never sends transactional mail, so an unrelated transport defect cannot
    // block issuance. Its own issuer/audience/TTL configuration still fails closed.
    const authInput = resolveAuthInput('deferred');
    const { effective } = resolveSettings();
    let readerState: ReaderStateOptions;
    try {
      readerState = resolveReaderStateConfig({
        environment: effective.environment,
        issuer: effective.config.AUTH_JWT_ISSUER,
        audience: effective.config.AUTH_READER_STATE_AUDIENCE,
        ttlSeconds: effective.config.AUTH_READER_STATE_TTL_SECONDS,
      });
    } catch (error) {
      throw new RuntimeBuildFailure('config', error, effective.environment);
    }
    try {
      readerStateInstance = createReaderStateAuth({
        ...authInput,
        readerState,
      });
      return readerStateInstance;
    } catch (error) {
      throw asRuntimeBuildFailure(error, 'auth', effective.environment);
    }
  }

  async function resolveSessionContext(
    headers: Headers,
    requestId?: string,
  ): Promise<SessionContext | null> {
    let sessionAuth: ReturnType<typeof createIdentityAuth>;
    try {
      sessionAuth = auth('deferred');
    } catch (error) {
      const failure = asRuntimeBuildFailure(
        error,
        'auth',
        settings?.effective.environment ?? buildFailureEnvironment(input.env),
      );
      logSessionResolveFailure({
        phase: failure.phase,
        requestId,
        environment: failure.environment,
      });
      throw failure.original;
    }

    let engineSession: unknown;
    try {
      // Bypass the signed cookie cache so revoked sessions cannot authorize
      // through cached payload; the Better Auth/D1 store remains authoritative.
      engineSession = await sessionAuth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
    } catch (error) {
      logSessionResolveFailure({
        phase: 'session',
        requestId,
        environment: settings?.effective.environment,
      });
      throw error;
    }
    return engineSession === null ? null : toSessionContext(engineSession);
  }

  function cookieMutationAllowed(headers: Headers): boolean {
    const { effective } = resolveSettings();
    const allowedGatewayOrigins = resolveGatewayOrigins(effective.config.AUTH_GATEWAY_ORIGINS);
    const allowedConsumerOrigins = resolveConsumerOrigins(effective.config.AUTH_CONSUMER_ORIGINS);
    return evaluateCookieMutationOrigin({
      requestOrigin: requestOrigin(input.requestUrl),
      origin: headers.get('origin'),
      secFetchSite: headers.get('sec-fetch-site'),
      gatewayOrigins: allowedGatewayOrigins,
      consumerOrigins: allowedConsumerOrigins,
    });
  }

  const runtime: IdentityRuntime = {
    get authPolicy() {
      return resolveSettings().policy;
    },
    authentication: () => auth('eager'),
    administration: () => auth('deferred'),
    bootstrapAdministrator: createBootstrapAuth,
    readerState: readerStateAuth,
    cookieMutationAllowed,
    resolveSessionContext,
  };
  return runtime;
}

// Preserve the existing Identity-slice interface for non-router consumers;
// request handlers share one runtime instance directly to avoid reassembly.
export async function resolveSessionContext(
  input: ResolveSessionInput,
): Promise<SessionContext | null> {
  const runtime = createIdentityRuntime({
    env: input.env,
    requestUrl: input.baseURL,
    authMailer: input.authMailer,
    background: input.background,
  });
  return runtime.resolveSessionContext(input.headers, input.requestId);
}
