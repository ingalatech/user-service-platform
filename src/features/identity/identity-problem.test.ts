import { describe, expect, it } from 'vitest';
import { ProblemDetailsSchema } from '../../shared/problem.js';
import { IdentityProblemDetailsSchema } from './problem.js';

describe('Identity Problem Details extension', () => {
  it('keeps password-policy vocabulary out of the shared RFC 9457 envelope', () => {
    const identityProblem = {
      type: 'urn:problem:password-policy-violation',
      title: 'Password does not meet policy',
      status: 400,
      detail: 'The password does not meet the effective password policy.',
      code: 'password-policy-violation',
      instance: '/v1/auth/register',
      failedRules: ['min-uppercase'],
      passwordPolicy: {
        minLength: 8,
        maxLength: 128,
        minUppercase: 1,
        minLowercase: 1,
        minDigits: 1,
        minSymbols: 0,
      },
    };

    expect(ProblemDetailsSchema.parse(identityProblem)).not.toHaveProperty('failedRules');
    expect(ProblemDetailsSchema.parse(identityProblem)).not.toHaveProperty('passwordPolicy');
    expect(IdentityProblemDetailsSchema.parse(identityProblem)).toEqual(identityProblem);
  });
});
