import type { ZodType } from 'zod';
import type { components, operations } from './api.js';

export type AdminMe = components['schemas']['AdminMe'];
export type AdminUser = components['schemas']['AdminUser'];
export type AdminUserList = components['schemas']['AdminUserList'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type ProblemDetails = components['schemas']['ProblemDetails'];

type AdminUserListQueryParameters = NonNullable<
  operations['listAdminUsers']['parameters']['query']
>;
type AdminUserDetailPathParameters = operations['getAdminUser']['parameters']['path'];
export type AdminUserDetailParams = {
  userId: AdminUserDetailPathParameters['userId'];
};
export type AdminUserListQuery = {
  limit: NonNullable<AdminUserListQueryParameters['limit']>;
  offset: NonNullable<AdminUserListQueryParameters['offset']>;
  email?: AdminUserListQueryParameters['email'];
};

export declare const AdminMeSchema: ZodType<AdminMe>;
export declare const AdminUserDetailParamsSchema: ZodType<AdminUserDetailParams>;
export declare const AdminUserSchema: ZodType<AdminUser>;
export declare const AdminUserListSchema: ZodType<AdminUserList>;
export declare const AdminUserListQuerySchema: ZodType<AdminUserListQuery>;
export declare const LoginRequestSchema: ZodType<LoginRequest>;
export declare const ProblemDetailsSchema: ZodType<ProblemDetails>;
