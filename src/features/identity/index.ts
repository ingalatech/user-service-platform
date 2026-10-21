import { createAuthActionsRouter } from './auth-actions.js';
import { createIdentityRouter, type IdentityRouterOptions } from './router.js';

// Public slice interface for the identity feature (AGENTS.md change rules).
// Cross-feature consumers (including the application composition root) may
// import only this module, the application-owned contracts, policy and mail
// boundary. `auth.ts` (Better Auth wiring) and `schema.ts` (D1 rows) are
// slice internals and must never be imported outside this directory.
export { createIdentityRouter };
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
  ConsumerJwksResponse,
  ConsumerJsonWebKey,
  ConsumerTokenResponse,
  CurrentUser,
  LoginRequest,
  LoginResult,
  RegisterRequest,
  RegisteredUser,
  RequestPasswordResetRequest,
  RequestPasswordResetResult,
  ResetPasswordRequest,
  ResetPasswordResult,
  SignOutResult,
  VerifyEmailRequest,
  VerifyEmailResult,
} from './contract.js';
export type { AuthMailer, PasswordResetMessage, VerificationMessage } from './mailer.js';
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
export type {
  AuthenticatedUser,
  ResolveSessionInput,
  SessionContext,
  SessionResolvePhase,
} from './session.js';
export { resolveSessionContext, toAuthenticatedUser, toSessionContext } from './session.js';
// Framework-independent consumer Identity client (spec #150, ADR-0013,
// ticket #152). Vendored by the consumer team through
// `./consumer-client/index.js`; it depends only on generated contracts and
// `openapi-fetch`, never on server internals.
export {
  createBrowserLogoutBroadcast,
  createConsumerClient,
  createMemoryLogoutBroadcast,
  ConsumerClientError,
  type ConsumerClient,
  type ConsumerClientOptions,
  type ConsumerIdentitySnapshot,
  type ConsumerLoginInput,
  type ConsumerRegisterInput,
  type LogoutBroadcast,
} from './consumer-client/index.js';
export { createJwksCache, type JwksCache, type JwksCacheInput } from './consumer-client/index.js';
export {
  ConsumerTokenError,
  verifyConsumerToken,
  // The client verification key mirrors the public contract key without
  // importing server (Zod/Hono) types into the independently importable
  // client boundary; the alias keeps the two representations distinct.
  type ConsumerJsonWebKey as ConsumerVerificationKey,
  type VerifiedConsumerSnapshot,
  type VerifyConsumerTokenErrorCode,
  type VerifyConsumerTokenInput,
} from './consumer-client/index.js';
