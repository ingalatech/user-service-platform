import { describe, expect, it } from 'vitest';
import { evaluatePasswordPolicy, type PasswordPolicy } from './password-policy.js';

const policy: PasswordPolicy = {
  minLength: 8,
  maxLength: 12,
  minUppercase: 1,
  minLowercase: 1,
  minDigits: 1,
  minSymbols: 1,
};

describe('evaluatePasswordPolicy', () => {
  it('reports every unmet rule without exposing password material', () => {
    const result = evaluatePasswordPolicy('abc', policy);

    expect(result).toEqual({
      valid: false,
      failedRules: ['min-length', 'min-uppercase', 'min-digits', 'min-symbols'],
      policy,
    });
    expect(result).not.toHaveProperty('password');
  });

  it('counts Unicode code points by category', () => {
    expect(
      evaluatePasswordPolicy('A\u{10428}2\u{1F4A5}word', {
        ...policy,
        minLength: 1,
        maxLength: 20,
        minLowercase: 1,
      }).valid,
    ).toBe(true);
  });

  it('does not require symbols when the deployment minimum is zero', () => {
    expect(
      evaluatePasswordPolicy('ValidPassword2', { ...policy, minSymbols: 0 }).failedRules,
    ).not.toContain('min-symbols');
  });
});
