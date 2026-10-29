import {
  AccountDetailsSchema,
  AdminMeSchema,
  AdminUserDetailParamsSchema,
  AdminUserListQuerySchema,
  AdminUserListSchema,
  AdminUserSchema,
  LoginRequestSchema,
  ProblemDetailsSchema,
  UpdateAccountDetailsSchema,
  type AdminMe,
  type AdminUserDetailParams,
  type AdminUser,
  type AdminUserList,
  type AdminUserListQuery,
  type AccountDetails,
} from './generated/contracts.js';

// Only application-owned status/code combinations become UI messages. Raw
// server details, credentials and transport errors never reach notifications.
export class ApiError extends Error {
  readonly logoutUser = false;
  readonly redirectTo: string;

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
  method?: 'POST' | 'PATCH',
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
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (error) {
    throw new ApiError(0, undefined, { cause: error });
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const problem = ProblemDetailsSchema.safeParse(payload);
    throw new ApiError(response.status, problem.success ? problem.data.code : undefined);
  }
  return payload;
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

// Reads one administrative User through the application-owned detail
// contract (ticket #126). The identifier stays opaque client-side: only
// nonempty bounded strings reach the Worker, and the response is parsed
// against the exact safe projection before it touches the UI.
export async function adminUserDetail(
  id: AdminUserDetailParams['userId'],
  signal?: AbortSignal,
): Promise<AdminUser> {
  const params = AdminUserDetailParamsSchema.safeParse({ userId: id });
  if (!params.success) throw new ApiError(400);
  const parsed = AdminUserSchema.safeParse(
    await request(`/v1/admin/users/${encodeURIComponent(params.data.userId)}`, undefined, signal),
  );
  if (!parsed.success) throw new ApiError(502);
  return parsed.data;
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
