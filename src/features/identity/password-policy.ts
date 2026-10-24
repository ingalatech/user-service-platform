import type { AuthPolicy } from './policy.js';
import { PasswordPolicyRuleSchema, type PasswordPolicyRule } from '../../shared/problem.js';

export type { PasswordPolicyRule } from '../../shared/problem.js';

export const PASSWORD_POLICY_RULES = PasswordPolicyRuleSchema.options;

export interface PasswordPolicy {
  readonly minLength: number;
  readonly maxLength: number;
  readonly minUppercase: number;
  readonly minLowercase: number;
  readonly minDigits: number;
  readonly minSymbols: number;
}

export interface PasswordPolicyEvaluation {
  readonly valid: boolean;
  readonly failedRules: readonly PasswordPolicyRule[];
  readonly policy: PasswordPolicy;
}

const uppercase = /\p{Lu}/u;
const lowercase = /\p{Ll}/u;
const digit = /\p{Nd}/u;
const letterOrNumber = /[\p{L}\p{N}]/u;
const whitespace = /\s/u;

function count(password: string, predicate: (codePoint: string) => boolean): number {
  let result = 0;
  for (const codePoint of password) {
    if (predicate(codePoint)) result += 1;
  }
  return result;
}

export function evaluatePasswordPolicy(
  password: string,
  policy: PasswordPolicy,
): PasswordPolicyEvaluation {
  const length = Array.from(password).length;
  const uppercaseCount = count(password, (value) => uppercase.test(value));
  const lowercaseCount = count(password, (value) => lowercase.test(value));
  const digitCount = count(password, (value) => digit.test(value));
  const symbolCount = count(
    password,
    (value) => !letterOrNumber.test(value) && !whitespace.test(value),
  );
  const failedRules: PasswordPolicyRule[] = [];
  if (length < policy.minLength) failedRules.push('min-length');
  if (length > policy.maxLength) failedRules.push('max-length');
  if (uppercaseCount < policy.minUppercase) failedRules.push('min-uppercase');
  if (lowercaseCount < policy.minLowercase) failedRules.push('min-lowercase');
  if (digitCount < policy.minDigits) failedRules.push('min-digits');
  if (symbolCount < policy.minSymbols) failedRules.push('min-symbols');
  return { valid: failedRules.length === 0, failedRules, policy };
}

export function passwordPolicyFromAuthPolicy(policy: AuthPolicy): PasswordPolicy {
  return policy.passwordPolicy;
}
