import type { AccountDetails, UpdateAccountDetails } from './contract.js';
import { callIdentityEngine, readIdentityEngineFailure, responseCookies } from './engine-result.js';
import type { IdentityRuntime } from './identity-runtime.js';

export type AccountDetailsReadOutcome =
  | { readonly kind: 'success'; readonly value: AccountDetails }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'internal-error' };

export type AccountDetailsUpdateOutcome =
  | {
      readonly kind: 'success';
      readonly cookies: readonly string[];
    }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'internal-error' };

// Account Details operations are an application-owned Identity capability.
// Better Auth owns session resolution and persistence; this module owns the
// safe projection and maps engine outcomes into the public feature boundary.
export function createAccountDetailsOperations(runtime: IdentityRuntime) {
  const auth = runtime.administration();

  async function read(headers: Headers): Promise<AccountDetailsReadOutcome> {
    try {
      const session = await auth.api.getSession({
        headers,
        query: { disableCookieCache: true },
      });
      if (session === null) return { kind: 'unauthenticated' };
      return { kind: 'success', value: projectAccountDetails(session.user) };
    } catch {
      return { kind: 'internal-error' };
    }
  }

  async function update(
    headers: Headers,
    patch: UpdateAccountDetails,
  ): Promise<AccountDetailsUpdateOutcome> {
    // In pinned Better Auth 1.7.12, updateUser awaits the D1 adapter update
    // before signing/reissuing its session cookie. Cookie/cache work can still
    // fail after D1 commits; that commit and HTTP response delivery are not a
    // distributed transaction. Once the engine returns success, don't perform
    // another session read that could turn a committed write into a false error.
    const response = await callIdentityEngine(() =>
      auth.api.updateUser({
        body: patch,
        headers,
        asResponse: true,
      }),
    );
    if (!(response instanceof Response)) {
      if (response.status === 401) return { kind: 'unauthenticated' };
      if (response.status === 400) return { kind: 'bad-request' };
      return { kind: 'internal-error' };
    }
    if (!response.ok) {
      const failure = await readIdentityEngineFailure(response);
      if (failure.status === 401) return { kind: 'unauthenticated' };
      if (failure.status === 400) return { kind: 'bad-request' };
      return { kind: 'internal-error' };
    }

    return {
      kind: 'success',
      cookies: responseCookies(response),
    };
  }

  return { read, update };
}

function projectAccountDetails(user: {
  readonly firstName?: unknown;
  readonly lastName?: unknown;
  readonly birthDate?: unknown;
  readonly phone?: unknown;
  readonly image?: unknown;
}): AccountDetails {
  return {
    firstName: nullableString(user.firstName),
    lastName: nullableString(user.lastName),
    birthDate: nullableString(user.birthDate),
    phone: nullableString(user.phone),
    image: nullableString(user.image),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}
