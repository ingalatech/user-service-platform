import type { PasswordPolicy, PasswordPolicyRule } from './password-policy.js';

export const TEST_PASSWORD_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 12,
  minUppercase: 1,
  minLowercase: 1,
  minDigits: 1,
  minSymbols: 1,
};

export const PASSWORD_POLICY_VIOLATIONS: readonly {
  readonly rule: PasswordPolicyRule;
  readonly password: string;
}[] = [
  { rule: 'min-length', password: 'Ab1!' },
  { rule: 'max-length', password: 'Abcdefghij1!x' },
  { rule: 'min-uppercase', password: 'abcdefghi1!' },
  { rule: 'min-lowercase', password: 'ABCDEFGHI1!' },
  { rule: 'min-digits', password: 'Abcdefghij!' },
  { rule: 'min-symbols', password: 'Abcdefghi1' },
];

export const PASSWORD_POLICY_BOUNDARY_PASSWORDS = ['Abcdef1!', 'Abcdefghij1!'] as const;
