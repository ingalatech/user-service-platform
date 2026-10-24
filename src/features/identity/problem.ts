import { z } from '@hono/zod-openapi';
import { ProblemDetailsSchema, createProblem } from '../../shared/problem.js';
import {
  PasswordPolicyProblemSchema,
  PasswordPolicyRuleSchema,
  type PasswordPolicyViolation,
} from './password-policy.js';

// Identity extends the RFC 9457 envelope with the policy details required by
// its credential operations. The optional members preserve the established
// Problem Details wire shape while keeping shared errors domain-neutral.
export const IdentityProblemDetailsSchema = z
  .object({
    ...ProblemDetailsSchema.shape,
    failedRules: z
      .array(PasswordPolicyRuleSchema)
      .optional()
      .openapi({ example: ['min-uppercase'] }),
    passwordPolicy: PasswordPolicyProblemSchema.optional(),
  })
  .openapi('IdentityProblemDetails');

export type IdentityProblemDetails = z.infer<typeof IdentityProblemDetailsSchema>;

export function createPasswordPolicyProblemDetails(
  failure: PasswordPolicyViolation,
  instance: string,
): IdentityProblemDetails {
  return {
    ...createProblem({
      status: 400,
      code: 'password-policy-violation',
      title: 'Password does not meet policy',
      detail: 'The password does not meet the effective password policy.',
      instance,
    }),
    failedRules: [...failure.failedRules],
    passwordPolicy: failure.passwordPolicy,
  };
}
