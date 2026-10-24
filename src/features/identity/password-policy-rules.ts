import type { PasswordPolicy } from './password-policy.js';

// This portable Identity definition is shared by Worker and browser code. It
// has no runtime dependency on server, Zod or Cloudflare modules.
export const PASSWORD_POLICY_RULE_NAMES = [
  'min-length',
  'max-length',
  'min-uppercase',
  'min-lowercase',
  'min-digits',
  'min-symbols',
] as const;

export type PasswordPolicyRule = (typeof PASSWORD_POLICY_RULE_NAMES)[number];

type PasswordPolicyMetric =
  'code-point-length' | 'uppercase-letter' | 'lowercase-letter' | 'decimal-digit' | 'symbol';

export interface PasswordPolicyRuleDefinition {
  readonly policyKey: keyof PasswordPolicy;
  readonly comparison: 'minimum' | 'maximum';
  readonly metric: PasswordPolicyMetric;
  readonly label: string;
}

export const PASSWORD_POLICY_RULE_DEFINITIONS = {
  'min-length': {
    policyKey: 'minLength',
    comparison: 'minimum',
    metric: 'code-point-length',
    label: 'characters',
  },
  'max-length': {
    policyKey: 'maxLength',
    comparison: 'maximum',
    metric: 'code-point-length',
    label: 'characters',
  },
  'min-uppercase': {
    policyKey: 'minUppercase',
    comparison: 'minimum',
    metric: 'uppercase-letter',
    label: 'uppercase letter(s)',
  },
  'min-lowercase': {
    policyKey: 'minLowercase',
    comparison: 'minimum',
    metric: 'lowercase-letter',
    label: 'lowercase letter(s)',
  },
  'min-digits': {
    policyKey: 'minDigits',
    comparison: 'minimum',
    metric: 'decimal-digit',
    label: 'digit(s)',
  },
  'min-symbols': {
    policyKey: 'minSymbols',
    comparison: 'minimum',
    metric: 'symbol',
    label: 'symbol(s)',
  },
} as const satisfies Record<PasswordPolicyRule, PasswordPolicyRuleDefinition>;

// The fallback action document serializes this same rule definition to render
// its requirements. Password acceptance itself always remains server-owned.
export const PASSWORD_POLICY_REQUIREMENTS = PASSWORD_POLICY_RULE_NAMES.map((rule) => ({
  rule,
  ...PASSWORD_POLICY_RULE_DEFINITIONS[rule],
}));

export interface PasswordPolicyEvaluation {
  readonly valid: boolean;
  readonly failedRules: readonly PasswordPolicyRule[];
}

const uppercase = /\p{Lu}/u;
const lowercase = /\p{Ll}/u;
const decimalDigit = /\p{Nd}/u;
const letterOrNumber = /[\p{L}\p{N}]/u;
const whitespace = /\s/u;

function count(codePoints: readonly string[], predicate: (codePoint: string) => boolean): number {
  let result = 0;
  for (const codePoint of codePoints) {
    if (predicate(codePoint)) result += 1;
  }
  return result;
}

function metricValue(metric: PasswordPolicyMetric, codePoints: readonly string[]): number {
  switch (metric) {
    case 'code-point-length':
      return codePoints.length;
    case 'uppercase-letter':
      return count(codePoints, (codePoint) => uppercase.test(codePoint));
    case 'lowercase-letter':
      return count(codePoints, (codePoint) => lowercase.test(codePoint));
    case 'decimal-digit':
      return count(codePoints, (codePoint) => decimalDigit.test(codePoint));
    case 'symbol':
      return count(
        codePoints,
        (codePoint) => !letterOrNumber.test(codePoint) && !whitespace.test(codePoint),
      );
  }
}

export function evaluatePasswordRules(
  password: string,
  policy: PasswordPolicy,
): PasswordPolicyEvaluation {
  const codePoints = Array.from(password);
  const failedRules = PASSWORD_POLICY_RULE_NAMES.filter((rule) => {
    const definition = PASSWORD_POLICY_RULE_DEFINITIONS[rule];
    const actual = metricValue(definition.metric, codePoints);
    const expected = policy[definition.policyKey];
    return definition.comparison === 'minimum' ? actual < expected : actual > expected;
  });
  return { valid: failedRules.length === 0, failedRules };
}
