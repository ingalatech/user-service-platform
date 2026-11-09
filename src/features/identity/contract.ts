import { z } from '@hono/zod-openapi';
import { PasswordPolicySchema } from './password-policy.js';

export type { PasswordPolicy } from './password-policy.js';
export { PasswordPolicySchema } from './password-policy.js';

// Application-owned identity contracts (ADR-0002, ADR-0007). These schemas
// are the single source for runtime validation, TypeScript inference and the
// generated OpenAPI document. They never expose Better Auth models, session
// tokens, password material or D1 row representations (ticket #10).
const emailField = z
  .email({ error: 'Expected an email address.' })
  .max(254)
  .openapi({ example: 'ada@example.com' });

const passwordField = z
  .string()
  .min(1, { error: 'Password must not be empty.' })
  .max(128, { error: 'Password must be at most 128 characters.' })
  .openapi({ example: 'Correct-horse-41' });

const adminReaderSessionSelector = z
  .string()
  .min(42)
  .max(211)
  .regex(/^s1_[A-Za-z0-9_-]+$/);

export const AuthConfigSchema = z
  .object({
    capabilities: z
      .object({
        registration: z.boolean(),
        emailPassword: z.boolean(),
        emailVerification: z.boolean(),
        passwordReset: z.boolean(),
      })
      .openapi('AuthCapabilities'),
    passwordPolicy: PasswordPolicySchema,
  })
  .openapi('AuthConfig');

export const RegisterRequestSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(200)
      .regex(/\S/, { error: 'Name must contain a non-whitespace character.' })
      .optional()
      .openapi({ example: 'Ada Lovelace' }),
    email: emailField,
    password: passwordField,
  })
  .superRefine((input, context) => {
    if (input.name === undefined && input.email.slice(0, input.email.indexOf('@')).length > 200) {
      context.addIssue({
        code: 'custom',
        path: ['email'],
        message: 'Email local-part is too long when name is omitted.',
      });
    }
  })
  .openapi('RegisterRequest');

export const RegisterWithoutNameRequestSchema = z
  .object({
    email: emailField,
    password: passwordField,
  })
  .strict()
  .openapi('RegisterWithoutNameRequest');

export const RegisteredUserSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: false }),
  })
  .openapi('RegisteredUser');

export const LoginRequestSchema = z
  .object({
    email: emailField,
    password: z.string().min(1).max(128).openapi({ example: 'Correct-horse-41' }),
  })
  .openapi('LoginRequest');

export const LoginResultSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: true }),
  })
  .openapi('LoginResult');

export const VerifyEmailRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'Verification token from the action URL.' }),
  })
  .openapi('VerifyEmailRequest');

export const VerifyEmailResultSchema = z
  .object({
    // The engine confirms verification with `{ status: true }` and no user
    // payload on this path, so the result carries only the externally
    // observable outcome. Changed login eligibility (proven by a subsequent
    // login) is the identity signal, not an engine echo.
    emailVerified: z.literal(true).openapi({ example: true }),
  })
  .openapi('VerifyEmailResult');

export const RequestVerificationRequestSchema = z
  .object({
    email: emailField,
  })
  .openapi('RequestVerificationRequest');

export const RequestVerificationResultSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
  })
  .openapi('RequestVerificationResult');

export const CurrentUserSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: true }),
    realm: z.literal('reader').openapi({ example: 'reader' }),
  })
  .openapi('CurrentUser');

const accountDetailValue = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => (value.length === 0 ? null : value))
    .nullable();

const birthDateValue = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, { error: 'Expected a calendar date in YYYY-MM-DD format.' })
  .refine(
    (value) => {
      const [yearText, monthText, dayText] = value.split('-');
      const year = Number(yearText);
      const month = Number(monthText);
      const day = Number(dayText);
      if (year < 1 || month < 1 || month > 12) return false;
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysByMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
      const daysInMonth = daysByMonth[month - 1];
      return daysInMonth !== undefined && day >= 1 && day <= daysInMonth;
    },
    { error: 'Expected a real calendar date.' },
  )
  .nullable();

const imageValue = z
  .union([z.literal(''), z.url({ protocol: /^https$/ }).max(2048)])
  .transform((value) => (value === '' ? null : value))
  .nullable();

export const AccountDetailsSchema = z
  .object({
    firstName: z.string().max(100).nullable(),
    lastName: z.string().max(100).nullable(),
    birthDate: z.string().nullable(),
    phone: z.string().max(40).nullable(),
    image: z.string().max(2048).nullable(),
  })
  .openapi('AccountDetails');

export const UpdateAccountDetailsSchema = z
  .object({
    firstName: accountDetailValue(100).optional(),
    lastName: accountDetailValue(100).optional(),
    birthDate: birthDateValue.optional(),
    phone: accountDetailValue(40).optional(),
    image: imageValue.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, { error: 'At least one detail is required.' })
  .openapi('UpdateAccountDetails');

export const AccountPhotoIdParamsSchema = z
  .object({ photoId: z.uuid() })
  .openapi('AccountPhotoIdParams');

export type AccountDetails = z.infer<typeof AccountDetailsSchema>;
export type UpdateAccountDetails = z.infer<typeof UpdateAccountDetailsSchema>;

export const RequestPasswordResetRequestSchema = z
  .object({
    email: emailField,
  })
  .openapi('RequestPasswordResetRequest');

export const RequestPasswordResetResultSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
  })
  .openapi('RequestPasswordResetResult');

export const CheckPasswordResetRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'Password-reset token from the action URL.' }),
  })
  .openapi('CheckPasswordResetRequest');

export const CheckPasswordResetResultSchema = z
  .object({
    valid: z.boolean().openapi({ example: true }),
  })
  .openapi('CheckPasswordResetResult');

export const ResetPasswordRequestSchema = z
  .object({
    token: z
      .string()
      .min(1)
      .max(4096)
      .openapi({ description: 'Password-reset token from the action URL.' }),
    newPassword: passwordField,
  })
  .openapi('ResetPasswordRequest');

export const ResetPasswordResultSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
  })
  .openapi('ResetPasswordResult');

export const SignOutResultSchema = z
  .object({
    status: z.literal('ok').openapi({ example: 'ok' }),
  })
  .openapi('SignOutResult');

export const AdminMeSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: true }),
    realm: z.literal('administrator').openapi({ example: 'administrator' }),
    // The engine role as observed by the application-owned authorization
    // boundary (ticket #124). A plain string so future administrative roles
    // remain representable; only roles holding User listing/read access ever
    // reach this representation.
    role: z.string().openapi({ example: 'admin' }),
  })
  .openapi('AdminMe');

export const AdminAdministratorSchema = AdminMeSchema.extend({
  revision: z.number().int().min(1).openapi({ example: 1 }),
  access: z.object({ state: z.enum(['active', 'disabled']) }).openapi('AdminAdministratorAccess'),
}).openapi('AdminAdministrator');

export const AdminAdministratorListSchema = z
  .object({
    items: z.array(AdminAdministratorSchema).openapi({ description: 'Ascending email order.' }),
    total: z.number().int().min(0).openapi({ description: 'Matches before pagination.' }),
  })
  .openapi('AdminAdministratorList');

export const AdminAdministratorListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
    email: z.string().trim().min(1).max(254).optional(),
  })
  .openapi('AdminAdministratorListQuery');

export const AdminAdministratorMessageWorkflowSchema = z
  .object({
    kind: z.enum(['email-verification', 'password-recovery']),
    state: z.enum(['pending', 'scheduled', 'scheduling-failed']),
    cooldownUntil: z.iso.datetime(),
    lastScheduledAt: z.iso.datetime().nullable(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('AdminAdministratorMessageWorkflow');

export const AdminAdministratorDetailSchema = AdminAdministratorSchema.extend({
  summary: z.object({ createdAt: z.iso.datetime(), updatedAt: z.iso.datetime() }),
  methods: z.array(
    z.object({
      type: z.enum(['password', 'social']),
      provider: z.enum(['google', 'facebook', 'apple']).optional(),
    }),
  ),
  messageWorkflows: z
    .object({
      emailVerification: AdminAdministratorMessageWorkflowSchema.nullable(),
      passwordRecovery: AdminAdministratorMessageWorkflowSchema.nullable(),
    })
    .strict()
    .openapi({
      description:
        'Latest persisted workflow per message kind. A null value means no workflow has been requested.',
    }),
}).openapi('AdminAdministratorDetail');

export const AdminAdministratorParamsSchema = z
  .object({ administratorId: z.string().min(1).max(128) })
  .openapi('AdminAdministratorParams');

export const AdminAdministratorActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .openapi('AdminAdministratorActivityQuery');

export const AdminAdministratorActivitySchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        type: z.enum([
          'email-verified',
          'email-verification-requested',
          'password-recovery-requested',
          'sessions-revoked',
          'access-disabled',
          'access-rehabilitated',
        ]),
        occurredAt: z.iso.datetime(),
        actor: z.object({ id: z.string(), realm: z.literal('administrator') }),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi('AdminAdministratorActivity');

export const SocialIdentityUnlinkedMetadataSchema = z
  .object({
    associationId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    provider: z.enum(['google', 'facebook']),
    revision: z.number().int().min(1),
    revokedSessionCount: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('SocialIdentityUnlinkedMetadata');
export type SocialIdentityUnlinkedMetadata = z.infer<typeof SocialIdentityUnlinkedMetadataSchema>;

export const AdminAuditMetadataSchema = z
  .object({
    changed: z.boolean().optional(),
    operation: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/)
      .optional(),
    revision: SocialIdentityUnlinkedMetadataSchema.shape.revision.optional(),
    associationId: SocialIdentityUnlinkedMetadataSchema.shape.associationId.optional(),
    provider: SocialIdentityUnlinkedMetadataSchema.shape.provider.optional(),
    selector: adminReaderSessionSelector.optional(),
    count: z.number().int().min(0).optional(),
    revokedSessionCount: z.number().int().min(0).optional(),
    previousAccessState: z.enum(['active', 'disabled']).optional(),
    retryAfterSeconds: z.number().int().min(1).max(86_400).optional(),
    state: z
      .enum([
        'committed',
        'scheduling-failed',
        'pending_review',
        'approved',
        'rejected',
        'cancelled',
      ])
      .optional(),
    supersedesId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
    workflowId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/)
      .optional(),
  })
  .strict()
  .openapi('AdminAuditMetadata');

export const AdminAuditProblemCodeSchema = z
  .enum([
    'bad-request',
    'conflict',
    'payload-too-large',
    'service-unavailable',
    'not-found',
    'internal-error',
    'registration-disabled',
    'email-password-disabled',
    'email-verification-required',
    'invalid-credentials',
    'verification-invalid',
    'reset-invalid',
    'unauthenticated',
    'forbidden',
    'reader-not-found',
    'administrator-not-found',
    'administrator-disabled',
    'self-disable-forbidden',
    'last-operational-administrator',
    'invalid-transition',
    'no-usable-login-method',
    'idempotency-key-reused',
    'stale-revision',
    'precondition-required',
    'cooldown-active',
    'delivery-scheduling-failed',
    'admin-already-bootstrapped',
    'admin-bootstrap-in-progress',
    'admin-email-conflict',
    'same-email',
    'email-conflict',
    'email-change-not-found',
    'active-deletion-request',
    'deletion-request-not-found',
  ])
  .openapi('AdminAuditProblemCode');

export const AdminAuditEventsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(512).optional(),
    actorId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .openapi({ description: 'Filter by opaque Administrator actor ID.' }),
    action: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .optional()
      .openapi({ description: 'Filter by versioned Event Ledger type.' }),
    result: z.enum(['success', 'failure']).optional(),
    from: z.iso
      .datetime()
      .optional()
      .openapi({ description: 'Inclusive lower bound for event occurrence time.' }),
    to: z.iso
      .datetime()
      .optional()
      .openapi({ description: 'Inclusive upper bound for event occurrence time.' }),
  })
  .superRefine((query, context) => {
    if (
      query.from !== undefined &&
      query.to !== undefined &&
      Date.parse(query.from) > Date.parse(query.to)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['to'],
        message: 'The end time must not precede the start time.',
      });
    }
  })
  .openapi('AdminAuditEventsQuery');

export const AdminAuditEventSchema = z
  .object({
    id: z.string().min(1).max(128),
    version: z.number().int().min(1),
    type: z.string().min(1).max(128),
    occurredAt: z.iso.datetime(),
    actor: z.object({ id: z.string().min(1).max(128), realm: z.literal('administrator') }).strict(),
    subject: z
      .object({
        id: z.string().min(1).max(128),
        realm: z.enum(['reader', 'administrator']),
      })
      .strict()
      .nullable(),
    result: z.enum(['success', 'failure']),
    requestId: z.string().min(1).max(128),
    problemCode: AdminAuditProblemCodeSchema.nullable(),
    metadata: AdminAuditMetadataSchema.nullable(),
  })
  .strict()
  .openapi('AdminAuditEvent');

export const AdminAuditEventsSchema = z
  .object({
    items: z.array(AdminAuditEventSchema),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AdminAuditEvents');

export const AdminAdministratorAccessRequestSchema = z
  .object({ state: z.enum(['active', 'disabled']) })
  .strict()
  .openapi('AdminAdministratorAccessRequest');

export const AdminAdministratorAccessResultSchema = z
  .object({
    state: z.enum(['active', 'disabled']),
    changed: z.boolean(),
    revision: z.number().int().min(1),
  })
  .openapi('AdminAdministratorAccessResult');

export const AdminReaderAccessRequestSchema = z
  .object({ state: z.enum(['active', 'disabled']) })
  .strict()
  .openapi('AdminReaderAccessRequest');

export const AdminReaderAccessResultSchema = z
  .object({
    state: z.enum(['active', 'disabled']),
    changed: z.boolean(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminReaderAccessResult');

export const AdminBootstrapRequestSchema = z
  .object({
    name: z.string().min(1).max(200).openapi({ example: 'Ada Lovelace' }),
    email: emailField,
    password: passwordField,
  })
  .openapi('AdminBootstrapRequest');

export const AdminBootstrapResultSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    realm: z.literal('administrator').openapi({ example: 'administrator' }),
    // The only role this operation ever assigns. A literal (not a free
    // string) so consumers and the generated OpenAPI contract cannot mistake
    // bootstrap for general role management.
    role: z.literal('admin').openapi({ example: 'admin' }),
    emailVerified: z.boolean().openapi({ example: false }),
  })
  .openapi('AdminBootstrapResult');

export const AdminUserSchema = z
  .object({
    id: z.string().openapi({ example: 'abc123' }),
    email: emailField,
    emailVerified: z.boolean().openapi({ example: true }),
    realm: z.literal('reader').openapi({ example: 'reader' }),
    // The engine role as observed by the application-owned authorization
    // boundary (tickets #124/#125). A plain string so future administrative
    // roles remain representable; storage nulls never reach this contract.
    role: z.string().openapi({ example: 'user' }),
  })
  .openapi('AdminUser');

export const AdminReaderSocialIdentitySchema = z
  .object({
    associationId: z.uuid(),
    provider: z.enum(['google', 'facebook']),
    providerDisplayName: z.enum(['Google', 'Facebook', 'Social provider']),
    linkedAt: z.iso.datetime(),
    state: z.enum(['available', 'unavailable']),
  })
  .openapi('AdminReaderSocialIdentity');

export const AdminReaderDetailSchema = AdminUserSchema.extend({
  revision: z.number().int().min(1).openapi({ example: 1 }),
  summary: z
    .object({
      createdAt: z.iso.datetime(),
      updatedAt: z.iso.datetime(),
    })
    .openapi('AdminReaderSummary'),
  access: z
    .object({
      state: z.enum(['active', 'disabled']),
      effectiveState: z.enum(['active', 'disabled', 'suspended']),
    })
    .openapi('AdminReaderAccess'),
  deletionState: z.enum(['pending_review', 'approved']).nullable(),
  methods: z
    .array(
      z.object({
        type: z.enum(['password', 'social']),
        provider: z.enum(['google', 'facebook', 'apple']).optional(),
      }),
    )
    .openapi({ description: 'Safe locally usable login methods without provider identifiers.' }),
  socialIdentities: z
    .array(AdminReaderSocialIdentitySchema)
    .openapi('AdminReaderSocialIdentityList'),
  activeWorkflows: z
    .array(
      z.discriminatedUnion('type', [
        z.object({
          id: z.string(),
          type: z.literal('email-verification-message'),
          state: z.string(),
          createdAt: z.iso.datetime(),
          cooldownUntil: z.iso.datetime(),
        }),
        z.object({
          id: z.string(),
          type: z.literal('password-recovery-message'),
          state: z.string(),
          createdAt: z.iso.datetime(),
          cooldownUntil: z.iso.datetime(),
        }),
        z.object({
          id: z.string(),
          type: z.literal('deletion-request'),
          state: z.enum(['pending_review', 'approved']),
          createdAt: z.iso.datetime(),
          cooldownUntil: z.iso.datetime().optional(),
          revision: z.number().int().min(1),
          previousAccessState: z.enum(['active', 'disabled']),
        }),
        z.object({
          id: z.string(),
          type: z.literal('email-change'),
          state: z.literal('pending'),
          createdAt: z.iso.datetime(),
          email: emailField,
          expiresAt: z.iso.datetime(),
          cooldownUntil: z.iso.datetime(),
          revision: z.number().int().min(1),
        }),
      ]),
    )
    .openapi({ description: 'Only persisted active workflows; never inferred or fabricated.' }),
}).openapi('AdminReaderDetail');

export const AdminReaderSocialIdentityParamsSchema = z
  .object({
    userId: z.string().min(1).max(128),
    associationId: z.uuid(),
  })
  .strict()
  .openapi('AdminReaderSocialIdentityParams');

export const AdminReaderSocialIdentityUnlinkSchema = z
  .object({
    associationId: z.uuid(),
    changed: z.boolean(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminReaderSocialIdentityUnlink');
export type AdminReaderSocialIdentityUnlink = z.infer<typeof AdminReaderSocialIdentityUnlinkSchema>;

export const AdminReaderActivityQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .openapi('AdminReaderActivityQuery');

export const AdminReaderSessionSchema = z
  .object({
    selector: adminReaderSessionSelector,
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
  })
  .strict()
  .openapi('AdminReaderSession');

export const AdminReaderSessionsQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(50).default(25),
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict()
  .openapi('AdminReaderSessionsQuery');

export const AdminReaderSessionsSchema = z
  .object({
    items: z.array(AdminReaderSessionSchema),
    total: z.number().int().min(0),
    nextCursor: z.string().nullable(),
  })
  .strict()
  .openapi('AdminReaderSessions');

export const AdminReaderSessionParamsSchema = z
  .object({ userId: z.string().min(1).max(128), sessionId: adminReaderSessionSelector })
  .strict()
  .openapi('AdminReaderSessionParams');

export const AdminReaderSessionRevocationSchema = z
  .object({
    state: z.enum(['active', 'disabled', 'suspended']),
    revision: z.number().int().min(1),
    changed: z.boolean(),
  })
  .strict()
  .openapi('AdminReaderSessionRevocation');

export const ReaderSessionRevokedMetadataSchema = z
  .object({
    selector: adminReaderSessionSelector,
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('ReaderSessionRevokedMetadata');

export const ReaderAccessDisabledMetadataSchema = z
  .object({
    revision: z.number().int().min(1),
    revokedSessionCount: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('ReaderAccessDisabledMetadata');

export const ReaderDeletionRequestedMetadataSchema = z
  .object({
    workflowId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    previousAccessState: z.enum(['active', 'disabled']),
    revision: z.number().int().min(1),
    revokedSessionCount: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('ReaderDeletionRequestedMetadata');

export const ReaderEmailChangedMetadataSchema = z
  .object({
    workflowId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
    revision: z.number().int().min(1),
    revokedSessionCount: z.number().int().min(0).optional(),
  })
  .strict()
  .openapi('ReaderEmailChangedMetadata');

export const ReaderSessionsRevokedMetadataSchema = z
  .object({
    count: z.number().int().min(1),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('ReaderSessionsRevokedMetadata');

export const ReaderSessionsRevokeAttemptMetadataSchema = z
  .object({
    changed: z.boolean(),
    count: z.number().int().min(0),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('ReaderSessionsRevokeAttemptMetadata');

export const AdministratorMessageRequestedMetadataSchema = z
  .object({
    workflowId: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/),
  })
  .strict()
  .openapi('AdministratorMessageRequestedMetadata');

export const AdministratorMessageAttemptMetadataSchema = z
  .union([
    z.object({ changed: z.boolean() }).strict(),
    z.object({ retryAfterSeconds: z.number().int().min(1).max(86_400) }).strict(),
    z.object({ state: z.literal('scheduling-failed') }).strict(),
  ])
  .openapi('AdministratorMessageAttemptMetadata');

export const AdminReaderActivityEventSchema = z
  .object({
    id: z.string(),
    type: z.enum([
      'email-verified',
      'email-verification-requested',
      'password-recovery-requested',
      'email-change-requested',
      'email-change-cancelled',
      'email-changed',
      'social-identity-unlinked',
      'session-revoked',
      'sessions-revoked',
      'access-disabled',
      'access-rehabilitated',
      'deletion-requested',
      'deletion-approved',
      'deletion-rejected',
      'deletion-cancelled',
    ]),
    occurredAt: z.iso.datetime(),
    actor: z.object({ id: z.string(), realm: z.literal('administrator') }),
    metadata: z
      .union([
        SocialIdentityUnlinkedMetadataSchema,
        ReaderAccessDisabledMetadataSchema,
        ReaderDeletionRequestedMetadataSchema,
        ReaderEmailChangedMetadataSchema,
        ReaderSessionRevokedMetadataSchema,
        ReaderSessionsRevokedMetadataSchema,
      ])
      .nullable(),
  })
  .openapi('AdminReaderActivityEvent');

export const AdminReaderActivitySchema = z
  .object({
    items: z.array(AdminReaderActivityEventSchema),
    nextCursor: z.string().nullable(),
  })
  .openapi('AdminReaderActivity');

export const AdminReaderMessageRequestSchema = z
  .object({})
  .strict()
  .openapi('AdminReaderMessageRequest');

export const AdminReaderEmailVerificationSchema = z
  .object({
    email: emailField,
    emailVerified: z.boolean(),
    changed: z.boolean(),
    revision: z.number().int().min(1),
  })
  .openapi('AdminReaderEmailVerification');

export const AdminReaderMessageSchema = z
  .object({
    workflowId: z.string(),
    kind: z.enum(['email-verification', 'password-recovery']),
    state: z.literal('scheduled'),
    cooldownUntil: z.iso.datetime(),
    revision: z.number().int().min(1),
  })
  .openapi('AdminReaderMessage');

export const AdminReaderEmailChangeRequestSchema = z
  .object({ email: emailField })
  .strict()
  .openapi('AdminReaderEmailChangeRequest');

export const AdminReaderEmailChangeParamsSchema = z
  .object({
    userId: z.string().min(1).max(128),
    emailChangeId: z.string().min(1).max(128),
  })
  .openapi('AdminReaderEmailChangeParams');

export const AdminReaderEmailChangeCommandSchema = z
  .object({})
  .strict()
  .openapi('AdminReaderEmailChangeCommand');

export const AdminReaderEmailChangeSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    email: emailField,
    state: z.literal('pending'),
    changed: z.boolean(),
    revision: z.number().int().min(1),
    accountRevision: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    cooldownUntil: z.iso.datetime(),
  })
  .strict()
  .openapi('AdminReaderEmailChange');

export const AdminReaderEmailChangeCancelSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    state: z.enum(['pending', 'cancelled', 'completed', 'superseded', 'expired']),
    changed: z.boolean(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminReaderEmailChangeCancel');

export const AdminReaderEmailChangeMessageSchema = z
  .object({
    workflowId: z.string().min(1).max(128),
    state: z.literal('pending'),
    cooldownUntil: z.iso.datetime(),
    expiresAt: z.iso.datetime(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminReaderEmailChangeMessage');

export const AdminReaderDeletionRequestCreateSchema = z
  .object({ note: z.string().trim().min(1).max(2_000).optional() })
  .strict()
  .openapi('AdminReaderDeletionRequestCreate');

export const AdminReaderDeletionRequestParamsSchema = z
  .object({
    userId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
  })
  .strict()
  .openapi('AdminReaderDeletionRequestParams');

const AdminReaderDeletionNoteSchema = z.string().trim().min(1).max(2_000);

export const AdminReaderDeletionRequestStatusSchema = z
  .discriminatedUnion('state', [
    z
      .object({
        state: z.literal('pending_review'),
        note: AdminReaderDeletionNoteSchema.optional().openapi({
          description: 'Optional note, trimmed and limited to 2,000 characters by the service.',
        }),
      })
      .strict(),
    z
      .object({
        state: z.literal('approved'),
        note: AdminReaderDeletionNoteSchema.openapi({
          description:
            'Required for approval, trimmed and limited to 2,000 characters by the service.',
        }),
      })
      .strict(),
    z
      .object({
        state: z.literal('rejected'),
        note: AdminReaderDeletionNoteSchema.openapi({
          description:
            'Required for rejection, trimmed and limited to 2,000 characters by the service.',
        }),
      })
      .strict(),
    z
      .object({
        state: z.literal('cancelled'),
        note: AdminReaderDeletionNoteSchema.optional().openapi({
          description: 'Optional note, trimmed and limited to 2,000 characters by the service.',
        }),
      })
      .strict(),
  ])
  .openapi('AdminReaderDeletionRequestStatus');

export const AdminReaderDeletionRequestSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    state: z.literal('pending_review'),
    previousAccessState: z.enum(['active', 'disabled']),
    changed: z.literal(true),
    revision: z.number().int().min(1),
    accountRevision: z.number().int().min(1),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('AdminReaderDeletionRequest');

export const AdminReaderDeletionRequestTransitionSchema = z
  .object({
    requestId: z.string().min(1).max(128),
    state: z.enum(['pending_review', 'approved', 'rejected', 'cancelled']),
    previousAccessState: z.enum(['active', 'disabled']),
    changed: z.boolean(),
    revision: z.number().int().min(1),
    accountRevision: z.number().int().min(1),
    updatedAt: z.iso.datetime(),
  })
  .strict()
  .openapi('AdminReaderDeletionRequestTransition');

export const AdminAdministratorMessageRequestSchema = z
  .object({})
  .strict()
  .openapi('AdminAdministratorMessageRequest');

const AdminAdministratorMessageScheduledSchema = z
  .object({
    workflowId: z.string(),
    kind: z.enum(['email-verification', 'password-recovery']),
    state: z.literal('scheduled'),
    cooldownUntil: z.iso.datetime(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminAdministratorMessageScheduled');

export const AdminAdministratorMessageNoOpSchema = z
  .object({
    kind: z.literal('email-verification'),
    state: z.literal('verified'),
    changed: z.literal(false),
    cooldownUntil: z.iso.datetime().optional(),
    revision: z.number().int().min(1),
  })
  .strict()
  .openapi('AdminAdministratorMessageNoOp');

export const AdminAdministratorMessageSchema = z
  .union([AdminAdministratorMessageScheduledSchema, AdminAdministratorMessageNoOpSchema])
  .openapi('AdminAdministratorMessage');

export const AdminUserListSchema = z
  .object({
    items: z.array(AdminUserSchema).openapi({ description: 'Ascending email order.' }),
    total: z.number().int().min(0).openapi({
      description: 'Matches before pagination.',
      example: 42,
    }),
  })
  .openapi('AdminUserList');

// Query for the protected administrative User listing (ticket #125).
// Bounds are validated at the contract: limit 1..100 (default 25), offset
// nonnegative (default 0), email an optional trimmed nonempty literal
// substring of at most 254 characters. Violations end in the service-wide
// 400 Problem Details through the composition-root validation hook.
export const AdminUserListQuerySchema = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(25).openapi({ example: 25 }),
    offset: z.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
    email: z
      .string()
      .trim()
      .min(1)
      .max(254)
      .optional()
      .openapi({ description: 'Case-insensitive literal email substring.', example: 'ada' }),
  })
  .openapi('AdminUserListQuery');

// Path parameters for the protected administrative User detail (ticket #126).
// The identifier is an opaque nonempty bounded string (maximum 128
// characters), never an email or an assumed UUID shape. Violations end in the
// service-wide 400 Problem Details through the composition-root validation
// hook.
export const AdminUserDetailParamsSchema = z
  .object({
    userId: z.string().min(1).max(128).openapi({
      description: 'Opaque administrative User identifier.',
      example: 'abc123',
    }),
  })
  .openapi('AdminUserDetailParams');

// Reader State issue/refresh response (spec #195, ticket #196). Reader State
// is presentation-only and deliberately has no Bearer token type.
export const ReaderStateResponseSchema = z
  .object({
    readerState: z.string().min(1).openapi({
      description: 'Short-lived signed presentation-only Reader State.',
      example: 'eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhYmMxMjMifQ.sig',
    }),
    expiresAt: z.number().int().min(1).openapi({
      description: 'Reader State expiry as integer Unix seconds.',
      example: 1790000900,
    }),
  })
  .openapi('ReaderState');

// Public verification key entry (RFC 7517 JSON Web Key, public material
// only). Only asymmetric signature parameters are representable; private
// material never reaches this contract.
export const ConsumerJsonWebKeySchema = z
  .object({
    kid: z.string().min(1).openapi({ description: 'Stable durable key id.', example: 'abc123' }),
    kty: z.string().min(1).openapi({ description: 'Key type.', example: 'OKP' }),
    alg: z.string().min(1).openapi({ description: 'Fixed supported algorithm.', example: 'EdDSA' }),
    use: z.string().optional().openapi({ description: 'Intended use.', example: 'sig' }),
    crv: z.string().optional().openapi({ description: 'Curve name.', example: 'Ed25519' }),
    x: z.string().optional().openapi({ description: 'Public x coordinate.' }),
    y: z.string().optional().openapi({ description: 'Public y coordinate.' }),
    n: z.string().optional().openapi({ description: 'Public RSA modulus.' }),
    e: z.string().optional().openapi({ description: 'Public RSA exponent.' }),
  })
  .openapi('ConsumerJsonWebKey');

export const ConsumerJwksResponseSchema = z
  .object({
    keys: z.array(ConsumerJsonWebKeySchema).openapi({
      description: 'Active and retained public verification keys.',
    }),
  })
  .openapi('ConsumerJwks');

export type ReaderStateResponse = z.infer<typeof ReaderStateResponseSchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ConsumerJsonWebKey = z.infer<typeof ConsumerJsonWebKeySchema>;
export type ConsumerJwksResponse = z.infer<typeof ConsumerJwksResponseSchema>;

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisterWithoutNameRequest = z.infer<typeof RegisterWithoutNameRequestSchema>;
export type RegisteredUser = z.infer<typeof RegisteredUserSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;
export type VerifyEmailResult = z.infer<typeof VerifyEmailResultSchema>;
export type RequestVerificationRequest = z.infer<typeof RequestVerificationRequestSchema>;
export type RequestVerificationResult = z.infer<typeof RequestVerificationResultSchema>;
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequestSchema>;
export type RequestPasswordResetResult = z.infer<typeof RequestPasswordResetResultSchema>;
export type CheckPasswordResetRequest = z.infer<typeof CheckPasswordResetRequestSchema>;
export type CheckPasswordResetResult = z.infer<typeof CheckPasswordResetResultSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ResetPasswordResult = z.infer<typeof ResetPasswordResultSchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
export type SignOutResult = z.infer<typeof SignOutResultSchema>;
export type AdminMe = z.infer<typeof AdminMeSchema>;
export type AdminAdministrator = z.infer<typeof AdminAdministratorSchema>;
export type AdminAdministratorList = z.infer<typeof AdminAdministratorListSchema>;
export type AdminAdministratorListQuery = z.infer<typeof AdminAdministratorListQuerySchema>;
export type AdminAdministratorDetail = z.infer<typeof AdminAdministratorDetailSchema>;
export type AdminAdministratorActivity = z.infer<typeof AdminAdministratorActivitySchema>;
export type AdminAuditMetadata = z.infer<typeof AdminAuditMetadataSchema>;
export type AdminAuditProblemCode = z.infer<typeof AdminAuditProblemCodeSchema>;
export type AdminAuditEventsQuery = z.infer<typeof AdminAuditEventsQuerySchema>;
export type AdminAuditEvent = z.infer<typeof AdminAuditEventSchema>;
export type AdminAuditEvents = z.infer<typeof AdminAuditEventsSchema>;
export type AdminAdministratorAccessRequest = z.infer<typeof AdminAdministratorAccessRequestSchema>;
export type AdminAdministratorAccessResult = z.infer<typeof AdminAdministratorAccessResultSchema>;
export type AdminReaderAccessRequest = z.infer<typeof AdminReaderAccessRequestSchema>;
export type AdminReaderAccessResult = z.infer<typeof AdminReaderAccessResultSchema>;
export type AdminAdministratorMessageRequest = z.infer<
  typeof AdminAdministratorMessageRequestSchema
>;
export type AdminAdministratorMessage = z.infer<typeof AdminAdministratorMessageSchema>;
export type AdminBootstrapRequest = z.infer<typeof AdminBootstrapRequestSchema>;
export type AdminBootstrapResult = z.infer<typeof AdminBootstrapResultSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminReaderDetail = z.infer<typeof AdminReaderDetailSchema>;
export type AdminReaderActivity = z.infer<typeof AdminReaderActivitySchema>;
export type AdminReaderActivityQuery = z.infer<typeof AdminReaderActivityQuerySchema>;
export type AdminReaderEmailVerification = z.infer<typeof AdminReaderEmailVerificationSchema>;
export type AdminReaderMessage = z.infer<typeof AdminReaderMessageSchema>;
export type AdminReaderMessageRequest = z.infer<typeof AdminReaderMessageRequestSchema>;
export type AdminReaderEmailChangeRequest = z.infer<typeof AdminReaderEmailChangeRequestSchema>;
export type AdminReaderEmailChangeParams = z.infer<typeof AdminReaderEmailChangeParamsSchema>;
export type AdminReaderEmailChangeCommand = z.infer<typeof AdminReaderEmailChangeCommandSchema>;
export type AdminReaderEmailChange = z.infer<typeof AdminReaderEmailChangeSchema>;
export type AdminReaderEmailChangeCancel = z.infer<typeof AdminReaderEmailChangeCancelSchema>;
export type AdminReaderEmailChangeMessage = z.infer<typeof AdminReaderEmailChangeMessageSchema>;
export type AdminReaderDeletionRequestCreate = z.infer<
  typeof AdminReaderDeletionRequestCreateSchema
>;
export type AdminReaderDeletionRequestParams = z.infer<
  typeof AdminReaderDeletionRequestParamsSchema
>;
export type AdminReaderDeletionRequestStatus = z.infer<
  typeof AdminReaderDeletionRequestStatusSchema
>;
export type AdminReaderDeletionRequest = z.infer<typeof AdminReaderDeletionRequestSchema>;
export type AdminReaderDeletionRequestTransition = z.infer<
  typeof AdminReaderDeletionRequestTransitionSchema
>;
export type AdminUserList = z.infer<typeof AdminUserListSchema>;
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;
export type AdminUserDetailParams = z.infer<typeof AdminUserDetailParamsSchema>;
export type AdminReaderSessions = z.infer<typeof AdminReaderSessionsSchema>;
export type AdminReaderSession = z.infer<typeof AdminReaderSessionSchema>;
export type AdminReaderSessionsQuery = z.infer<typeof AdminReaderSessionsQuerySchema>;
export type AdminReaderSessionParams = z.infer<typeof AdminReaderSessionParamsSchema>;
export type AdminReaderSessionRevocation = z.infer<typeof AdminReaderSessionRevocationSchema>;
