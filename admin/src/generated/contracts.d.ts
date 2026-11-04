import type { ZodType } from 'zod';
import type { components, operations } from './api.js';

export type AdminMe = components['schemas']['AdminMe'];
export type AdminAdministrator = components['schemas']['AdminAdministrator'];
export type AdminAdministratorDetail = components['schemas']['AdminAdministratorDetail'];
export type AdminAdministratorActivity = components['schemas']['AdminAdministratorActivity'];
export type AdminAdministratorAccessRequest = components['schemas']['AdminAdministratorAccessRequest'];
export type AdminAdministratorAccessResult = components['schemas']['AdminAdministratorAccessResult'];
export type AdminAdministratorList = components['schemas']['AdminAdministratorList'];
export type AdminAdministratorMessage = components['schemas']['AdminAdministratorMessage'];
export type AdminAuditEvent = components['schemas']['AdminAuditEvent'];
export type AdminAuditEvents = components['schemas']['AdminAuditEvents'];
export type AdminUser = components['schemas']['AdminUser'];
export type AdminReaderDetail = components['schemas']['AdminReaderDetail'];
export type AdminReaderActivity = components['schemas']['AdminReaderActivity'];
export type AdminReaderEmailVerification = components['schemas']['AdminReaderEmailVerification'];
export type AdminReaderMessage = components['schemas']['AdminReaderMessage'];
export type AdminReaderMessageRequest = components['schemas']['AdminReaderMessageRequest'];
export type AdminUserList = components['schemas']['AdminUserList'];
export type AccountDetails = components['schemas']['AccountDetails'];
export type UpdateAccountDetails = components['schemas']['UpdateAccountDetails'];
export type LoginRequest = components['schemas']['LoginRequest'];
export type ProblemDetails = components['schemas']['ProblemDetails'];

type AdminUserListQueryParameters = NonNullable<
  operations['listAdminUsers']['parameters']['query']
>;
type AdminAdministratorListQueryParameters = NonNullable<
  operations['listAdminAdministrators']['parameters']['query']
>;
type AdminAdministratorPathParameters = operations['getAdminAdministrator']['parameters']['path'];
export type AdminAdministratorParams = {
  administratorId: AdminAdministratorPathParameters['administratorId'];
};
export type AdminAdministratorListQuery = {
  limit: NonNullable<AdminAdministratorListQueryParameters['limit']>;
  offset: NonNullable<AdminAdministratorListQueryParameters['offset']>;
  email?: AdminAdministratorListQueryParameters['email'];
};
type AdminAuditEventsQueryParameters = NonNullable<
  operations['listAdminAuditEvents']['parameters']['query']
>;
export type AdminAuditEventsQuery = {
  limit: NonNullable<AdminAuditEventsQueryParameters['limit']>;
  cursor?: AdminAuditEventsQueryParameters['cursor'];
  actorId?: AdminAuditEventsQueryParameters['actorId'];
  action?: AdminAuditEventsQueryParameters['action'];
  result?: AdminAuditEventsQueryParameters['result'];
  from?: AdminAuditEventsQueryParameters['from'];
  to?: AdminAuditEventsQueryParameters['to'];
};
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
export declare const AdminAdministratorSchema: ZodType<AdminAdministrator>;
export declare const AdminAdministratorDetailSchema: ZodType<AdminAdministratorDetail>;
export declare const AdminAdministratorActivitySchema: ZodType<AdminAdministratorActivity>;
export declare const AdminAdministratorAccessRequestSchema: ZodType<AdminAdministratorAccessRequest>;
export declare const AdminAdministratorAccessResultSchema: ZodType<AdminAdministratorAccessResult>;
export declare const AdminAdministratorListSchema: ZodType<AdminAdministratorList>;
export declare const AdminAdministratorMessageSchema: ZodType<AdminAdministratorMessage>;
export declare const AdminAuditEventsQuerySchema: ZodType<AdminAuditEventsQuery>;
export declare const AdminAuditEventsSchema: ZodType<AdminAuditEvents>;
export declare const AdminAdministratorListQuerySchema: ZodType<AdminAdministratorListQuery>;
export declare const AdminAdministratorParamsSchema: ZodType<AdminAdministratorParams>;
export declare const AdminReaderActivitySchema: ZodType<AdminReaderActivity>;
export declare const AdminReaderDetailSchema: ZodType<AdminReaderDetail>;
export declare const AdminReaderEmailVerificationSchema: ZodType<AdminReaderEmailVerification>;
export declare const AdminReaderMessageSchema: ZodType<AdminReaderMessage>;
export declare const AdminReaderMessageRequestSchema: ZodType<AdminReaderMessageRequest>;
export declare const AccountDetailsSchema: ZodType<AccountDetails>;
export declare const AdminUserDetailParamsSchema: ZodType<AdminUserDetailParams>;
export declare const AdminUserSchema: ZodType<AdminUser>;
export declare const AdminUserListSchema: ZodType<AdminUserList>;
export declare const AdminUserListQuerySchema: ZodType<AdminUserListQuery>;
export declare const LoginRequestSchema: ZodType<LoginRequest>;
export declare const ProblemDetailsSchema: ZodType<ProblemDetails>;
export declare const UpdateAccountDetailsSchema: ZodType<UpdateAccountDetails>;
