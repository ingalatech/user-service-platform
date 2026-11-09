import {
  AccountDetailsSchema,
  AdminAdministratorAccessRequestSchema,
  AdminAdministratorAccessResultSchema,
  AdminAdministratorActivitySchema,
  AdminAdministratorDetailSchema,
  AdminAdministratorListQuerySchema,
  AdminAdministratorListSchema,
  AdminAdministratorMessageSchema,
  AdminAdministratorParamsSchema,
  AdminAuditEventsQuerySchema,
  AdminAuditEventsSchema,
  AdminMeSchema,
  AdminReaderEmailVerificationSchema,
  AdminReaderActivitySchema,
  AdminReaderAccessRequestSchema,
  AdminReaderAccessResultSchema,
  AdminReaderDetailSchema,
  AdminReaderEmailChangeCancelSchema,
  AdminReaderEmailChangeCommandSchema,
  AdminReaderEmailChangeMessageSchema,
  AdminReaderEmailChangeParamsSchema,
  AdminReaderDeletionRequestParamsSchema,
  AdminReaderEmailChangeRequestSchema,
  AdminReaderEmailChangeSchema,
  AdminReaderDeletionRequestSchema,
  AdminReaderDeletionRequestTransitionSchema,
  AdminReaderDeletionRequestCreateSchema,
  AdminReaderDeletionRequestStatusSchema,
  AdminReaderSocialIdentityParamsSchema,
  AdminReaderSocialIdentityUnlinkSchema,
  AdminReaderSessionsQuerySchema,
  AdminReaderSessionsSchema,
  AdminReaderSessionParamsSchema,
  AdminReaderSessionRevocationSchema,
  AdminReaderMessageSchema,
  AdminUserDetailParamsSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  LoginRequestSchema,
  ProblemDetailsSchema,
  UpdateAccountDetailsSchema,
  type AdminMe,
  type AdminAdministratorAccessRequest,
  type AdminAdministratorAccessResult,
  type AdminAdministratorActivity,
  type AdminAdministratorDetail,
  type AdminAdministratorList,
  type AdminAdministratorListQuery,
  type AdminAdministratorMessage,
  type AdminAdministratorParams,
  type AdminAuditEvents,
  type AdminAuditEventsQuery,
  type AdminReaderActivity,
  type AdminReaderAccessRequest,
  type AdminReaderAccessResult,
  type AdminReaderDetail,
  type AdminReaderEmailChange,
  type AdminReaderDeletionRequest,
  type AdminReaderDeletionRequestTransition,
  type AdminReaderSocialIdentityUnlink,
  type AdminReaderSessions,
  type AdminReaderSessionRevocation,
  type AdminReaderEmailChangeCancel,
  type AdminReaderEmailChangeMessage,
  type AdminReaderEmailVerification,
  type AdminReaderMessage,
  type AdminUserDetailParams,
  type AdminUserList,
  type AdminUserListQuery,
  type AccountDetails,
} from './generated/contracts.js';

// Only application-owned status/code combinations become UI messages. Raw
// server details, credentials and transport errors never reach notifications.
export class ApiError extends Error {
  readonly logoutUser = false;
  readonly redirectTo: string;
  retryAfterSeconds?: number;

  constructor(
    readonly status: number,
    readonly code?: string,
    options?: ErrorOptions,
  ) {
    const message =
      code === 'email-verification-required'
        ? 'Verifica tu correo electrónico antes de iniciar sesión.'
        : status === 401 && code === 'invalid-credentials'
          ? 'Credenciales inválidas'
          : status === 401
            ? 'La sesión terminó. Inicia sesión de nuevo.'
            : status === 403
              ? 'Tu cuenta no tiene acceso a la administración.'
              : status === 400
                ? 'Revisa el correo electrónico y la contraseña.'
                : 'No pudimos conectar con el servicio. Inténtalo de nuevo.';
    super(message, options);
    this.name = 'ApiError';
    this.redirectTo = status === 401 ? '/login' : status === 403 ? '/denegado' : '/problema';
  }
}

async function request(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  method?: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  extraHeaders?: Record<string, string>,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      signal:
        signal === undefined
          ? AbortSignal.timeout(15_000)
          : AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
      headers: {
        accept: 'application/json, application/problem+json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new ApiError(0, undefined, { cause: error });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = ProblemDetailsSchema.safeParse(payload);
    const error = new ApiError(response.status, problem.success ? problem.data.code : undefined);
    const retryAfter = Number(response.headers.get('retry-after'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterSeconds = retryAfter;
    throw error;
  }
  return payload;
}

export async function adminForceReaderEmailVerification(
  id: AdminUserDetailParams['userId'],
  revision: number,
): Promise<AdminReaderEmailVerification> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminReaderEmailVerificationSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/email-verification`,
      undefined,
      undefined,
      'PUT',
      { 'if-match': `"${String(revision)}"` },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminRequestReaderMessage(
  id: AdminUserDetailParams['userId'],
  kind: 'email-verification' | 'password-recovery',
  idempotencyKey: string,
): Promise<AdminReaderMessage> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminReaderMessageSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/${kind === 'email-verification' ? 'email-verification' : 'password-recovery'}/messages`,
      {},
      undefined,
      'POST',
      { 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function login(params: unknown): Promise<void> {
  const input = LoginRequestSchema.safeParse(params);
  if (!input.success) throw new ApiError(400);
  await request('/v1/admin/auth/login', input.data);
}

export async function adminIdentity(): Promise<AdminMe> {
  const parsed = AdminMeSchema.safeParse(await request('/v1/admin/me'));
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function signOut(): Promise<void> {
  await request('/v1/admin/auth/sign-out', {});
}

export async function adminUsers(
  query: AdminUserListQuery,
  signal?: AbortSignal,
): Promise<AdminUserList> {
  const input = AdminUserListQuerySchema.safeParse(query);
  if (!input.success) throw new ApiError(400);
  const search = new URLSearchParams({
    limit: String(input.data.limit),
    offset: String(input.data.offset),
  });
  if (input.data.email !== undefined) search.set('email', input.data.email);
  const parsed = AdminUserListSchema.safeParse(
    await request(`/v1/admin/users?${search.toString()}`, undefined, signal),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminAdministrators(
  query: AdminAdministratorListQuery,
  signal?: AbortSignal,
): Promise<AdminAdministratorList> {
  const input = AdminAdministratorListQuerySchema.safeParse(query);
  if (!input.success) throw new ApiError(400);
  const search = new URLSearchParams({
    limit: String(input.data.limit),
    offset: String(input.data.offset),
  });
  if (input.data.email !== undefined) search.set('email', input.data.email);
  const parsed = AdminAdministratorListSchema.safeParse(
    await request(`/v1/admin/administrators?${search.toString()}`, undefined, signal),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminAdministratorDetail(
  id: AdminAdministratorParams['administratorId'],
  signal?: AbortSignal,
): Promise<AdminAdministratorDetail> {
  const params = AdminAdministratorParamsSchema.safeParse({ administratorId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminAdministratorDetailSchema.safeParse(
    await request(
      `/v1/admin/administrators/${encodeURIComponent(params.data.administratorId)}`,
      undefined,
      signal,
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminAdministratorActivity(
  id: AdminAdministratorParams['administratorId'],
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminAdministratorActivity> {
  const params = AdminAdministratorParamsSchema.safeParse({ administratorId: id });
  if (!params.success) throw new ApiError(400);
  const search = new URLSearchParams({ limit: '25' });
  if (cursor !== undefined) search.set('cursor', cursor);
  const parsed = AdminAdministratorActivitySchema.safeParse(
    await request(
      `/v1/admin/administrators/${encodeURIComponent(params.data.administratorId)}/activity?${search.toString()}`,
      undefined,
      signal,
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminAuditEvents(
  query: AdminAuditEventsQuery,
  signal?: AbortSignal,
): Promise<AdminAuditEvents> {
  const input = AdminAuditEventsQuerySchema.safeParse(query);
  if (!input.success) throw new ApiError(400);
  const search = new URLSearchParams({ limit: String(input.data.limit) });
  if (input.data.cursor !== undefined) search.set('cursor', input.data.cursor);
  if (input.data.actorId !== undefined) search.set('actorId', input.data.actorId);
  if (input.data.action !== undefined) search.set('action', input.data.action);
  if (input.data.result !== undefined) search.set('result', input.data.result);
  if (input.data.from !== undefined) search.set('from', input.data.from);
  if (input.data.to !== undefined) search.set('to', input.data.to);
  const parsed = AdminAuditEventsSchema.safeParse(
    await request(`/v1/admin/audit-events?${search.toString()}`, undefined, signal),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function setAdminAdministratorAccess(
  id: AdminAdministratorParams['administratorId'],
  state: AdminAdministratorAccessRequest['state'],
  revision: number,
): Promise<AdminAdministratorAccessResult> {
  const params = AdminAdministratorParamsSchema.safeParse({ administratorId: id });
  const body = AdminAdministratorAccessRequestSchema.safeParse({ state });
  if (!params.success || !body.success) throw new ApiError(400);
  const parsed = AdminAdministratorAccessResultSchema.safeParse(
    await request(
      `/v1/admin/administrators/${encodeURIComponent(params.data.administratorId)}/access`,
      body.data,
      undefined,
      'PUT',
      { 'if-match': `"${String(revision)}"` },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminRequestAdministratorMessage(
  id: AdminAdministratorParams['administratorId'],
  kind: 'email-verification' | 'password-recovery',
  idempotencyKey: string,
): Promise<AdminAdministratorMessage> {
  const params = AdminAdministratorParamsSchema.safeParse({ administratorId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminAdministratorMessageSchema.safeParse(
    await request(
      `/v1/admin/administrators/${encodeURIComponent(params.data.administratorId)}/${kind === 'email-verification' ? 'email-verification' : 'password-recovery'}/messages`,
      {},
      undefined,
      'POST',
      { 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

// Reads one administrative User through the application-owned detail
// contract (ticket #126). The identifier stays opaque client-side: only
// nonempty bounded strings reach the Worker, and the response is parsed
// against the exact safe projection before it touches the UI.
export async function adminUserDetail(
  id: AdminUserDetailParams['userId'],
  signal?: AbortSignal,
): Promise<AdminReaderDetail> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminReaderDetailSchema.safeParse(
    await request(`/v1/admin/users/${encodeURIComponent(params.data.userId)}`, undefined, signal),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminReaderActivity(
  id: AdminUserDetailParams['userId'],
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminReaderActivity> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const search = new URLSearchParams({ limit: '25' });
  if (cursor !== undefined) search.set('cursor', cursor);
  const parsed = AdminReaderActivitySchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/activity?${search.toString()}`,
      undefined,
      signal,
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminStartReaderEmailChange(
  id: AdminUserDetailParams['userId'],
  email: string,
  accountRevision: number,
  idempotencyKey: string,
): Promise<AdminReaderEmailChange> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  const body = AdminReaderEmailChangeRequestSchema.safeParse({ email });
  if (!params.success || !body.success) throw new ApiError(400);
  const parsed = AdminReaderEmailChangeSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/email-changes`,
      body.data,
      undefined,
      'POST',
      { 'if-match': `"${String(accountRevision)}"`, 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminResendReaderEmailChangeMessage(
  id: AdminUserDetailParams['userId'],
  emailChangeId: string,
  idempotencyKey: string,
): Promise<AdminReaderEmailChangeMessage> {
  const params = AdminReaderEmailChangeParamsSchema.safeParse({ userId: id, emailChangeId });
  const body = AdminReaderEmailChangeCommandSchema.safeParse({});
  if (!params.success || !body.success) throw new ApiError(400);
  const parsed = AdminReaderEmailChangeMessageSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/email-changes/${encodeURIComponent(params.data.emailChangeId)}/messages`,
      body.data,
      undefined,
      'POST',
      { 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminCancelReaderEmailChange(
  id: AdminUserDetailParams['userId'],
  emailChangeId: string,
  workflowRevision: number,
  idempotencyKey: string,
): Promise<AdminReaderEmailChangeCancel> {
  const params = AdminReaderEmailChangeParamsSchema.safeParse({ userId: id, emailChangeId });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminReaderEmailChangeCancelSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/email-changes/${encodeURIComponent(params.data.emailChangeId)}`,
      undefined,
      undefined,
      'DELETE',
      { 'if-match': `"${String(workflowRevision)}"`, 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminCreateReaderDeletionRequest(
  id: AdminUserDetailParams['userId'],
  accountRevision: number,
  idempotencyKey: string,
  note?: string,
): Promise<AdminReaderDeletionRequest> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  const body = AdminReaderDeletionRequestCreateSchema.safeParse(note === undefined ? {} : { note });
  if (!params.success || !body.success) throw new ApiError(400, 'bad-request');
  const parsed = AdminReaderDeletionRequestSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/deletion-requests`,
      body.data,
      undefined,
      'POST',
      { 'if-match': `"${String(accountRevision)}"`, 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminTransitionReaderDeletionRequest(
  userId: AdminUserDetailParams['userId'],
  requestId: string,
  revision: number,
  state: 'approved' | 'rejected' | 'cancelled',
  idempotencyKey: string,
  note?: string,
): Promise<AdminReaderDeletionRequestTransition> {
  const params = AdminReaderDeletionRequestParamsSchema.safeParse({ userId, requestId });
  const body = AdminReaderDeletionRequestStatusSchema.safeParse(
    note === undefined ? { state } : { state, note },
  );
  if (!params.success || !body.success) throw new ApiError(400, 'bad-request');
  const parsed = AdminReaderDeletionRequestTransitionSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/deletion-requests/${encodeURIComponent(params.data.requestId)}/status`,
      body.data,
      undefined,
      'PUT',
      { 'if-match': `"${String(revision)}"`, 'idempotency-key': idempotencyKey },
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function adminSetReaderAccess(
  userId: AdminUserDetailParams['userId'],
  state: AdminReaderAccessRequest['state'],
  revision: number,
): Promise<AdminReaderAccessResult> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId });
  const body = AdminReaderAccessRequestSchema.safeParse({ state });
  if (!params.success || !body.success) throw new ApiError(400, 'bad-request');
  const result = AdminReaderAccessResultSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/access`,
      body.data,
      undefined,
      'PUT',
      { 'if-match': `"${String(revision)}"` },
    ),
  );
  if (!result.success) throw new ApiError(502);
  return result.data;
}

export async function adminUnlinkReaderSocialIdentity(
  userId: AdminUserDetailParams['userId'],
  associationId: string,
  accountRevision: number,
  idempotencyKey: string,
): Promise<AdminReaderSocialIdentityUnlink> {
  const params = AdminReaderSocialIdentityParamsSchema.safeParse({ userId, associationId });
  if (!params.success) throw new ApiError(400, 'bad-request');
  const result = AdminReaderSocialIdentityUnlinkSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/social-identities/${encodeURIComponent(params.data.associationId)}`,
      undefined,
      undefined,
      'DELETE',
      { 'if-match': `"${String(accountRevision)}"`, 'idempotency-key': idempotencyKey },
    ),
  );
  if (!result.success) throw new ApiError(502);
  return result.data;
}

export async function adminReaderSessions(
  userId: AdminUserDetailParams['userId'],
  cursor?: string,
  signal?: AbortSignal,
): Promise<AdminReaderSessions> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId });
  const query = AdminReaderSessionsQuerySchema.safeParse(
    cursor === undefined ? { limit: 25 } : { limit: 25, cursor },
  );
  if (!params.success || !query.success) throw new ApiError(400, 'bad-request');
  const search = new URLSearchParams({ limit: String(query.data.limit) });
  if (query.data.cursor !== undefined) search.set('cursor', query.data.cursor);
  const result = AdminReaderSessionsSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/sessions?${search.toString()}`,
      undefined,
      signal,
    ),
  );
  if (!result.success) throw new ApiError(502);
  return result.data;
}

export async function adminRevokeReaderSession(
  userId: AdminUserDetailParams['userId'],
  selector: string,
): Promise<AdminReaderSessionRevocation> {
  const params = AdminReaderSessionParamsSchema.safeParse({ userId, sessionId: selector });
  if (!params.success) throw new ApiError(400, 'bad-request');
  const result = AdminReaderSessionRevocationSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/sessions/${encodeURIComponent(params.data.sessionId)}`,
      undefined,
      undefined,
      'DELETE',
    ),
  );
  if (!result.success) throw new ApiError(502);
  return result.data;
}

export async function adminRevokeAllReaderSessions(
  userId: AdminUserDetailParams['userId'],
): Promise<AdminReaderSessionRevocation> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId });
  if (!params.success) throw new ApiError(400, 'bad-request');
  const result = AdminReaderSessionRevocationSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/sessions`,
      undefined,
      undefined,
      'DELETE',
    ),
  );
  if (!result.success) throw new ApiError(502);
  return result.data;
}

export async function adminUserAccountDetails(
  id: AdminUserDetailParams['userId'],
  signal?: AbortSignal,
): Promise<AccountDetails> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AccountDetailsSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/account-details`,
      undefined,
      signal,
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}

export async function updateAdminUserAccountDetails(
  id: AdminUserDetailParams['userId'],
  values: unknown,
  signal?: AbortSignal,
): Promise<AccountDetails> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  const body = UpdateAccountDetailsSchema.safeParse(values);
  if (!params.success || !body.success) throw new ApiError(400);
  const parsed = AccountDetailsSchema.safeParse(
    await request(
      `/v1/admin/users/${encodeURIComponent(params.data.userId)}/account-details`,
      body.data,
      signal,
      'PATCH',
    ),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
}
