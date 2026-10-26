import { createAuthActionsRouter } from './auth-actions.js';
import {
  createIdentityRouter,
  createIdentityV2Router,
  type IdentityRouterOptions,
} from './router.js';
export type {
  AccountPhotoLockTiming,
  AccountPhotoReferenceWriter,
} from './account-photo-operations.js';

// Public slice interface for the identity feature (AGENTS.md change rules).
// Cross-feature consumers (including the application composition root) may
// import only this module, the application-owned contracts, policy and mail
// boundary. `auth.ts` (Better Auth wiring) and `schema.ts` (D1 rows) are
// slice internals and must never be imported outside this directory.
export { createIdentityRouter, createIdentityV2Router };
export { createAuthActionsRouter };
export type { IdentityRouterOptions };
export type {
  AdminBootstrapRequest,
  AdminBootstrapResult,
  AdminMe,
  AdminUser,
  AdminUserDetailParams,
  AdminUserList,
  AdminUserListQuery,
  CheckPasswordResetRequest,
  CheckPasswordResetResult,
  ConsumerJwksResponse,
  ConsumerJsonWebKey,
  ReaderStateResponse,
  CurrentUser,
  LoginRequest,
  LoginResult,
  RegisterRequest,
  RegisterWithoutNameRequest,
  RegisteredUser,
  RequestPasswordResetRequest,
  RequestPasswordResetResult,
  ResetPasswordRequest,
  ResetPasswordResult,
  SignOutResult,
  VerifyEmailRequest,
  VerifyEmailResult,
} from './contract.js';
export type {
  AuthMailDeliveryResult,
  AuthMailer,
  PasswordResetMessage,
  VerificationMessage,
} from './mailer.js';
export { InMemoryAuthMailer, ResendAuthMailer, SmtpAuthMailer } from './mailer.js';
export type { AuthMailPurpose, ResendTransportConfig } from './mailer.js';
export type { AuthMailLogger, AuthMailLogRecord } from './mailer.js';
export type {
  SmtpMailLogger,
  SmtpMailLogRecord,
  SmtpMailPurpose,
  SmtpOutboundMail,
  SmtpSendMail,
  SmtpSendResult,
  SmtpTransportConfig,
} from './mailer.js';
export type { SmtpFailurePhase } from './mailer.js';
export type { AuthPolicy } from './policy.js';
export { DEFAULT_AUTH_POLICY, resolveAuthPolicy } from './policy.js';
export type { BootstrapAdminInput, BootstrapAdminOutcome } from './admin.js';
export { bootstrapAdminUser } from './admin.js';
export type { GetAdminUserInput, ListAdminUsersInput } from './admin-users.js';
export { getAdminUserById, listAdminUsers } from './admin-users.js';
export type { AuthenticatedUser, SessionContext, SessionResolvePhase } from './session.js';
export type { ResolveSessionInput } from './session.js';
export { toAuthenticatedUser, toSessionContext } from './session.js';
export { resolveSessionContext } from './identity-runtime.js';
// Framework-independent consumer Identity client (spec #150, ADR-0013,
// ticket #152). Vendored by the consumer team through
// `./consumer-client/index.js`; it depends only on generated contracts and
// `openapi-fetch`, never on server internals.
export {
  createConsumerClient,
  ConsumerClientError,
  evaluatePassword,
  type AuthoritativeSessionStatus,
  type AuthConfig,
  type ConsumerClient,
  type ConsumerClientOptions,
  type ConsumerLoginInput,
  type ConsumerReaderState,
  type ConsumerRegisterInput,
  type PasswordPolicy,
  type PasswordPolicyEvaluation,
  type PasswordPolicyRule,
} from './consumer-client/index.js';
