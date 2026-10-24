import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import type { D1Database } from '@cloudflare/workers-types';
import { betterAuth } from 'better-auth';
import { createEmailVerificationToken } from 'better-auth/api';
import { admin } from 'better-auth/plugins/admin';
import { jwt } from 'better-auth/plugins/jwt';
import { drizzle } from 'drizzle-orm/d1';
import { jwtVerify } from 'jose';
import {
  RESET_PASSWORD_ACTION_PATH,
  VERIFY_EMAIL_ACTION_PATH,
  buildAuthActionUrl,
} from './action-urls.js';
import { capReaderStateExpirySeconds } from './reader-state.js';
import type { AuthMailer } from './mailer.js';
import type { AuthPolicy } from './policy.js';
import { identitySchema } from './schema.js';
import {
  normalizeVerificationTarget,
  reserveLatestVerificationToken,
} from './verification-token.js';

// Application-owned Reader State options (spec #195, ADR-0013). Issuer,
// audience and lifetime arrive validated from the effective non-secret
// configuration; this layer only translates
// them into the pinned engine JWT capability.
export interface ReaderStateOptions {
  readonly issuer: string;
  readonly audience: string;
  // Bounded token lifetime in seconds (1..900). The minted `exp`
  // additionally never exceeds the authoritative renewal-session expiry.
  readonly ttlSeconds: number;
}

// Identity infrastructure boundary (ADR-0005, ADR-0010). This is the only
// module allowed to import Better Auth or the slice persistence schema:
// it translates the application-owned AuthPolicy/AuthMailer into Better Auth
// configuration and exposes a per-request auth instance. Handlers consume
// `auth.api` results through the public contracts, never persistence rows.
export interface IdentityAuthInput {
  readonly db: D1Database;
  readonly policy: AuthPolicy;
  readonly mailer: AuthMailer;
  readonly secret: string;
  readonly baseURL: string;
  // Canonical application-owned auth action pages (ticket #77). Optional
  // absolute HTTP(S) action-page URLs without a token; empty selects the
  // service-owned fallback browser routes on the request origin. Identity
  // appends exactly one `token` query parameter from the Better Auth token.
  // The engine callback URL never crosses the AuthMailer boundary.
  readonly verifyEmailActionURL?: string;
  readonly resetPasswordActionURL?: string;
  // Schedules provider-latency work outside the synchronous auth response
  // path (ADR-0010). Falls back to supervised fire-and-forget when the
  // request has no execution context (e.g. contract generation, unit calls).
  readonly background: (task: Promise<unknown>) => void;
}

export interface ReaderStateAuthInput extends IdentityAuthInput {
  // Validated Reader State options (issuer/audience/TTL). Required here so
  // the JWT capability is always configured explicitly; deployments without
  // stable values fail closed before this builder runs.
  readonly readerState: ReaderStateOptions;
}

// Better Auth internal log sink (ADR-0009): structured level + message only.
// Extra arguments can carry user objects or error instances, so they are
// never forwarded; messages themselves contain no passwords, tokens,
// cookies, action URLs or message bodies.
function createRedactingLogger(): NonNullable<Parameters<typeof betterAuth>[0]['logger']> {
  return {
    level: 'error',
    log: (level, message) => {
      console.log(JSON.stringify({ level, component: 'better-auth', message }));
    },
  };
}

// Builds a request-scoped Better Auth instance. Instances are cheap to
// construct (the underlying context initializes lazily) and must be scoped
// per request because the D1 binding, deployment policy, mailer and base URL
// all vary per request/environment. The return type is intentionally inferred
// so the precise engine options type flows to consumers instead of the
// generic default, which is not variance-compatible with it.
export function createIdentityAuth(input: IdentityAuthInput) {
  return betterAuth({
    ...sharedOptions(input),
    // Better Auth supported administration capability (ticket #59, spec #8).
    // Roles, bans and session administration belong to the Identity boundary;
    // they are not editorial CMS roles and imply no custom admin UI. The
    // plugin's management endpoints are never mounted on the public Worker:
    // administration is exercised server-side through `auth.api` (notably the
    // explicit first-admin bootstrap), so enabling the plugin adds no public
    // HTTP surface by itself.
    plugins: [admin()],
  });
}

// Bootstrap-only Better Auth API context. It is never mounted on the Worker:
// the just-created provisional user receives only the scoped Admin API
// capability needed to promote its own durably claimed id, plus the core
// self-delete operation used to clean up an unclaimed provisional user.
// Email verification is disabled only in this private context so Better Auth's
// supported email sign-in API can issue the short-lived internal session; the
// deployment-facing auth instance and its verification policy are unchanged.
export function createBootstrapIdentityAuth(input: IdentityAuthInput, provisionalUserId: string) {
  return betterAuth({
    ...sharedOptions({
      ...input,
      policy: { ...input.policy, requireEmailVerification: false },
    }),
    user: { deleteUser: { enabled: true } },
    plugins: [admin({ adminUserIds: [provisionalUserId] })],
  });
}

// Builds a request-scoped Better Auth instance with the asymmetric JWT/JWKS
// capability behind the Reader State contract (spec #195, ADR-0013). Used only by the
// application-owned POST /v1/auth/reader-state and GET /v1/auth/jwks operations;
// every other identity operation uses `createIdentityAuth` so no ambient
// token header or key provisioning can occur elsewhere. The engine auth
// router is never mounted; handlers reach this capability through `auth.api`
// only. The return type is intentionally inferred so the plugin endpoints
// (`getToken`, `getJwks`) flow to consumers with precise types.
export function createReaderStateAuth(input: ReaderStateAuthInput) {
  const readerState = input.readerState;
  return betterAuth({
    ...sharedOptions(input),
    plugins: [
      admin(),
      // Pinned engine JWT/JWKS capability behind the identity adapter. Its
      // default whole-user payload is replaced with the explicit
      // application-owned claims contract (opaque sub, configured iss/aud,
      // integer iat/exp, entitlements). The supported algorithm is fixed to
      // EdDSA/Ed25519 with durable D1-backed key ids as stable kids.
      // Ambient token headers stay disabled: issuance happens only through
      // the application-owned token operation.
      jwt({
        disableSettingJwtHeader: true,
        jwks: { keyPairConfig: { alg: 'EdDSA', crv: 'Ed25519' } },
        jwt: {
          issuer: readerState.issuer,
          audience: readerState.audience,
          expirationTime: `${readerState.ttlSeconds.toString()} seconds`,
          definePayload: ({ session }) => {
            const nowSeconds = Math.floor(Date.now() / 1000);
            const sessionExpirySeconds = Math.floor(session.expiresAt.getTime() / 1000);
            return {
              entitlements: [],
              iss: readerState.issuer,
              aud: readerState.audience,
              exp: capReaderStateExpirySeconds({
                nowSeconds,
                ttlSeconds: readerState.ttlSeconds,
                sessionExpirySeconds,
              }),
            };
          },
          getSubject: ({ user }) => user.id,
        },
      }),
    ],
  });
}

// Shared engine options for both builders. Plugin lists stay literal at each
// call site so endpoint inference keeps the precise plugin type.
function sharedOptions(input: IdentityAuthInput) {
  const {
    db,
    policy,
    mailer,
    secret,
    baseURL,
    verifyEmailActionURL,
    resetPasswordActionURL,
    background,
  } = input;
  const database = drizzle(db, { schema: identitySchema });

  return {
    baseURL,
    secret,
    logger: createRedactingLogger(),
    database: drizzleAdapter(database, { provider: 'sqlite', schema: identitySchema }),
    // Service-only session cookie (spec #164, ADR-0013): pinned HttpOnly and
    // SameSite=Lax with no `domain`, so the renewal credential is host-only
    // to the service Worker and is never shared with the parent editorial
    // hostname. `secure` stays engine-derived from the request HTTPS base
    // URL (on in sandbox/production); `crossSubDomainCookies` stays
    // disabled, so no `Domain` attribute is ever emitted.
    advanced: {
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' as const },
    },
    emailAndPassword: {
      enabled: policy.emailPasswordEnabled,
      disableSignUp: !policy.registrationEnabled,
      requireEmailVerification: policy.requireEmailVerification,
      minPasswordLength: policy.passwordPolicy.minLength,
      maxPasswordLength: policy.passwordPolicy.maxLength,
      // Password recovery goes through the application-owned AuthMailer like
      // verification does; provider SDK/types stay inside adapters (ADR-0010).
      // Successful resets revoke existing sessions so previously issued
      // sessions cannot continue authenticating (ticket #12, ADR-0005).
      // The engine callback URL is an implementation detail (ticket #77): it
      // is never forwarded. Identity builds the user-facing reset action from
      // the configured consumer page (or the service-owned fallback route on
      // the request origin) plus the engine token.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: ({ user, token }: { user: { email: string }; token: string }) => {
        const url = buildAuthActionUrl({
          varName: 'AUTH_RESET_PASSWORD_ACTION_URL',
          configured: resetPasswordActionURL ?? '',
          requestOrigin: baseURL,
          fallbackPath: RESET_PASSWORD_ACTION_PATH,
          token,
        });
        background(mailer.sendPasswordResetEmail({ to: user.email, url, token }));
        return Promise.resolve();
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      expiresIn: policy.emailVerificationTTLSeconds,
      // The engine verification callback URL never becomes public contract
      // (ticket #77): the user-facing action targets the configured consumer
      // page or the service-owned fallback route with the engine token as the
      // single `token` query parameter.
      sendVerificationEmail: async ({
        user,
        token,
        newEmail,
      }: {
        user: { email: string };
        token: string;
        newEmail?: string;
      }) => {
        const verifiedClaims = await jwtVerify(token, new TextEncoder().encode(secret), {
          algorithms: ['HS256'],
        });
        const requestType = verifiedClaims.payload.requestType;
        const signedToken = await createEmailVerificationToken(
          secret,
          user.email,
          newEmail,
          policy.emailVerificationTTLSeconds,
          {
            ...(typeof requestType === 'string' ? { requestType } : {}),
            jti: crypto.randomUUID(),
          },
        );
        const targetEmail = normalizeVerificationTarget(newEmail ?? user.email);
        await reserveLatestVerificationToken({
          db,
          targetEmail,
          token: signedToken,
          expiresAt: new Date(Date.now() + policy.emailVerificationTTLSeconds * 1000),
        });
        const url = buildAuthActionUrl({
          varName: 'AUTH_VERIFY_EMAIL_ACTION_URL',
          configured: verifyEmailActionURL ?? '',
          requestOrigin: baseURL,
          fallbackPath: VERIFY_EMAIL_ACTION_PATH,
          token: signedToken,
        });
        background(
          mailer.sendVerificationEmail({
            to: newEmail ?? user.email,
            url,
            token: signedToken,
          }),
        );
      },
    },
  };
}
