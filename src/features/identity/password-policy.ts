import { z } from '@hono/zod-openapi';
import {
  PASSWORD_POLICY_RULE_NAMES,
  evaluatePasswordRules,
  type PasswordPolicyEvaluation as PasswordPolicyRulesEvaluation,
  type PasswordPolicyRule,
} from './password-policy-rules.js';

export { PASSWORD_POLICY_RULE_NAMES };
export { evaluatePasswordRules };
export type { PasswordPolicyRule };

export const PasswordPolicyRuleSchema = z.enum(PASSWORD_POLICY_RULE_NAMES);

const PasswordPolicyFieldsSchema = z.object({
  minLength: z.number().int(),
  maxLength: z.number().int(),
  minUppercase: z.number().int(),
  minLowercase: z.number().int(),
  minDigits: z.number().int(),
  minSymbols: z.number().int(),
});

// This unbounded extension shape intentionally preserves the existing
// Problem Details wire/OpenAPI representation. The public AuthConfig policy
// applies deployment bounds and examples to the same canonical fields below.
export const PasswordPolicyProblemSchema = PasswordPolicyFieldsSchema;

export const PasswordPolicySchema = PasswordPolicyFieldsSchema.extend({
  minLength: z.number().int().min(1).max(128).openapi({ example: 8 }),
  maxLength: z.number().int().min(1).max(128).openapi({ example: 128 }),
  minUppercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minLowercase: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minDigits: z.number().int().min(0).max(128).openapi({ example: 1 }),
  minSymbols: z.number().int().min(0).max(128).openapi({ example: 0 }),
}).openapi('PasswordPolicy');

export type PasswordPolicy = z.infer<typeof PasswordPolicySchema>;

export interface PasswordPolicyViolation {
  readonly failedRules: readonly PasswordPolicyRule[];
  readonly passwordPolicy: PasswordPolicy;
}

export interface PasswordPolicyResult extends PasswordPolicyRulesEvaluation {
  readonly policy: PasswordPolicy;
}

export function evaluatePasswordPolicy(
  password: string,
  policy: PasswordPolicy,
): PasswordPolicyResult {
  return { ...evaluatePasswordRules(password, policy), policy };
}
