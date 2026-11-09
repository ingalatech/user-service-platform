import {
  readEffectiveEnvironment,
  resolveEffectiveConfig,
  type EffectiveConfig,
} from '../../config/index.js';
import type { Env } from '../../env.js';
import {
  createAdministrationAuth,
  createBootstrapIdentityAuth,
  createIdentityAuth,
  createReaderStateAuth,
  createReaderEmailChangeToken,
  readReaderEmailChangeToken as readEmailChangeTokenClaims,
} from './auth.js';
import type {
  IdentityAuthInput,
  ReaderEmailChangeTokenClaims,
  ReaderStateOptions,
} from './auth.js';
import { resolveReaderStateConfig } from './reader-state.js';
import {
  evaluateCookieMutationOrigin,
  resolveConsumerOrigins,
  resolveGatewayOrigins,
} from './origin-guard.js';
import type { AuthMailer, AuthMailTask, SocialIdentityUnlinkNoticeMessage } from './mailer.js';
import { deferredAuthMailer, resolveAuthMailer } from './mailer.js';
import { resolveAuthPolicy } from './policy.js';
import type { AuthPolicy } from './policy.js';
import { resolveAuthSecret } from './secret.js';
import { VERIFY_EMAIL_ACTION_PATH, buildAuthActionUrl } from './action-urls.js';
import type {
  AdministratorSessionContext,
  ResolveSessionInput,
  SessionContext,
  SessionResolvePhase,
} from './session.js';
import { toAdministratorSessionContext, toSessionContext } from './session.js';
import { base64url } from 'jose';
import { z } from 'zod';
import { digestVerificationToken } from './verification-token.js';

interface PreparedReaderEmailChangeMessages {
  readonly tokenDigest: string;
  readonly expiresAt: number;
  readonly retryPayload: string;
}

type SealedAuthMailTasks =
  | AuthMailTask
  | {
      readonly kind: 'reader-email-change-workflow';
      readonly messages: [AuthMailTask, AuthMailTask];
    };

// A tagged mode describes the behavior the caller needs; mail transport
// construction and execution-context scheduling remain implementation details.
type MailResolution = 'eager' | 'deferred' | 'synchronous';

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
  administration(): ReturnType<typeof createAdministrationAuth>;
  readerMessaging(): ReturnType<typeof createIdentityAuth>;
  administratorMessaging(): ReturnType<typeof createAdministrationAuth>;
  sealPreparedReaderMessage(): Promise<string | null>;
  sealPreparedAdministratorMessage(): Promise<string | null>;
  retryReaderMessageScheduling(
    payload: string,
  ): Promise<'accepted' | 'rejected' | 'invalid-envelope'>;
  retryAdministratorMessageScheduling(
    payload: string,
  ): Promise<'accepted' | 'rejected' | 'invalid-envelope'>;
  prepareReaderEmailChangeMessages(input: {
    readonly currentEmail: string;
    readonly newEmail: string;
    readonly workflowId: string;
  }): Promise<PreparedReaderEmailChangeMessages | null>;
  readReaderEmailChangeToken(token: string): Promise<ReaderEmailChangeTokenClaims | null>;
  retryReaderEmailChangeScheduling(
    payload: string,
  ): Promise<'accepted' | 'rejected' | 'invalid-envelope'>;
  sealSocialIdentityUnlinkNotice(
    message: SocialIdentityUnlinkNoticeMessage,
  ): Promise<string | null>;
  bootstrapAdministrator(userId: string): ReturnType<typeof createBootstrapIdentityAuth>;
  readerState(): ReturnType<typeof createReaderStateAuth>;
  cookieMutationAllowed(headers: Headers): boolean;
  resolveSessionContext(headers: Headers, requestId?: string): Promise<SessionContext | null>;
  resolveAdministratorSessionContext(
    headers: Headers,
    requestId?: string,
  ): Promise<AdministratorSessionContext | null>;
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

const singleAuthMailTaskSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('email-verification'),
    message: z.object({ to: z.string(), url: z.string(), token: z.string() }),
  }),
  z.object({
    kind: z.literal('password-recovery'),
    message: z.object({ to: z.string(), url: z.string(), token: z.string() }),
  }),
  z.object({
    kind: z.literal('email-change-notice'),
    message: z.object({ to: z.string(), previousEmail: z.string(), newEmail: z.string() }),
  }),
  z.object({
    kind: z.literal('social-identity-unlink-notice'),
    message: z.object({ to: z.string(), providerDisplayName: z.enum(['Google', 'Facebook']) }),
  }),
]);

const sealedAuthMailTaskSchema = z.union([
  singleAuthMailTaskSchema,
  z.object({
    kind: z.literal('reader-email-change-workflow'),
    messages: z.tuple([singleAuthMailTaskSchema, singleAuthMailTaskSchema]),
  }),
]);

async function authMailEncryptionKey(secret: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealAuthMailTask(task: SealedAuthMailTasks, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(task));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    await authMailEncryptionKey(secret),
    plaintext,
  );
  return `v1.${base64url.encode(iv)}.${base64url.encode(new Uint8Array(ciphertext))}`;
}

async function openAuthMailTask(payload: string, secret: string): Promise<SealedAuthMailTasks> {
  const [version, encodedIv, encodedCiphertext, extra] = payload.split('.');
  if (version !== 'v1' || encodedIv === undefined || encodedCiphertext === undefined || extra) {
    throw new Error('Invalid sealed auth mail task.');
  }
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64url.decode(encodedIv) },
    await authMailEncryptionKey(secret),
    base64url.decode(encodedCiphertext),
  );
  const parsed: unknown = JSON.parse(new TextDecoder().decode(plaintext));
  return sealedAuthMailTaskSchema.parse(parsed);
}

function createAcceptedScheduler(input: IdentityRuntimeInput) {
  return (mailer: AuthMailer, envelope: SealedAuthMailTasks): Promise<void> => {
    let resolveTask!: () => void;
    let rejectTask!: (reason: unknown) => void;
    const deferred = new Promise<void>((resolve, reject) => {
      resolveTask = resolve;
      rejectTask = reject;
    });
    deferred.catch(() => {
      console.log(JSON.stringify({ level: 'error', event: 'auth-mail.failed' }));
    });
    try {
      if (input.background !== undefined) input.background(deferred);
      else if (input.executionContext !== undefined) input.executionContext.waitUntil(deferred);
    } catch (error) {
      resolveTask();
      throw error;
    }
    try {
      const tasks =
        envelope.kind === 'reader-email-change-workflow' ? envelope.messages : [envelope];
      const deliveries = tasks.map((task) => {
        if (task.kind === 'email-verification') return mailer.sendVerificationEmail(task.message);
        if (task.kind === 'password-recovery') return mailer.sendPasswordResetEmail(task.message);
        if (task.kind === 'social-identity-unlink-notice')
          return mailer.sendSocialIdentityUnlinkNotice(task.message);
        return mailer.sendEmailChangeNotice(task.message);
      });
      Promise.all(deliveries).then(() => {
        resolveTask();
      }, rejectTask);
    } catch (error) {
      rejectTask(error);
    }
    return Promise.resolve();
  };
}

// Request-scoped Identity runtime. One instance owns effective configuration,
// policy, secret, mail resolution, action URLs, request origin, scheduling and
// Better Auth construction. Its engine builders stay private to the Identity
// slice and preserve their inferred plugin-specific types.
export function createIdentityRuntime(input: IdentityRuntimeInput) {
  let settings: ResolvedSettings | undefined;
  const authInputs = new Map<string, IdentityAuthInput>();
  const readerAuthInstances = new Map<MailResolution, ReturnType<typeof createIdentityAuth>>();
  const adminAuthInstances = new Map<MailResolution, ReturnType<typeof createAdministrationAuth>>();
  let readerStateInstance: ReturnType<typeof createReaderStateAuth> | undefined;
  let resolvedAuthSecret: string | undefined;
  const preparedAuthMailTasks = new Map<'reader' | 'administrator', AuthMailTask>();
  const background = createBackgroundScheduler(input);
  const acceptedScheduler = createAcceptedScheduler(input);

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

  function resolveAuthInput(
    realm: 'reader' | 'administrator',
    mailResolution: MailResolution,
  ): IdentityAuthInput {
    const key = `${realm}:${mailResolution}`;
    const cached = authInputs.get(key);
    if (cached !== undefined) return cached;
    const { effective, policy } = resolveSettings();
    let secret: string;
    try {
      secret = resolveAuthSecret({
        ENVIRONMENT: effective.config.ENVIRONMENT,
        BETTER_AUTH_SECRET: input.env.BETTER_AUTH_SECRET,
      });
      resolvedAuthSecret = secret;
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
      // Synchronous post-commit scheduling must expose enqueue failure to the
      // command instead of handing the task to waitUntil, whose scheduler
      // errors are deliberately swallowed for background work.
      ...(mailResolution === 'synchronous'
        ? {
            schedule: (task: AuthMailTask): Promise<void> => {
              preparedAuthMailTasks.set(realm, task);
              return Promise.resolve();
            },
          }
        : {}),
      realm,
    };
    authInputs.set(key, authInput);
    return authInput;
  }

  function readerAuth(mailResolution: MailResolution): ReturnType<typeof createIdentityAuth> {
    const cached = readerAuthInstances.get(mailResolution);
    if (cached !== undefined) return cached;
    try {
      const instance = createIdentityAuth(resolveAuthInput('reader', mailResolution));
      readerAuthInstances.set(mailResolution, instance);
      return instance;
    } catch (error) {
      const environment = settings?.effective.environment ?? buildFailureEnvironment(input.env);
      throw asRuntimeBuildFailure(error, 'auth', environment);
    }
  }

  function adminAuth(mailResolution: MailResolution): ReturnType<typeof createAdministrationAuth> {
    const cached = adminAuthInstances.get(mailResolution);
    if (cached !== undefined) return cached;
    try {
      const instance = createAdministrationAuth(resolveAuthInput('administrator', mailResolution));
      adminAuthInstances.set(mailResolution, instance);
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
      return createBootstrapIdentityAuth(
        resolveAuthInput('administrator', 'eager'),
        provisionalUserId,
      );
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
    const authInput = resolveAuthInput('reader', 'deferred');
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
      sessionAuth = readerAuth('deferred');
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
    if (engineSession === null) return null;
    const session = toSessionContext(engineSession);
    if (session === null) return null;
    try {
      const reader = await input.env.DB.prepare(
        `SELECT u.role, ras.state AS access_state,
                  EXISTS (
                    SELECT 1 FROM reader_deletion_request AS deletion
                    WHERE deletion.user_id = u.id
                      AND deletion.state IN ('pending_review', 'approved')
                  ) AS deletion_active
           FROM user AS u
           LEFT JOIN reader_access_state AS ras ON ras.user_id = u.id
           WHERE u.id = ? LIMIT 1`,
      )
        .bind(session.user.id)
        .first<{ role: string | null; access_state: string | null; deletion_active: number }>();
      return reader !== null &&
        reader.role !== 'admin' &&
        reader.access_state !== 'disabled' &&
        reader.deletion_active === 0
        ? session
        : null;
    } catch (error) {
      logSessionResolveFailure({
        phase: 'session',
        requestId,
        environment: settings?.effective.environment,
      });
      throw error;
    }
  }

  async function resolveAdministratorSessionContext(
    headers: Headers,
    requestId?: string,
  ): Promise<AdministratorSessionContext | null> {
    let sessionAuth: ReturnType<typeof createAdministrationAuth>;
    try {
      sessionAuth = adminAuth('deferred');
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
    const engineSession: unknown = await sessionAuth.api.getSession({
      headers,
      query: { disableCookieCache: true },
    });
    return engineSession === null ? null : toAdministratorSessionContext(engineSession);
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

  async function sealPreparedMessage(realm: 'reader' | 'administrator'): Promise<string | null> {
    const task = preparedAuthMailTasks.get(realm);
    if (task === undefined || resolvedAuthSecret === undefined) return null;
    return sealAuthMailTask(task, resolvedAuthSecret);
  }

  async function sealSocialIdentityUnlinkNotice(
    message: SocialIdentityUnlinkNoticeMessage,
  ): Promise<string | null> {
    try {
      const authInput = resolveAuthInput('reader', 'synchronous');
      return await sealAuthMailTask(
        { kind: 'social-identity-unlink-notice', message },
        authInput.secret,
      );
    } catch {
      return null;
    }
  }

  async function retryMessageScheduling(
    realm: 'reader' | 'administrator',
    payload: string,
  ): Promise<'accepted' | 'rejected' | 'invalid-envelope'> {
    const authInput = resolveAuthInput(realm, 'synchronous');
    let task: SealedAuthMailTasks;
    try {
      task = await openAuthMailTask(payload, authInput.secret);
    } catch {
      return 'invalid-envelope';
    }
    try {
      await acceptedScheduler(authInput.mailer, task);
      return 'accepted';
    } catch {
      return 'rejected';
    }
  }

  async function prepareReaderEmailChangeMessages(input: {
    readonly currentEmail: string;
    readonly newEmail: string;
    readonly workflowId: string;
  }): Promise<PreparedReaderEmailChangeMessages | null> {
    try {
      const authInput = resolveAuthInput('reader', 'synchronous');
      const expiresAt = Date.now() + authInput.policy.emailVerificationTTLSeconds * 1_000;
      const token = await createReaderEmailChangeToken({
        secret: authInput.secret,
        currentEmail: input.currentEmail,
        newEmail: input.newEmail,
        workflowId: input.workflowId,
        expiresInSeconds: authInput.policy.emailVerificationTTLSeconds,
      });
      const verificationMessage = {
        to: input.newEmail,
        token,
        url: buildAuthActionUrl({
          varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
          configured: authInput.verifyEmailActionURL ?? '',
          requestOrigin: authInput.baseURL,
          fallbackPath: VERIFY_EMAIL_ACTION_PATH,
          token,
        }),
      };
      const retryPayload = await sealAuthMailTask(
        {
          kind: 'reader-email-change-workflow',
          messages: [
            { kind: 'email-verification', message: verificationMessage },
            {
              kind: 'email-change-notice',
              message: {
                to: input.currentEmail,
                previousEmail: input.currentEmail,
                newEmail: input.newEmail,
              },
            },
          ],
        },
        authInput.secret,
      );
      return {
        tokenDigest: await digestVerificationToken(token),
        expiresAt,
        retryPayload,
      };
    } catch {
      return null;
    }
  }

  async function readReaderEmailChangeToken(
    token: string,
  ): Promise<ReaderEmailChangeTokenClaims | null> {
    try {
      const authInput = resolveAuthInput('reader', 'deferred');
      return await readEmailChangeTokenClaims({ secret: authInput.secret, token });
    } catch {
      return null;
    }
  }

  const runtime: IdentityRuntime = {
    get authPolicy() {
      return resolveSettings().policy;
    },
    authentication: () => readerAuth('eager'),
    readerMessaging: () => readerAuth('synchronous'),
    administratorMessaging: () => adminAuth('synchronous'),
    sealPreparedReaderMessage: () => sealPreparedMessage('reader'),
    sealPreparedAdministratorMessage: () => sealPreparedMessage('administrator'),
    retryReaderMessageScheduling: (payload) => retryMessageScheduling('reader', payload),
    retryAdministratorMessageScheduling: (payload) =>
      retryMessageScheduling('administrator', payload),
    prepareReaderEmailChangeMessages,
    readReaderEmailChangeToken,
    retryReaderEmailChangeScheduling: (payload) => retryMessageScheduling('reader', payload),
    sealSocialIdentityUnlinkNotice,
    administration: () => adminAuth('deferred'),
    bootstrapAdministrator: createBootstrapAuth,
    readerState: readerStateAuth,
    cookieMutationAllowed,
    resolveSessionContext,
    resolveAdministratorSessionContext,
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
