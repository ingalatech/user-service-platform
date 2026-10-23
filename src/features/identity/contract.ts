import { z } from '@hono/zod-openapi';

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

export const PasswordPolicySchema = z
  .object({
    minLength: z.number().int().min(1).max(128).openapi({ example: 8 }),
    maxLength: z.number().int().min(1).max(128).openapi({ example: 128 }),
    minUppercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
    minLowercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
    minDigits: z.number().int().min(0).max(128).openapi({ example: 1 }),
    minSymbols: z.number().int().min(0).max(128).openapi({ example: 0 }),
  })
  .openapi('PasswordPolicy');

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
  })
  .openapi('CurrentUser');

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
    // The engine role as observed by the application-owned authorization
    // boundary (ticket #124). A plain string so future administrative roles
    // remain representable; only roles holding User listing/read access ever
    // reach this representation.
    role: z.string().openapi({ example: 'admin' }),
  })
  .openapi('AdminMe');

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
    // The engine role as observed by the application-owned authorization
    // boundary (tickets #124/#125). A plain string so future administrative
    // roles remain representable; storage nulls never reach this contract.
    role: z.string().openapi({ example: 'admin' }),
  })
  .openapi('AdminUser');

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
export type PasswordPolicy = z.infer<typeof PasswordPolicySchema>;
export type AuthConfig = z.infer<typeof AuthConfigSchema>;
export type ConsumerJsonWebKey = z.infer<typeof ConsumerJsonWebKeySchema>;
export type ConsumerJwksResponse = z.infer<typeof ConsumerJwksResponseSchema>;

export type RegisterRequest = z.infer<typeof RegisterRequestSchema>;
export type RegisteredUser = z.infer<typeof RegisteredUserSchema>;
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginResult = z.infer<typeof LoginResultSchema>;
export type VerifyEmailRequest = z.infer<typeof VerifyEmailRequestSchema>;
export type VerifyEmailResult = z.infer<typeof VerifyEmailResultSchema>;
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequestSchema>;
export type RequestPasswordResetResult = z.infer<typeof RequestPasswordResetResultSchema>;
export type CheckPasswordResetRequest = z.infer<typeof CheckPasswordResetRequestSchema>;
export type CheckPasswordResetResult = z.infer<typeof CheckPasswordResetResultSchema>;
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequestSchema>;
export type ResetPasswordResult = z.infer<typeof ResetPasswordResultSchema>;
export type CurrentUser = z.infer<typeof CurrentUserSchema>;
export type SignOutResult = z.infer<typeof SignOutResultSchema>;
export type AdminMe = z.infer<typeof AdminMeSchema>;
export type AdminBootstrapRequest = z.infer<typeof AdminBootstrapRequestSchema>;
export type AdminBootstrapResult = z.infer<typeof AdminBootstrapResultSchema>;
export type AdminUser = z.infer<typeof AdminUserSchema>;
export type AdminUserList = z.infer<typeof AdminUserListSchema>;
export type AdminUserListQuery = z.infer<typeof AdminUserListQuerySchema>;
export type AdminUserDetailParams = z.infer<typeof AdminUserDetailParamsSchema>;
