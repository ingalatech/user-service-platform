// Runtime-schema entrypoint for the Admin generated artifact. Keep this list
// limited to the validators the Admin HTTP adapter actually consumes; the
// schema implementations remain owned by Identity/Problem Details.
export {
  AccountDetailsSchema,
  AdminMeSchema,
  AdminUserDetailParamsSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  AdminUserSchema,
  LoginRequestSchema,
  UpdateAccountDetailsSchema,
} from '../src/features/identity/contract.js';
export { ProblemDetailsSchema } from '../src/shared/problem.js';
