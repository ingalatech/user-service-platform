function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) return null;
  return value as Record<string, unknown>;
}

export interface IdentityEngineFailure {
  readonly status: number;
  readonly code?: string;
}

export type IdentityEngineOutcome = Response | IdentityEngineFailure;

function thrownEngineFailure(error: unknown): IdentityEngineFailure | null {
  const record = asRecord(error);
  const statusCode = record?.statusCode;
  if (typeof statusCode !== 'number') return null;
  const code = asRecord(record?.body)?.code;
  return { status: statusCode, code: typeof code === 'string' ? code : undefined };
}

// Better Auth's `asResponse` calls can still throw before returning a
// Response. Keep that engine-specific translation inside Identity operations;
// callers see only the stable status/code needed for their public outcome.
export async function callIdentityEngine(
  call: () => Promise<Response>,
): Promise<IdentityEngineOutcome> {
  try {
    return await call();
  } catch (error) {
    return thrownEngineFailure(error) ?? { status: 500 };
  }
}

export async function readIdentityEngineFailure(
  response: Response,
): Promise<IdentityEngineFailure> {
  let code: string | undefined;
  try {
    const candidate = asRecord(await response.json())?.code;
    if (typeof candidate === 'string') code = candidate;
  } catch {
    // Non-JSON failure bodies carry no stable machine contract.
  }
  return { status: response.status, code };
}

export function responseCookies(response: Response): readonly string[] {
  return typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
}
