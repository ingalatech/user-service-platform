import type { D1Database } from '@cloudflare/workers-types';
import type {
  CheckPasswordResetRequest,
  CheckPasswordResetResult,
  LoginRequest,
  LoginResult,
  RegisterRequest,
  RegisterWithoutNameRequest,
  RegisteredUser,
  RequestPasswordResetRequest,
  RequestPasswordResetResult,
  RequestVerificationRequest,
  RequestVerificationResult,
  ResetPasswordRequest,
  ResetPasswordResult,
  SignOutResult,
  VerifyEmailRequest,
  VerifyEmailResult,
} from './contract.js';
import { callIdentityEngine, readIdentityEngineFailure, responseCookies } from './engine-result.js';
import { evaluatePasswordPolicy } from './password-policy.js';
import type { PasswordPolicy, PasswordPolicyViolation } from './password-policy.js';
import { isCurrentPasswordResetToken } from './password-reset-token.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { toAuthenticatedUser } from './session.js';
import { consumeLatestVerificationToken } from './verification-token.js';

export type CredentialFailure =
  | { readonly kind: 'email-password-disabled' }
  | { readonly kind: 'registration-disabled' }
  | ({ readonly kind: 'password-policy-violation' } & PasswordPolicyViolation)
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'email-verification-required' }
  | { readonly kind: 'invalid-credentials' }
  | { readonly kind: 'verification-invalid' }
  | { readonly kind: 'reset-invalid' }
  | { readonly kind: 'internal-error' };

type PasswordPolicyFailure = Extract<
  CredentialFailure,
  { readonly kind: 'password-policy-violation' }
>;

export type BootstrapCredentialValidation =
  | { readonly kind: 'valid' }
  | {
      readonly kind: 'failure';
      readonly failure: Extract<
        CredentialFailure,
        { readonly kind: 'email-password-disabled' | 'password-policy-violation' }
      >;
    };

export type CredentialOperationOutcome<T> =
  | { readonly kind: 'success'; readonly value: T; readonly cookies: readonly string[] }
  | {
      readonly kind: 'failure';
      readonly failure: CredentialFailure;
      readonly cookies: readonly string[];
    };

export interface CredentialOperations {
  validateBootstrapPassword(password: string): BootstrapCredentialValidation;
  register(
    input: RegisterRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<RegisteredUser>>;
  registerWithoutName(
    input: RegisterWithoutNameRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<RegisteredUser>>;
  login(input: LoginRequest, headers: Headers): Promise<CredentialOperationOutcome<LoginResult>>;
  verifyEmail(
    input: VerifyEmailRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<VerifyEmailResult>>;
  requestVerification(
    input: RequestVerificationRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<RequestVerificationResult>>;
  requestPasswordReset(
    input: RequestPasswordResetRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<RequestPasswordResetResult>>;
  checkPasswordReset(
    input: CheckPasswordResetRequest,
  ): Promise<CredentialOperationOutcome<CheckPasswordResetResult>>;
  resetPassword(
    input: ResetPasswordRequest,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<ResetPasswordResult>>;
  signOut(headers: Headers): Promise<CredentialOperationOutcome<SignOutResult>>;
}

export interface CredentialOperationsInput {
  readonly runtime: IdentityRuntime;
  readonly db: D1Database;
  readonly realm?: 'administrator';
}

function success<T>(value: T, cookies: readonly string[] = []): CredentialOperationOutcome<T> {
  return { kind: 'success', value, cookies };
}

function failure<T = never>(
  reason: CredentialFailure,
  cookies: readonly string[] = [],
): CredentialOperationOutcome<T> {
  return { kind: 'failure', failure: reason, cookies };
}

function passwordPolicyFailure(
  password: string,
  passwordPolicy: PasswordPolicy,
): PasswordPolicyFailure | null {
  const evaluation = evaluatePasswordPolicy(password, passwordPolicy);
  if (evaluation.valid) return null;
  return {
    kind: 'password-policy-violation',
    failedRules: evaluation.failedRules,
    passwordPolicy: evaluation.policy,
  };
}

function readUser(payload: unknown): RegisteredUser | null {
  const user = toAuthenticatedUser(payload);
  return user === null
    ? null
    : { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

function readLoginIdentity(
  payload: unknown,
  realm: 'reader' | 'administrator',
): LoginResult | null {
  if (realm === 'reader') {
    const user = toAuthenticatedUser(payload);
    return user === null
      ? null
      : { id: user.id, email: user.email, emailVerified: user.emailVerified };
  }
  if (typeof payload !== 'object' || payload === null || !('user' in payload)) return null;
  const user = payload.user;
  if (
    typeof user !== 'object' ||
    user === null ||
    !('role' in user) ||
    user.role !== 'admin' ||
    !('id' in user) ||
    typeof user.id !== 'string' ||
    !('email' in user) ||
    typeof user.email !== 'string' ||
    !('emailVerified' in user) ||
    typeof user.emailVerified !== 'boolean'
  )
    return null;
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

// Application-owned credential lifecycle. These operations own AuthPolicy
// gates, Better Auth failure mapping, one-use token handling, and projection to
// the stable contracts; the router retains only HTTP adaptation.
export function createCredentialOperations(input: CredentialOperationsInput): CredentialOperations {
  const { runtime, db } = input;
  const realm = input.realm ?? 'reader';
  const auth = () => (realm === 'reader' ? runtime.authentication() : runtime.administration());

  async function registerIdentity(
    request: Pick<RegisterRequest, 'email' | 'password'>,
    technicalName: string,
    headers: Headers,
  ): Promise<CredentialOperationOutcome<RegisteredUser>> {
    const engine = auth();
    const policy = runtime.authPolicy;
    if (!policy.emailPasswordEnabled) return failure({ kind: 'email-password-disabled' });
    if (!policy.registrationEnabled) return failure({ kind: 'registration-disabled' });
    const invalidPassword = passwordPolicyFailure(request.password, policy.passwordPolicy);
    if (invalidPassword !== null) return failure(invalidPassword);

    const outcome = await callIdentityEngine(() =>
      engine.api.signUpEmail({
        body: { name: technicalName, email: request.email, password: request.password },
        headers,
        asResponse: true,
      }),
    );
    if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
    if (!outcome.ok) return failure({ kind: 'bad-request' });
    const user = readUser(await outcome.json().catch(() => null));
    return user === null ? failure({ kind: 'internal-error' }) : success(user);
  }

  return {
    validateBootstrapPassword(password) {
      if (!runtime.authPolicy.emailPasswordEnabled) {
        return {
          kind: 'failure',
          failure: { kind: 'email-password-disabled' },
        };
      }
      const invalidPassword = passwordPolicyFailure(password, runtime.authPolicy.passwordPolicy);
      return invalidPassword === null
        ? { kind: 'valid' }
        : { kind: 'failure', failure: invalidPassword };
    },

    register(request, headers) {
      const technicalName = request.name ?? request.email.slice(0, request.email.indexOf('@'));
      return registerIdentity(request, technicalName, headers);
    },

    registerWithoutName(request, headers) {
      return registerIdentity(request, request.email, headers);
    },

    async login(request, headers) {
      const engine = auth();
      if (!runtime.authPolicy.emailPasswordEnabled) {
        return failure({ kind: 'email-password-disabled' });
      }

      const outcome = await callIdentityEngine(() =>
        engine.api.signInEmail({
          body: { email: request.email, password: request.password },
          headers,
          asResponse: true,
        }),
      );
      if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
      if (!outcome.ok) {
        const engineFailure = await readIdentityEngineFailure(outcome);
        if (engineFailure.status === 403 && engineFailure.code === 'EMAIL_NOT_VERIFIED') {
          return failure({ kind: 'email-verification-required' });
        }
        if (engineFailure.status === 401) return failure({ kind: 'invalid-credentials' });
        return failure({ kind: 'bad-request' });
      }
      const user = readLoginIdentity(await outcome.json().catch(() => null), realm);
      return user === null
        ? failure({ kind: 'internal-error' })
        : success(user, responseCookies(outcome));
    },

    async verifyEmail(request, headers) {
      let consumed: boolean;
      try {
        consumed = await consumeLatestVerificationToken({
          db,
          realm: input.realm,
          token: request.token,
        });
      } catch {
        consumed = false;
      }
      if (!consumed) return failure({ kind: 'verification-invalid' });

      const outcome = await callIdentityEngine(() =>
        auth().api.verifyEmail({
          query: { token: request.token },
          headers,
          asResponse: true,
        }),
      );
      if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
      return outcome.ok
        ? success({ emailVerified: true })
        : failure({ kind: 'verification-invalid' });
    },

    async requestVerification(request, headers) {
      const engine = auth();
      if (!runtime.authPolicy.emailPasswordEnabled) {
        return failure({ kind: 'email-password-disabled' });
      }

      const outcome = await callIdentityEngine(() =>
        engine.api.sendVerificationEmail({
          body: { email: request.email },
          headers,
          asResponse: true,
        }),
      );
      if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
      if (outcome.ok) return success({ status: 'ok' });
      const engineFailure = await readIdentityEngineFailure(outcome);
      if (engineFailure.code === 'EMAIL_MISMATCH') return failure({ kind: 'bad-request' });
      return engineFailure.status >= 500
        ? failure({ kind: 'internal-error' })
        : success({ status: 'ok' });
    },

    async requestPasswordReset(request, headers) {
      const engine = auth();
      if (!runtime.authPolicy.emailPasswordEnabled) {
        return failure({ kind: 'email-password-disabled' });
      }

      const outcome = await callIdentityEngine(() =>
        engine.api.requestPasswordReset({
          body: { email: request.email },
          headers,
          asResponse: true,
        }),
      );
      if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
      if (outcome.ok) return success({ status: 'ok' });
      const engineFailure = await readIdentityEngineFailure(outcome);
      return engineFailure.status >= 500
        ? failure({ kind: 'internal-error' })
        : success({ status: 'ok' });
    },

    async checkPasswordReset(request) {
      if (!runtime.authPolicy.emailPasswordEnabled) {
        return failure({ kind: 'email-password-disabled' });
      }
      try {
        const valid = await isCurrentPasswordResetToken({
          db,
          realm: input.realm,
          token: request.token,
        });
        return success({ valid });
      } catch {
        return failure({ kind: 'internal-error' });
      }
    },

    async resetPassword(request, headers) {
      const engine = auth();
      const policy = runtime.authPolicy;
      if (!policy.emailPasswordEnabled) return failure({ kind: 'email-password-disabled' });
      const invalidPassword = passwordPolicyFailure(request.newPassword, policy.passwordPolicy);
      if (invalidPassword !== null) return failure(invalidPassword);

      const outcome = await callIdentityEngine(() =>
        engine.api.resetPassword({
          body: { newPassword: request.newPassword, token: request.token },
          headers,
          asResponse: true,
        }),
      );
      if (!(outcome instanceof Response)) return failure({ kind: 'internal-error' });
      if (outcome.ok) return success({ status: 'ok' });
      const engineFailure = await readIdentityEngineFailure(outcome);
      return engineFailure.status >= 500
        ? failure({ kind: 'internal-error' })
        : failure({ kind: 'reset-invalid' });
    },

    async signOut(headers) {
      const outcome = await callIdentityEngine(() =>
        auth().api.signOut({ headers, asResponse: true }),
      );
      if (!(outcome instanceof Response)) {
        return outcome.status >= 500
          ? failure({ kind: 'internal-error' })
          : success({ status: 'ok' });
      }
      const cookies = responseCookies(outcome);
      if (outcome.ok) return success({ status: 'ok' }, cookies);
      const engineFailure = await readIdentityEngineFailure(outcome);
      return engineFailure.status >= 500
        ? failure({ kind: 'internal-error' }, cookies)
        : success({ status: 'ok' }, cookies);
    },
  };
}
