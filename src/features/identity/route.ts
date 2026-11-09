import { createRoute, z } from '@hono/zod-openapi';
import { IdentityProblemDetailsSchema } from './problem.js';
import {
  AdminBootstrapRequestSchema,
  AdminBootstrapResultSchema,
  AdminAdministratorListQuerySchema,
  AdminAdministratorListSchema,
  AdminAdministratorDetailSchema,
  AdminAdministratorParamsSchema,
  AdminAdministratorActivityQuerySchema,
  AdminAdministratorActivitySchema,
  AdminAdministratorAccessRequestSchema,
  AdminAdministratorAccessResultSchema,
  AdminAdministratorMessageRequestSchema,
  AdminAdministratorMessageSchema,
  AdminAuditEventsQuerySchema,
  AdminAuditEventsSchema,
  AdminMeSchema,
  AdminUserDetailParamsSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  AdminReaderDetailSchema,
  AdminReaderActivityQuerySchema,
  AdminReaderActivitySchema,
  AdminReaderSessionsQuerySchema,
  AdminReaderSessionsSchema,
  AdminReaderSessionParamsSchema,
  AdminReaderSessionRevocationSchema,
  AdminReaderEmailVerificationSchema,
  AdminReaderAccessRequestSchema,
  AdminReaderAccessResultSchema,
  AdminReaderMessageRequestSchema,
  AdminReaderMessageSchema,
  AdminReaderEmailChangeRequestSchema,
  AdminReaderEmailChangeParamsSchema,
  AdminReaderEmailChangeCommandSchema,
  AdminReaderEmailChangeSchema,
  AdminReaderEmailChangeCancelSchema,
  AdminReaderEmailChangeMessageSchema,
  AdminReaderDeletionRequestCreateSchema,
  AdminReaderDeletionRequestParamsSchema,
  AdminReaderDeletionRequestSchema,
  AdminReaderDeletionRequestStatusSchema,
  AdminReaderDeletionRequestTransitionSchema,
  AdminReaderSocialIdentityParamsSchema,
  AdminReaderSocialIdentityUnlinkSchema,
  AuthConfigSchema,
  CheckPasswordResetRequestSchema,
  CheckPasswordResetResultSchema,
  ConsumerJwksResponseSchema,
  ReaderStateResponseSchema,
  CurrentUserSchema,
  AccountDetailsSchema,
  AccountPhotoIdParamsSchema,
  UpdateAccountDetailsSchema,
  LoginRequestSchema,
  LoginResultSchema,
  RegisterRequestSchema,
  RegisterWithoutNameRequestSchema,
  RegisteredUserSchema,
  RequestPasswordResetRequestSchema,
  RequestPasswordResetResultSchema,
  RequestVerificationRequestSchema,
  RequestVerificationResultSchema,
  ResetPasswordRequestSchema,
  ResetPasswordResultSchema,
  SignOutResultSchema,
  VerifyEmailRequestSchema,
  VerifyEmailResultSchema,
} from './contract.js';

const adminReaderIfMatchHeaders = z
  .object({ 'if-match': z.string().min(1).max(128).optional() })
  .openapi('AdminReaderIfMatchHeaders');

const adminReaderSocialIdentityHeaders = z
  .object({
    'if-match': z.string().min(1).max(128).optional(),
    'idempotency-key': z.string().min(1).max(128).optional(),
  })
  .openapi('AdminReaderSocialIdentityHeaders');

const adminAdministratorIfMatchHeaders = z
  .object({ 'if-match': z.string().min(1).max(128).optional() })
  .openapi('AdminAdministratorIfMatchHeaders');

const adminAdministratorMessageHeaders = z
  .object({ 'idempotency-key': z.string().min(1).max(128).optional() })
  .openapi('AdminAdministratorMessageHeaders');

const adminReaderMessageHeaders = z
  .object({ 'idempotency-key': z.string().min(1).max(128).optional() })
  .openapi('AdminReaderMessageHeaders');

const adminReaderEmailChangeCreateHeaders = z
  .object({
    'if-match': z.string().min(1).max(128).optional(),
    'idempotency-key': z.string().min(1).max(128).optional(),
  })
  .openapi('AdminReaderEmailChangeCreateHeaders');

const adminReaderEmailChangeWorkflowHeaders = z
  .object({
    'if-match': z.string().min(1).max(128).optional(),
    'idempotency-key': z.string().min(1).max(128).optional(),
  })
  .openapi('AdminReaderEmailChangeWorkflowHeaders');

const adminReaderDeletionCreateHeaders = z
  .object({
    'if-match': z.string().min(1).max(128).optional(),
    'idempotency-key': z.string().min(1).max(128).optional(),
  })
  .openapi('AdminReaderDeletionCreateHeaders');

const adminReaderDeletionTransitionHeaders = z
  .object({
    'if-match': z.string().min(1).max(128).optional(),
    'idempotency-key': z.string().min(1).max(128).optional(),
  })
  .openapi('AdminReaderDeletionTransitionHeaders');

const adminReaderCommandResponses = {
  400: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Invalid command input.',
  },
  401: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'No authoritative Administrator session.',
  },
  403: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The actor is not allowed to perform the command.',
  },
  404: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Reader not found.',
  },
  409: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command conflicts with current Reader state.',
  },
  412: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The resource revision is stale.',
  },
  428: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'A required precondition is missing.',
  },
  429: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The message cooldown is active.',
  },
  500: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command could not be audited or completed.',
  },
  503: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Message scheduling failed after the command was committed.',
  },
} as const;

const adminReaderEmailChangeResponses = {
  400: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Invalid command input.',
  },
  401: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'No authoritative Administrator session or invalid verification token.',
  },
  403: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The actor is not allowed to perform the command.',
  },
  404: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Reader or email-change workflow not found.',
  },
  409: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command conflicts with the canonical email or workflow state.',
  },
  412: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The supplied revision is stale.',
  },
  428: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'A required precondition or idempotency key is missing.',
  },
  429: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The email-change message cooldown is active.',
  },
  500: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command could not be audited or completed.',
  },
  503: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Message scheduling failed after the workflow was committed.',
  },
} as const;

const adminAdministratorMessageResponses = {
  400: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Invalid command input.',
  },
  401: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'No authoritative Administrator session.',
  },
  403: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The actor is not allowed to perform the command.',
  },
  404: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Administrator not found.',
  },
  409: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command conflicts with current Administrator state.',
  },
  428: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'A required Idempotency-Key is missing.',
  },
  429: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The message cooldown is active.',
    headers: {
      'Retry-After': {
        description: 'Seconds until this message kind can be requested again.',
        schema: { type: 'integer', minimum: 1 },
      },
    },
  },
  500: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command could not be audited or completed.',
  },
  503: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Message scheduling failed after the command was committed.',
  },
} as const;

// Public operation definitions for the identity slice (ticket #10). The
// feature owns paths relative to `/v1/auth`; the application mounts the
// router under `/v1` (ADR-0007). Every failure uses the service-wide RFC 9457
// Problem Details envelope so consumers branch on status + stable `code`.
function problemResponses(description: string): {
  default: {
    content: { 'application/problem+json': { schema: typeof IdentityProblemDetailsSchema } };
    description: string;
  };
} {
  return {
    default: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description,
    },
  };
}

export const registerRoute = createRoute({
  method: 'post',
  path: '/auth/register',
  operationId: 'registerIdentity',
  summary: 'Register an email identity',
  description:
    'Creates an unverified email/password identity when the deployment policy ' +
    'allows registration, and schedules a verification message through the ' +
    'application mail boundary. The account cannot establish a session until ' +
    'verification succeeds while the policy requires verified email.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RegisterRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: RegisteredUserSchema } },
      description: 'The identity was created (unverified).',
    },
    ...problemResponses('Registration failure as RFC 9457 Problem Details.'),
  },
});

export const registerWithoutNameRoute = createRoute({
  method: 'post',
  path: '/auth/register',
  operationId: 'registerIdentityV2',
  summary: 'Register an email identity without a public name',
  description:
    'Creates an unverified email/password identity from email and password only. ' +
    'The full email address is used as Better Auth’s required technical name; ' +
    'Account Details remain unset until explicitly provided through their own operations.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RegisterWithoutNameRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: RegisteredUserSchema } },
      description: 'The identity was created (unverified).',
    },
    ...problemResponses('Registration failure as RFC 9457 Problem Details.'),
  },
});

export const loginRoute = createRoute({
  method: 'post',
  path: '/auth/login',
  operationId: 'loginIdentity',
  summary: 'Establish an email/password session',
  description:
    'Authenticates an email/password identity. While the deployment policy ' +
    'requires verified email, unverified accounts receive a machine-readable ' +
    'verification-required failure instead of a session.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: LoginRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: LoginResultSchema } },
      description: 'Authenticated. The session travels in the Set-Cookie header.',
    },
    ...problemResponses('Authentication failure as RFC 9457 Problem Details.'),
  },
});

export const verifyEmailRoute = createRoute({
  method: 'post',
  path: '/auth/verify-email',
  operationId: 'verifyIdentityEmail',
  summary: 'Complete email verification',
  description:
    'Completes either ordinary email verification or an administrative Reader email-change ' +
    'workflow. For email change, the new address is promoted to canonical and verified, all ' +
    'Reader sessions are revoked, and earlier verification, recovery and email-change workflows ' +
    'are invalidated atomically. Clients extract the `token` query parameter from the action URL ' +
    'and submit it here. Invalid or expired actions return the stable `verification-invalid` ' +
    'Problem Details code without revealing token material.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: VerifyEmailRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: VerifyEmailResultSchema } },
      description:
        'Ordinary verification completed, or email change atomically promoted and verified the new canonical address while revoking sessions.',
    },
    400: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Invalid or expired action; stable code `verification-invalid`.',
    },
    409: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description:
        'An active Reader deletion request blocks email-change completion; stable code `active-deletion-request`.',
    },
    500: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Atomic completion failed; no partial email-change effects are committed.',
    },
    ...problemResponses('Verification failure as RFC 9457 Problem Details.'),
  },
});

export const requestVerificationRoute = createRoute({
  method: 'post',
  path: '/auth/request-verification',
  operationId: 'requestIdentityVerification',
  summary: 'Request a verification message',
  description:
    'Schedules a fresh verification message for an unverified email address ' +
    'without creating duplicate identities. The response is identical ' +
    'whether or not the address is registered, so it cannot be used for ' +
    'account enumeration.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RequestVerificationRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: RequestVerificationResultSchema } },
      description: 'The request was accepted.',
    },
    ...problemResponses('Request failure as RFC 9457 Problem Details.'),
  },
});

export const currentUserRoute = createRoute({
  method: 'get',
  path: '/me',
  operationId: 'getCurrentUser',
  summary: 'Resolve the current User',
  description:
    'Returns the stable application-owned current-User representation for ' +
    'the session carried by the request cookies. Anonymous or invalid ' +
    'sessions receive the standard unauthenticated Problem Details response.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: CurrentUserSchema } },
      description: 'The authenticated current User.',
    },
    ...problemResponses('Authentication failure as RFC 9457 Problem Details.'),
  },
});

export const accountDetailsRoute = createRoute({
  method: 'get',
  path: '/account-details',
  operationId: 'getAccountDetails',
  summary: 'Read the current User account details',
  description:
    'Returns only the current User’s optional Account Details through the live service session.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: AccountDetailsSchema } },
      description: 'The current User’s Account Details.',
    },
    ...problemResponses('Authentication failure as RFC 9457 Problem Details.'),
  },
});

export const updateAccountDetailsRoute = createRoute({
  method: 'patch',
  path: '/account-details',
  operationId: 'updateAccountDetails',
  summary: 'Partially update the current User account details',
  description: 'Atomically updates only explicitly allowed Account Details for the current User.',
  tags: ['identity'],
  request: { body: { content: { 'application/json': { schema: UpdateAccountDetailsSchema } } } },
  responses: {
    204: { description: 'The Account Details update was committed.' },
    ...problemResponses('Validation or authentication failure as RFC 9457 Problem Details.'),
  },
});

const AccountPhotoBinarySchema = z.string().openapi({
  type: 'string',
  format: 'binary',
});

const accountPhotoBinaryResponses = {
  'image/jpeg': { schema: AccountPhotoBinarySchema },
  'image/png': { schema: AccountPhotoBinarySchema },
  'image/webp': { schema: AccountPhotoBinarySchema },
};

export const uploadAccountPhotoRoute = createRoute({
  method: 'post',
  path: '/account-photo',
  operationId: 'uploadAccountPhoto',
  summary: 'Upload the current User photo',
  description:
    'Streams a JPEG, PNG, or WebP body of at most 2 MiB, 8192 pixels per axis, and 40 megapixels to private object storage. ' +
    'The service validates its bounded container structure and stores only an opaque service-route reference in Identity.',
  tags: ['identity'],
  request: {
    body: {
      required: true,
      content: accountPhotoBinaryResponses,
    },
  },
  responses: {
    204: { description: 'The photo reference was saved for the current User.' },
    ...problemResponses('Validation, authentication, storage or configuration failure.'),
  },
});

export const getAccountPhotoRoute = createRoute({
  method: 'get',
  path: '/account-photo/{photoId}',
  operationId: 'getAccountPhoto',
  summary: 'Read the current User photo',
  description:
    'Streams the referenced private photo only when the live session owns the User and photo reference.',
  tags: ['identity'],
  request: { params: AccountPhotoIdParamsSchema },
  responses: {
    200: {
      content: accountPhotoBinaryResponses,
      description: 'The private photo bytes, streamed with its validated media type.',
    },
    ...problemResponses('Authentication, ownership, object availability or storage failure.'),
  },
});

export const deleteAccountPhotoRoute = createRoute({
  method: 'delete',
  path: '/account-photo',
  operationId: 'deleteAccountPhoto',
  summary: 'Remove the current User photo',
  description: 'Clears the current User photo reference and queues private-object cleanup durably.',
  tags: ['identity'],
  responses: {
    204: { description: 'The current User photo reference was cleared.' },
    ...problemResponses('Authentication or storage failure.'),
  },
});

export const signOutRoute = createRoute({
  method: 'post',
  path: '/auth/sign-out',
  operationId: 'signOutIdentity',
  summary: 'Invalidate the current session',
  description:
    'Invalidates the session carried by the request cookies. Subsequent ' +
    'authenticated-only requests with that session no longer resolve a User.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: SignOutResultSchema } },
      description: 'The session was invalidated.',
    },
    ...problemResponses('Sign-out failure as RFC 9457 Problem Details.'),
  },
});

export const readerStateRoute = createRoute({
  method: 'post',
  path: '/auth/reader-state',
  operationId: 'issueReaderState',
  summary: 'Issue or refresh presentation-only Reader State',
  description:
    'Issues or refreshes short-lived signed Reader State from the ' +
    'live HttpOnly cookie session. The request carries no user, claims, ' +
    'issuer or audience. Reader State holds the opaque subject, stable issuer, ' +
    'Reader-State-specific audience, integer issued/expiry bounds and ' +
    'an empty entitlements list. Expiry never exceeds the live session ' +
    'expiry and is at most 15 minutes. Reader State is for presentation only ' +
    'and never authenticates or authorizes an endpoint. All responses are ' +
    'private, no-store.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: ReaderStateResponseSchema } },
      description: 'The signed Reader State and its integer Unix expiry.',
    },
    ...problemResponses('Issuance failure as RFC 9457 Problem Details.'),
  },
});

export const consumerJwksRoute = createRoute({
  method: 'get',
  path: '/auth/jwks',
  operationId: 'getConsumerJwks',
  summary: 'Publish Reader State verification keys',
  description:
    'Returns the active and retained public asymmetric verification keys as ' +
    'an RFC 7517 JSON Web Key Set. Private key material is never published. ' +
    'Responses carry bounded public caching; verification keys remain ' +
    'available through every outstanding token lifetime plus the documented ' +
    'clock tolerance.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: ConsumerJwksResponseSchema } },
      description: 'The public verification keys.',
    },
    ...problemResponses('Publication failure as RFC 9457 Problem Details.'),
  },
});

export const authConfigRoute = createRoute({
  method: 'get',
  path: '/auth/config',
  operationId: 'getAuthConfig',
  summary: 'Publish effective authentication capabilities and password policy',
  description:
    'Returns deployment-owned authentication capabilities and password creation policy. ' +
    'No secrets or provider configuration are included; the response is never cached.',
  tags: ['identity'],
  responses: {
    200: {
      content: { 'application/json': { schema: AuthConfigSchema } },
      description: 'The effective public authentication configuration.',
    },
    ...problemResponses('Configuration failure as RFC 9457 Problem Details.'),
  },
});

export const requestPasswordResetRoute = createRoute({
  method: 'post',
  path: '/auth/request-password-reset',
  operationId: 'requestPasswordReset',
  summary: 'Request password recovery',
  description:
    'Schedules a password-reset message for the account matching the email ' +
    'address without creating identities. The response is identical whether ' +
    'or not the address is registered, so it cannot be used for account ' +
    'enumeration.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: RequestPasswordResetRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: RequestPasswordResetResultSchema } },
      description: 'The request was accepted.',
    },
    ...problemResponses('Request failure as RFC 9457 Problem Details.'),
  },
});

export const checkPasswordResetRoute = createRoute({
  method: 'post',
  path: '/auth/check-password-reset',
  operationId: 'checkPasswordReset',
  summary: 'Check a password-reset action',
  description:
    'Checks whether a password-reset token is current without consuming or mutating it. ' +
    'Unknown, expired, and already consumed actions return `valid: false`. Responses never ' +
    'include token material and are never cached.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: CheckPasswordResetRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CheckPasswordResetResultSchema } },
      description: 'Whether the password-reset action is current.',
    },
    ...problemResponses('Check failure as RFC 9457 Problem Details.'),
  },
});

export const resetPasswordRoute = createRoute({
  method: 'post',
  path: '/auth/reset-password',
  operationId: 'resetPassword',
  summary: 'Complete password reset',
  description:
    'Sets a new password from the token delivered by the password-reset ' +
    'action. Reset actions are single use and expire. Successful resets ' +
    'revoke existing sessions. Invalid, expired, reused, or malformed ' +
    'actions fail safely without revealing token material.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: ResetPasswordRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: ResetPasswordResultSchema } },
      description: 'The password was reset.',
    },
    ...problemResponses('Reset failure as RFC 9457 Problem Details.'),
  },
});

export const adminMeRoute = createRoute({
  method: 'get',
  path: '/admin/me',
  operationId: 'getAdminMe',
  summary: 'Resolve the current administrator',
  description:
    'Returns the exact administrative representation for the session carried ' +
    'by the request cookies when that session holds User listing/read access. ' +
    'Anonymous or invalid sessions receive the standard unauthenticated ' +
    'Problem Details response; valid non-administrative sessions receive the ' +
    'forbidden Problem Details response. The public `/v1/me` representation ' +
    'is unchanged by this operation.',
  tags: ['admin'],
  responses: {
    200: {
      content: { 'application/json': { schema: AdminMeSchema } },
      description: 'The authenticated administrator.',
    },
    ...problemResponses('Authorization failure as RFC 9457 Problem Details.'),
  },
});

export const adminAdministratorsRoute = createRoute({
  method: 'get',
  path: '/admin/administrators',
  operationId: 'listAdminAdministrators',
  summary: 'List Administrators',
  description:
    'Returns safe application-owned Administrator metadata and access state in ascending email order.',
  tags: ['admin'],
  request: { query: AdminAdministratorListQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAdministratorListSchema } },
      description: 'The matching Administrators and their total.',
    },
    ...problemResponses('Authorization failure as RFC 9457 Problem Details.'),
  },
});

export const adminAdministratorDetailRoute = createRoute({
  method: 'get',
  path: '/admin/administrators/{administratorId}',
  operationId: 'getAdminAdministrator',
  summary: 'Read one Administrator',
  tags: ['admin'],
  request: { params: AdminAdministratorParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAdministratorDetailSchema } },
      description: 'The matching Administrator detail.',
    },
    ...problemResponses('Authorization or lookup failure as RFC 9457 Problem Details.'),
  },
});

export const adminAdministratorActivityRoute = createRoute({
  method: 'get',
  path: '/admin/administrators/{administratorId}/activity',
  operationId: 'getAdminAdministratorActivity',
  summary: 'Read Administrator lifecycle activity',
  tags: ['admin'],
  request: {
    params: AdminAdministratorParamsSchema,
    query: AdminAdministratorActivityQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAdministratorActivitySchema } },
      description: 'The Administrator lifecycle activity page.',
    },
    ...problemResponses('Authorization, lookup, or cursor failure as RFC 9457 Problem Details.'),
  },
});

export const adminAdministratorAccessRoute = createRoute({
  method: 'put',
  path: '/admin/administrators/{administratorId}/access',
  operationId: 'setAdminAdministratorAccess',
  summary: 'Set Administrator access',
  description:
    'Atomically disables or rehabilitates another Administrator using a strong revision precondition.',
  tags: ['admin'],
  request: {
    params: AdminAdministratorParamsSchema,
    headers: adminAdministratorIfMatchHeaders,
    body: { content: { 'application/json': { schema: AdminAdministratorAccessRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAdministratorAccessResultSchema } },
      description: 'The committed Administrator access state.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminAdministratorVerificationMessageRoute = createRoute({
  method: 'post',
  path: '/admin/administrators/{administratorId}/email-verification/messages',
  operationId: 'requestAdminAdministratorEmailVerificationMessage',
  summary: 'Schedule an Administrator verification message',
  description:
    'Schedules verification for another Administrator, including a disabled account, without ' +
    'changing access or exposing a token, action URL or delivery result.',
  tags: ['admin'],
  request: {
    params: AdminAdministratorParamsSchema,
    headers: adminAdministratorMessageHeaders,
    body: {
      content: { 'application/json': { schema: AdminAdministratorMessageRequestSchema } },
    },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAdministratorMessageSchema } },
      description: 'Verification is already complete; no message was sent.',
    },
    202: {
      content: { 'application/json': { schema: AdminAdministratorMessageSchema } },
      description: 'The verification message was accepted for scheduling.',
    },
    ...adminAdministratorMessageResponses,
  },
});

export const adminAdministratorPasswordRecoveryMessageRoute = createRoute({
  method: 'post',
  path: '/admin/administrators/{administratorId}/password-recovery/messages',
  operationId: 'requestAdminAdministratorPasswordRecoveryMessage',
  summary: 'Schedule an Administrator password recovery message',
  description:
    'Schedules normal password recovery for another Administrator with a usable credential, ' +
    'including a disabled account, without changing access or exposing secrets.',
  tags: ['admin'],
  request: {
    params: AdminAdministratorParamsSchema,
    headers: adminAdministratorMessageHeaders,
    body: {
      content: { 'application/json': { schema: AdminAdministratorMessageRequestSchema } },
    },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: AdminAdministratorMessageSchema } },
      description: 'The recovery message was accepted for scheduling.',
    },
    ...adminAdministratorMessageResponses,
  },
});

export const adminAuditEventsRoute = createRoute({
  method: 'get',
  path: '/admin/audit-events',
  operationId: 'listAdminAuditEvents',
  summary: 'Read global Administrative Audit',
  description:
    'Returns allowlisted authenticated Administrator commands newest-first from the Event Ledger. ' +
    'It is distinct from Reader Account Activity and never returns personal or secret data.',
  tags: ['admin'],
  request: { query: AdminAuditEventsQuerySchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminAuditEventsSchema } },
      description: 'The filtered Administrative Audit page.',
    },
    400: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Invalid filters or cursor.',
    },
    401: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'No authoritative Administrator session.',
    },
    403: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'The actor is disabled or lacks Administrator authority.',
    },
    500: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'The audit projection could not be completed.',
    },
    ...problemResponses('Authorization failure as RFC 9457 Problem Details.'),
  },
});

export const adminUsersRoute = createRoute({
  method: 'get',
  path: '/admin/users',
  operationId: 'listAdminUsers',
  summary: 'List Users for administrators',
  description:
    'Returns the stable application-owned administrative User representation ' +
    'in ascending email order with bounded server pagination and optional ' +
    'case-insensitive literal email substring search. Anonymous or invalid ' +
    'sessions receive the standard unauthenticated Problem Details response; ' +
    'valid non-administrative sessions receive the forbidden Problem Details ' +
    'response. The `total` counts all matches before pagination.',
  tags: ['admin'],
  request: {
    query: AdminUserListQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminUserListSchema } },
      description: 'The matching administrative Users and their total.',
    },
    ...problemResponses('Authorization failure as RFC 9457 Problem Details.'),
  },
});

export const adminUserDetailRoute = createRoute({
  method: 'get',
  path: '/admin/users/{userId}',
  operationId: 'getAdminUser',
  summary: 'Read one User for administrators',
  description:
    'Returns the stable application-owned administrative User representation ' +
    'for one opaque identifier. Anonymous or invalid sessions receive the ' +
    'standard unauthenticated Problem Details response; valid ' +
    'non-administrative sessions receive the forbidden Problem Details ' +
    'response even when the identifier does not exist. Authorized missing ' +
    'Users receive the not-found Problem Details response.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderDetailSchema } },
      description: 'The matching administrative User.',
    },
    ...problemResponses('Authorization failure as RFC 9457 Problem Details.'),
  },
});

export const adminReaderActivityRoute = createRoute({
  method: 'get',
  path: '/admin/users/{userId}/activity',
  operationId: 'getAdminReaderActivity',
  summary: 'Read Reader lifecycle activity',
  description:
    'Returns only allowlisted successful lifecycle events in newest-first order. Existing ' +
    'history is not backfilled, routine login/logout is excluded, and cursors are opaque.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    query: AdminReaderActivityQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderActivitySchema } },
      description: 'The Reader lifecycle activity page.',
    },
    400: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Invalid parameters or cursor.',
    },
    401: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'No authoritative Administrator session.',
    },
    403: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'The actor lacks authority or is disabled.',
    },
    404: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Reader not found.',
    },
    500: {
      content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
      description: 'Internal failure.',
    },
  },
});

const adminReaderSessionResponses = {
  400: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Invalid session selector, cursor, or page size.',
  },
  401: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'No authoritative Administrator session.',
  },
  403: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The Administrator is forbidden or disabled.',
  },
  404: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Reader not found.',
  },
  500: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The request could not be completed or audited.',
  },
} as const;

export const adminReaderSessionsRoute = createRoute({
  method: 'get',
  path: '/admin/users/{userId}/sessions',
  operationId: 'listAdminReaderSessions',
  summary: 'List active Reader sessions',
  description:
    'Returns only active, nonexpired Reader sessions using opaque selectors and a newest-first cursor. ' +
    'Session tokens and connection/device metadata are never exposed.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    query: AdminReaderSessionsQuerySchema,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderSessionsSchema } },
      description: 'The active Reader session page.',
    },
    ...adminReaderSessionResponses,
  },
});

export const adminReaderSessionRevokeRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{userId}/sessions/{sessionId}',
  operationId: 'revokeAdminReaderSession',
  summary: 'Revoke one Reader session',
  description:
    'Revokes one session belonging to the target Reader. Missing and foreign selectors are indistinguishable no-ops. No If-Match or Idempotency-Key is required.',
  tags: ['admin'],
  request: { params: AdminReaderSessionParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderSessionRevocationSchema } },
      description: 'The current Reader access state and whether a session was revoked.',
    },
    ...adminReaderSessionResponses,
  },
});

export const adminReaderSessionsRevokeAllRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{userId}/sessions',
  operationId: 'revokeAllAdminReaderSessions',
  summary: 'Revoke all Reader sessions',
  description:
    'Revokes all active Reader sessions without changing account access or preventing future login. No If-Match or Idempotency-Key is required.',
  tags: ['admin'],
  request: { params: AdminUserDetailParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderSessionRevocationSchema } },
      description: 'The current Reader access state and whether any sessions were revoked.',
    },
    ...adminReaderSessionResponses,
  },
});

export const adminReaderAccessRoute = createRoute({
  method: 'put',
  path: '/admin/users/{userId}/access',
  operationId: 'updateAdminReaderAccess',
  summary: 'Disable or rehabilitate Reader access',
  description:
    'Changes the Reader access state with its account revision precondition. Disabling revokes all ' +
    'Reader sessions; rehabilitation permits future sign-in but never restores revoked sessions. ' +
    'An active deletion request blocks this independent access transition.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderIfMatchHeaders,
    body: { content: { 'application/json': { schema: AdminReaderAccessRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderAccessResultSchema } },
      description: 'The current or changed Reader access state.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminReaderSocialIdentityUnlinkRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{userId}/social-identities/{associationId}',
  operationId: 'unlinkAdminReaderSocialIdentity',
  summary: 'Unlink one local Reader social identity',
  description:
    'Removes one local association and its credentials, revokes Reader sessions, advances the account revision and records audit/lifecycle events atomically. No remote provider revocation is performed.',
  tags: ['admin'],
  request: {
    params: AdminReaderSocialIdentityParamsSchema,
    headers: adminReaderSocialIdentityHeaders,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderSocialIdentityUnlinkSchema } },
      description: 'The association was removed or was already absent.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminReaderEmailVerificationRoute = createRoute({
  method: 'put',
  path: '/admin/users/{userId}/email-verification',
  operationId: 'forceAdminReaderEmailVerification',
  summary: 'Force the canonical Reader email verified',
  description:
    'Marks only the current canonical Reader email verified and invalidates pending ' +
    'verification actions. It never sends mail or revokes Reader sessions.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderIfMatchHeaders,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderEmailVerificationSchema } },
      description: 'The current canonical email verification state.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminReaderVerificationMessageRoute = createRoute({
  method: 'post',
  path: '/admin/users/{userId}/email-verification/messages',
  operationId: 'requestAdminReaderEmailVerificationMessage',
  summary: 'Schedule a Reader verification message',
  description:
    'Schedules a new verification message for an unverified Reader email without ' +
    'exposing a token, action URL or delivery result.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderMessageHeaders,
    body: { content: { 'application/json': { schema: AdminReaderMessageRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: AdminReaderMessageSchema } },
      description: 'The verification message was accepted for scheduling.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminReaderPasswordRecoveryMessageRoute = createRoute({
  method: 'post',
  path: '/admin/users/{userId}/password-recovery/messages',
  operationId: 'requestAdminReaderPasswordRecoveryMessage',
  summary: 'Schedule a Reader password recovery message',
  description:
    'Schedules normal password recovery only for a Reader with a usable credential ' +
    'method. The Administrator never receives or sets the password.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderMessageHeaders,
    body: { content: { 'application/json': { schema: AdminReaderMessageRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: AdminReaderMessageSchema } },
      description: 'The recovery message was accepted for scheduling.',
    },
    ...adminReaderCommandResponses,
  },
});

export const adminReaderEmailChangeRoute = createRoute({
  method: 'post',
  path: '/admin/users/{userId}/email-changes',
  operationId: 'startAdminReaderEmailChange',
  summary: 'Create or replace a pending Reader email change',
  description:
    'Reserves a normalized email for an active Reader and schedules verification to the new ' +
    'address plus a notice to the current address. The canonical email remains unchanged until ' +
    'the public verification action completes.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderEmailChangeCreateHeaders,
    body: { content: { 'application/json': { schema: AdminReaderEmailChangeRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderEmailChangeSchema } },
      description: 'An existing pending email-change workflow was replaced.',
    },
    201: {
      content: { 'application/json': { schema: AdminReaderEmailChangeSchema } },
      description: 'A new email-change workflow was created.',
    },
    ...adminReaderEmailChangeResponses,
  },
});

export const adminReaderEmailChangeMessageRoute = createRoute({
  method: 'post',
  path: '/admin/users/{userId}/email-changes/{emailChangeId}/messages',
  operationId: 'resendAdminReaderEmailChangeMessage',
  summary: 'Resend a pending Reader email-change message',
  description:
    'Rotates the verification token and schedules the verification and current-address notice ' +
    'for a pending Reader email-change workflow.',
  tags: ['admin'],
  request: {
    params: AdminReaderEmailChangeParamsSchema,
    headers: adminReaderMessageHeaders,
    body: { content: { 'application/json': { schema: AdminReaderEmailChangeCommandSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: AdminReaderEmailChangeMessageSchema } },
      description: 'The email-change messages were accepted for scheduling.',
    },
    ...adminReaderEmailChangeResponses,
  },
});

export const adminReaderEmailChangeCancelRoute = createRoute({
  method: 'delete',
  path: '/admin/users/{userId}/email-changes/{emailChangeId}',
  operationId: 'cancelAdminReaderEmailChange',
  summary: 'Cancel a pending Reader email change',
  description:
    'Cancels a pending email-change workflow with its workflow revision precondition and releases ' +
    'the email reservation.',
  tags: ['admin'],
  request: {
    params: AdminReaderEmailChangeParamsSchema,
    headers: adminReaderEmailChangeWorkflowHeaders,
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderEmailChangeCancelSchema } },
      description: 'The current or newly cancelled workflow state.',
    },
    ...adminReaderEmailChangeResponses,
  },
});

const adminReaderDeletionRequestResponses = {
  400: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Invalid request or note.',
  },
  401: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'No authoritative Administrator session.',
  },
  403: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The actor is not authorized or is disabled.',
  },
  404: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'Reader or deletion request not found.',
  },
  409: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'An active request exists or the requested state transition is invalid.',
  },
  412: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The supplied account or workflow revision is stale.',
  },
  428: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'A required If-Match or Idempotency-Key header is missing.',
  },
  500: {
    content: { 'application/problem+json': { schema: IdentityProblemDetailsSchema } },
    description: 'The command could not be audited or completed.',
  },
} as const;

export const adminReaderDeletionRequestRoute = createRoute({
  method: 'post',
  path: '/admin/users/{userId}/deletion-requests',
  operationId: 'createAdminReaderDeletionRequest',
  summary: 'Create a Reader deletion request for review',
  description:
    'Snapshots the Reader access state, immediately suspends effective access, revokes Reader ' +
    'sessions and atomically records the request, Event Ledger lifecycle event, audit event and ' +
    'idempotency result. The optional note is stored only on the request, never in ledger ' +
    'metadata. No email is sent.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    headers: adminReaderDeletionCreateHeaders,
    body: { content: { 'application/json': { schema: AdminReaderDeletionRequestCreateSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: AdminReaderDeletionRequestSchema } },
      description: 'A pending review request was created and effective access suspended.',
    },
    ...adminReaderDeletionRequestResponses,
  },
});

export const adminReaderDeletionRequestStatusRoute = createRoute({
  method: 'put',
  path: '/admin/users/{userId}/deletion-requests/{requestId}/status',
  operationId: 'transitionAdminReaderDeletionRequest',
  summary: 'Review or cancel a Reader deletion request',
  description:
    'Transitions pending_review to approved, rejected or cancelled, and permits approved to be ' +
    'cancelled while no material deletion exists. Rejecting or cancelling restores the exact ' +
    'snapshotted access state. Approval/rejection require an administrative note; notes are ' +
    'stored only on the request and never copied to the Event Ledger.',
  tags: ['admin'],
  request: {
    params: AdminReaderDeletionRequestParamsSchema,
    headers: adminReaderDeletionTransitionHeaders,
    body: { content: { 'application/json': { schema: AdminReaderDeletionRequestStatusSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AdminReaderDeletionRequestTransitionSchema } },
      description:
        'The deletion request transitioned or the current same-state result was replayed.',
    },
    ...adminReaderDeletionRequestResponses,
  },
});

export const adminUserAccountDetailsRoute = createRoute({
  method: 'get',
  path: '/admin/users/{userId}/account-details',
  operationId: 'getAdminUserAccountDetails',
  summary: 'Read one User’s Account Details for administrators',
  description:
    'Returns only the selected User’s optional Account Details to an authorized Administrator. ' +
    'Anonymous or invalid sessions receive 401; non-administrators receive 403 before target ' +
    'existence is disclosed; authorized missing Users receive 404.',
  tags: ['admin'],
  request: { params: AdminUserDetailParamsSchema },
  responses: {
    200: {
      content: { 'application/json': { schema: AccountDetailsSchema } },
      description: 'The selected User’s Account Details.',
    },
    ...problemResponses('Authorization or lookup failure as RFC 9457 Problem Details.'),
  },
});

export const updateAdminUserAccountDetailsRoute = createRoute({
  method: 'patch',
  path: '/admin/users/{userId}/account-details',
  operationId: 'updateAdminUserAccountDetails',
  summary: 'Update one User’s Account Details for administrators',
  description:
    'Atomically updates only allowlisted Account Details for the selected User. ' +
    'Unknown or Identity-owned fields reject the entire request.',
  tags: ['admin'],
  request: {
    params: AdminUserDetailParamsSchema,
    body: { content: { 'application/json': { schema: UpdateAccountDetailsSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: AccountDetailsSchema } },
      description: 'The selected User’s updated Account Details.',
    },
    ...problemResponses('Validation, authorization or lookup failure as RFC 9457 Problem Details.'),
  },
});

export const adminBootstrapRoute = createRoute({
  method: 'post',
  path: '/admin/auth/bootstrap',
  operationId: 'bootstrapAdministrator',
  summary: 'Bootstrap the first administrator',
  description:
    'Creates the first administrative User through the auth engine after ' +
    'migrations, using explicit operator-supplied credentials. Succeeds only ' +
    'while no administrator exists; repeats and conflicting identities fail ' +
    'with stable machine codes instead of duplicating privileged accounts. ' +
    'The bootstrapped administrator remains subject to the deployment email ' +
    'verification policy before signing in. Creation schedules its first ' +
    'verification message; delivery failure does not undo the administrator. ' +
    'A concurrent active bootstrap may return a retryable 409 while its lease ' +
    'is still held.',
  tags: ['identity'],
  request: {
    body: { content: { 'application/json': { schema: AdminBootstrapRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: AdminBootstrapResultSchema } },
      description: 'The first administrator was created and verification was requested.',
    },
    ...problemResponses('Bootstrap failure as RFC 9457 Problem Details.'),
  },
});

// Deprecated compatibility alias retained for existing bootstrap clients. It
// is explicitly Admin-scoped by its path and uses only the Admin realm; new
// tools use /v1/admin/auth/bootstrap.
export const adminBootstrapLegacyRoute = createRoute({
  method: 'post',
  path: '/auth/admin/bootstrap',
  operationId: 'bootstrapAdmin',
  summary: 'Bootstrap the first administrator (deprecated path)',
  description:
    'Deprecated compatibility alias for POST /v1/admin/auth/bootstrap. The request, authorization, ' +
    'first-Administrator claim and storage all belong exclusively to the Administrator realm.',
  tags: ['admin'],
  request: {
    body: { content: { 'application/json': { schema: AdminBootstrapRequestSchema } } },
  },
  responses: {
    201: {
      content: { 'application/json': { schema: AdminBootstrapResultSchema } },
      description: 'The first Administrator was created and verification was requested.',
    },
    ...problemResponses('Bootstrap failure as RFC 9457 Problem Details.'),
  },
});

export const adminLoginRoute = createRoute({
  method: 'post',
  path: '/admin/auth/login',
  operationId: 'loginAdministrator',
  summary: 'Establish an Administrator session',
  tags: ['admin'],
  request: { body: { content: { 'application/json': { schema: LoginRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: LoginResultSchema } },
      description: 'Authenticated.',
    },
    ...problemResponses('Administrator authentication failure.'),
  },
});

export const adminSignOutRoute = createRoute({
  method: 'post',
  path: '/admin/auth/sign-out',
  operationId: 'signOutAdministrator',
  summary: 'Invalidate the current Administrator session',
  tags: ['admin'],
  responses: {
    200: {
      content: { 'application/json': { schema: SignOutResultSchema } },
      description: 'Signed out.',
    },
    ...problemResponses('Administrator sign-out failure.'),
  },
});

export const adminVerifyEmailRoute = createRoute({
  method: 'post',
  path: '/admin/auth/verify-email',
  operationId: 'verifyAdministratorEmail',
  summary: 'Complete Administrator email verification',
  tags: ['admin'],
  request: { body: { content: { 'application/json': { schema: VerifyEmailRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: VerifyEmailResultSchema } },
      description: 'Verified.',
    },
    ...problemResponses('Verification failure.'),
  },
});

export const adminRequestVerificationRoute = createRoute({
  method: 'post',
  path: '/admin/auth/request-verification',
  operationId: 'requestAdministratorVerification',
  summary: 'Request Administrator email verification',
  tags: ['admin'],
  request: {
    body: { content: { 'application/json': { schema: RequestVerificationRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: RequestVerificationResultSchema } },
      description: 'Accepted.',
    },
    ...problemResponses('Verification request failure.'),
  },
});

export const adminRequestPasswordResetRoute = createRoute({
  method: 'post',
  path: '/admin/auth/request-password-reset',
  operationId: 'requestAdministratorPasswordReset',
  summary: 'Request Administrator password recovery',
  tags: ['admin'],
  request: {
    body: { content: { 'application/json': { schema: RequestPasswordResetRequestSchema } } },
  },
  responses: {
    202: {
      content: { 'application/json': { schema: RequestPasswordResetResultSchema } },
      description: 'Accepted.',
    },
    ...problemResponses('Password reset request failure.'),
  },
});

export const adminCheckPasswordResetRoute = createRoute({
  method: 'post',
  path: '/admin/auth/check-password-reset',
  operationId: 'checkAdministratorPasswordReset',
  summary: 'Check an Administrator password-reset action',
  tags: ['admin'],
  request: {
    body: { content: { 'application/json': { schema: CheckPasswordResetRequestSchema } } },
  },
  responses: {
    200: {
      content: { 'application/json': { schema: CheckPasswordResetResultSchema } },
      description: 'Token status.',
    },
    ...problemResponses('Password reset check failure.'),
  },
});

export const adminResetPasswordRoute = createRoute({
  method: 'post',
  path: '/admin/auth/reset-password',
  operationId: 'resetAdministratorPassword',
  summary: 'Complete Administrator password reset',
  tags: ['admin'],
  request: { body: { content: { 'application/json': { schema: ResetPasswordRequestSchema } } } },
  responses: {
    200: {
      content: { 'application/json': { schema: ResetPasswordResultSchema } },
      description: 'Password reset.',
    },
    ...problemResponses('Password reset failure.'),
  },
});
