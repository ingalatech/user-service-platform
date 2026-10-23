import { z } from '@hono/zod-openapi';

export const PasswordPolicyRuleSchema = z.enum([
  'min-length',
  'max-length',
  'min-uppercase',
  'min-lowercase',
  'min-digits',
  'min-symbols',
]);
export type PasswordPolicyRule = z.infer<typeof PasswordPolicyRuleSchema>;

// RFC 9457-compatible Problem Details contract (ADR-0007). Every public API error
// uses this envelope with a stable machine-readable `code`; human-readable
// `detail` text is never a machine contract and clients must branch on HTTP
// status plus `code`.
export const ProblemDetailsSchema = z
  .object({
    type: z.string().openapi({ example: 'urn:problem:not-found' }),
    title: z.string().openapi({ example: 'Not Found' }),
    status: z.number().int().openapi({ example: 404 }),
    detail: z.string().optional().openapi({ example: 'No such operation.' }),
    code: z.string().openapi({ example: 'not-found' }),
    instance: z.string().optional().openapi({ example: '/v1/does-not-exist' }),
    failedRules: z
      .array(PasswordPolicyRuleSchema)
      .optional()
      .openapi({ example: ['min-uppercase'] }),
    passwordPolicy: z
      .object({
        minLength: z.number().int(),
        maxLength: z.number().int(),
        minUppercase: z.number().int(),
        minLowercase: z.number().int(),
        minDigits: z.number().int(),
        minSymbols: z.number().int(),
      })
      .optional(),
  })
  .openapi('ProblemDetails');

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export type ProblemCode =
  | 'bad-request'
  | 'not-found'
  | 'internal-error'
  | 'registration-disabled'
  | 'email-password-disabled'
  | 'email-verification-required'
  | 'invalid-credentials'
  | 'verification-invalid'
  | 'reset-invalid'
  | 'unauthenticated'
  | 'forbidden'
  | 'admin-already-bootstrapped'
  | 'admin-bootstrap-in-progress'
  | 'admin-email-conflict'
  | 'password-policy-violation';

interface CreateProblemInput {
  status: number;
  code: ProblemCode;
  title: string;
  detail?: string;
  instance?: string;
  failedRules?: readonly PasswordPolicyRule[];
  passwordPolicy?: {
    minLength: number;
    maxLength: number;
    minUppercase: number;
    minLowercase: number;
    minDigits: number;
    minSymbols: number;
  };
}

export function createProblem(input: CreateProblemInput): ProblemDetails {
  return {
    type: `urn:problem:${input.code}`,
    title: input.title,
    status: input.status,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    code: input.code,
    ...(input.instance === undefined ? {} : { instance: input.instance }),
    ...(input.failedRules === undefined ? {} : { failedRules: [...input.failedRules] }),
    ...(input.passwordPolicy === undefined ? {} : { passwordPolicy: input.passwordPolicy }),
  };
}

export const PROBLEM_JSON = 'application/problem+json';
