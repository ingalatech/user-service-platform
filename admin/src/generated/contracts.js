// src/features/identity/contract.ts
import { z as z2 } from "@hono/zod-openapi";

// src/features/identity/password-policy.ts
import { z } from "@hono/zod-openapi";

// src/features/identity/password-policy-rules.ts
var PASSWORD_POLICY_RULE_NAMES = [
  "min-length",
  "max-length",
  "min-uppercase",
  "min-lowercase",
  "min-digits",
  "min-symbols"
];
var PASSWORD_POLICY_RULE_DEFINITIONS = {
  "min-length": {
    policyKey: "minLength",
    comparison: "minimum",
    metric: "code-point-length",
    label: "characters"
  },
  "max-length": {
    policyKey: "maxLength",
    comparison: "maximum",
    metric: "code-point-length",
    label: "characters"
  },
  "min-uppercase": {
    policyKey: "minUppercase",
    comparison: "minimum",
    metric: "uppercase-letter",
    label: "uppercase letter(s)"
  },
  "min-lowercase": {
    policyKey: "minLowercase",
    comparison: "minimum",
    metric: "lowercase-letter",
    label: "lowercase letter(s)"
  },
  "min-digits": {
    policyKey: "minDigits",
    comparison: "minimum",
    metric: "decimal-digit",
    label: "digit(s)"
  },
  "min-symbols": {
    policyKey: "minSymbols",
    comparison: "minimum",
    metric: "symbol",
    label: "symbol(s)"
  }
};
var PASSWORD_POLICY_REQUIREMENTS = PASSWORD_POLICY_RULE_NAMES.map((rule) => ({
  rule,
  ...PASSWORD_POLICY_RULE_DEFINITIONS[rule]
}));

// src/features/identity/password-policy.ts
var PasswordPolicyRuleSchema = z.enum(PASSWORD_POLICY_RULE_NAMES);
var PasswordPolicyFieldsSchema = z.object({
  minLength: z.number().int(),
  maxLength: z.number().int(),
  minUppercase: z.number().int(),
  minLowercase: z.number().int(),
  minDigits: z.number().int(),
  minSymbols: z.number().int()
});
var PasswordPolicySchema = PasswordPolicyFieldsSchema.extend({
  minLength: z.number().int().min(1).max(128).openapi({ example: 8 }),
  maxLength: z.number().int().min(1).max(128).openapi({ example: 128 }),
  minUppercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minLowercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minDigits: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minSymbols: z.number().int().min(0).max(128).openapi({ example: 0 })
}).openapi("PasswordPolicy");

// src/features/identity/contract.ts
var emailField = z2.email({ error: "Expected an email address." }).max(254).openapi({ example: "ada@example.com" });
var passwordField = z2.string().min(1, { error: "Password must not be empty." }).max(128, { error: "Password must be at most 128 characters." }).openapi({ example: "Correct-horse-41" });
var AuthConfigSchema = z2.object({
  capabilities: z2.object({
    registration: z2.boolean(),
    emailPassword: z2.boolean(),
    emailVerification: z2.boolean(),
    passwordReset: z2.boolean()
  }).openapi("AuthCapabilities"),
  passwordPolicy: PasswordPolicySchema
}).openapi("AuthConfig");
var RegisterRequestSchema = z2.object({
  name: z2.string().min(1).max(200).regex(/\S/, { error: "Name must contain a non-whitespace character." }).optional().openapi({ example: "Ada Lovelace" }),
  email: emailField,
  password: passwordField
}).superRefine((input, context) => {
  if (input.name === void 0 && input.email.slice(0, input.email.indexOf("@")).length > 200) {
    context.addIssue({
      code: "custom",
      path: ["email"],
      message: "Email local-part is too long when name is omitted."
    });
  }
}).openapi("RegisterRequest");
var RegisteredUserSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  emailVerified: z2.boolean().openapi({ example: false })
}).openapi("RegisteredUser");
var LoginRequestSchema = z2.object({
  email: emailField,
  password: z2.string().min(1).max(128).openapi({ example: "Correct-horse-41" })
}).openapi("LoginRequest");
var LoginResultSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  emailVerified: z2.boolean().openapi({ example: true })
}).openapi("LoginResult");
var VerifyEmailRequestSchema = z2.object({
  token: z2.string().min(1).max(4096).openapi({ description: "Verification token from the action URL." })
}).openapi("VerifyEmailRequest");
var VerifyEmailResultSchema = z2.object({
  // The engine confirms verification with `{ status: true }` and no user
  // payload on this path, so the result carries only the externally
  // observable outcome. Changed login eligibility (proven by a subsequent
  // login) is the identity signal, not an engine echo.
  emailVerified: z2.literal(true).openapi({ example: true })
}).openapi("VerifyEmailResult");
var RequestVerificationRequestSchema = z2.object({
  email: emailField
}).openapi("RequestVerificationRequest");
var RequestVerificationResultSchema = z2.object({
  status: z2.literal("ok").openapi({ example: "ok" })
}).openapi("RequestVerificationResult");
var CurrentUserSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  emailVerified: z2.boolean().openapi({ example: true })
}).openapi("CurrentUser");
var RequestPasswordResetRequestSchema = z2.object({
  email: emailField
}).openapi("RequestPasswordResetRequest");
var RequestPasswordResetResultSchema = z2.object({
  status: z2.literal("ok").openapi({ example: "ok" })
}).openapi("RequestPasswordResetResult");
var CheckPasswordResetRequestSchema = z2.object({
  token: z2.string().min(1).max(4096).openapi({ description: "Password-reset token from the action URL." })
}).openapi("CheckPasswordResetRequest");
var CheckPasswordResetResultSchema = z2.object({
  valid: z2.boolean().openapi({ example: true })
}).openapi("CheckPasswordResetResult");
var ResetPasswordRequestSchema = z2.object({
  token: z2.string().min(1).max(4096).openapi({ description: "Password-reset token from the action URL." }),
  newPassword: passwordField
}).openapi("ResetPasswordRequest");
var ResetPasswordResultSchema = z2.object({
  status: z2.literal("ok").openapi({ example: "ok" })
}).openapi("ResetPasswordResult");
var SignOutResultSchema = z2.object({
  status: z2.literal("ok").openapi({ example: "ok" })
}).openapi("SignOutResult");
var AdminMeSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  emailVerified: z2.boolean().openapi({ example: true }),
  // The engine role as observed by the application-owned authorization
  // boundary (ticket #124). A plain string so future administrative roles
  // remain representable; only roles holding User listing/read access ever
  // reach this representation.
  role: z2.string().openapi({ example: "admin" })
}).openapi("AdminMe");
var AdminBootstrapRequestSchema = z2.object({
  name: z2.string().min(1).max(200).openapi({ example: "Ada Lovelace" }),
  email: emailField,
  password: passwordField
}).openapi("AdminBootstrapRequest");
var AdminBootstrapResultSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  // The only role this operation ever assigns. A literal (not a free
  // string) so consumers and the generated OpenAPI contract cannot mistake
  // bootstrap for general role management.
  role: z2.literal("admin").openapi({ example: "admin" }),
  emailVerified: z2.boolean().openapi({ example: false })
}).openapi("AdminBootstrapResult");
var AdminUserSchema = z2.object({
  id: z2.string().openapi({ example: "abc123" }),
  email: emailField,
  emailVerified: z2.boolean().openapi({ example: true }),
  // The engine role as observed by the application-owned authorization
  // boundary (tickets #124/#125). A plain string so future administrative
  // roles remain representable; storage nulls never reach this contract.
  role: z2.string().openapi({ example: "admin" })
}).openapi("AdminUser");
var AdminUserListSchema = z2.object({
  items: z2.array(AdminUserSchema).openapi({ description: "Ascending email order." }),
  total: z2.number().int().min(0).openapi({
    description: "Matches before pagination.",
    example: 42
  })
}).openapi("AdminUserList");
var AdminUserListQuerySchema = z2.object({
  limit: z2.coerce.number().int().min(1).max(100).default(25).openapi({ example: 25 }),
  offset: z2.coerce.number().int().min(0).default(0).openapi({ example: 0 }),
  email: z2.string().trim().min(1).max(254).optional().openapi({ description: "Case-insensitive literal email substring.", example: "ada" })
}).openapi("AdminUserListQuery");
var AdminUserDetailParamsSchema = z2.object({
  userId: z2.string().min(1).max(128).openapi({
    description: "Opaque administrative User identifier.",
    example: "abc123"
  })
}).openapi("AdminUserDetailParams");
var ReaderStateResponseSchema = z2.object({
  readerState: z2.string().min(1).openapi({
    description: "Short-lived signed presentation-only Reader State.",
    example: "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhYmMxMjMifQ.sig"
  }),
  expiresAt: z2.number().int().min(1).openapi({
    description: "Reader State expiry as integer Unix seconds.",
    example: 1790000900
  })
}).openapi("ReaderState");
var ConsumerJsonWebKeySchema = z2.object({
  kid: z2.string().min(1).openapi({ description: "Stable durable key id.", example: "abc123" }),
  kty: z2.string().min(1).openapi({ description: "Key type.", example: "OKP" }),
  alg: z2.string().min(1).openapi({ description: "Fixed supported algorithm.", example: "EdDSA" }),
  use: z2.string().optional().openapi({ description: "Intended use.", example: "sig" }),
  crv: z2.string().optional().openapi({ description: "Curve name.", example: "Ed25519" }),
  x: z2.string().optional().openapi({ description: "Public x coordinate." }),
  y: z2.string().optional().openapi({ description: "Public y coordinate." }),
  n: z2.string().optional().openapi({ description: "Public RSA modulus." }),
  e: z2.string().optional().openapi({ description: "Public RSA exponent." })
}).openapi("ConsumerJsonWebKey");
var ConsumerJwksResponseSchema = z2.object({
  keys: z2.array(ConsumerJsonWebKeySchema).openapi({
    description: "Active and retained public verification keys."
  })
}).openapi("ConsumerJwks");

// src/shared/problem.ts
import { z as z3 } from "@hono/zod-openapi";
var ProblemDetailsSchema = z3.object({
  type: z3.string().openapi({ example: "urn:problem:not-found" }),
  title: z3.string().openapi({ example: "Not Found" }),
  status: z3.number().int().openapi({ example: 404 }),
  detail: z3.string().optional().openapi({ example: "No such operation." }),
  code: z3.string().openapi({ example: "not-found" }),
  instance: z3.string().optional().openapi({ example: "/v1/does-not-exist" })
}).openapi("ProblemDetails");
export {
  AdminMeSchema,
  AdminUserDetailParamsSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  AdminUserSchema,
  LoginRequestSchema,
  ProblemDetailsSchema
};
