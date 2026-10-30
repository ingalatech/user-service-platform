import { z } from '@hono/zod-openapi';

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
  })
  .openapi('ProblemDetails');

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

export type ProblemCode =
  | 'bad-request'
  | 'conflict'
  | 'payload-too-large'
  | 'service-unavailable'
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
  | 'reader-not-found'
  | 'administrator-disabled'
  | 'admin-already-bootstrapped'
  | 'admin-bootstrap-in-progress'
  | 'admin-email-conflict';

export interface CreateProblemInput<TCode extends string = ProblemCode> {
  status: number;
  code: TCode;
  title: string;
  detail?: string;
  instance?: string;
}

export function createProblem<TCode extends string = ProblemCode>(
  input: CreateProblemInput<TCode>,
): ProblemDetails & { readonly code: TCode } {
  return {
    type: `urn:problem:${input.code}`,
    title: input.title,
    status: input.status,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    code: input.code,
    ...(input.instance === undefined ? {} : { instance: input.instance }),
  };
}

export const PROBLEM_JSON = 'application/problem+json';
