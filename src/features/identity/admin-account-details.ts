import type { AccountDetails, UpdateAccountDetails } from './contract.js';
import { callIdentityEngine, readIdentityEngineFailure } from './engine-result.js';
import { projectAccountDetails } from './account-details-operations.js';
import type { createIdentityAuth } from './auth.js';

export type AdminAccountDetailsOutcome =
  | { readonly kind: 'success'; readonly value: AccountDetails }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'internal-error' };

// Application-owned administrative Account Details operations. Better Auth's
// Admin API authorizes the current Administrator and accesses the target User;
// only the Account Details projection crosses this module's boundary.
export function createAdminAccountDetailsOperations(auth: ReturnType<typeof createIdentityAuth>) {
  return {
    async get(userId: string, headers: Headers): Promise<AdminAccountDetailsOutcome> {
      const response = await callIdentityEngine(() =>
        auth.api.getUser({ query: { id: userId }, headers, asResponse: true }),
      );
      return toOutcome(response, userId);
    },

    async update(
      userId: string,
      headers: Headers,
      patch: UpdateAccountDetails,
    ): Promise<AdminAccountDetailsOutcome> {
      const response = await callIdentityEngine(() =>
        auth.api.adminUpdateUser({
          body: { userId, data: allowedUpdateData(patch) },
          headers,
          asResponse: true,
        }),
      );
      return toOutcome(response, userId);
    },
  };
}

function allowedUpdateData(patch: UpdateAccountDetails): Record<string, string | null> {
  const data: Record<string, string | null> = {};
  if (patch.firstName !== undefined) data.firstName = patch.firstName;
  if (patch.lastName !== undefined) data.lastName = patch.lastName;
  if (patch.birthDate !== undefined) data.birthDate = patch.birthDate;
  if (patch.phone !== undefined) data.phone = patch.phone;
  if (patch.image !== undefined) data.image = patch.image;
  return data;
}

async function toOutcome(
  response: Awaited<ReturnType<typeof callIdentityEngine>>,
  userId: string,
): Promise<AdminAccountDetailsOutcome> {
  if (!(response instanceof Response)) return outcomeForStatus(response.status);
  if (!response.ok) return outcomeForStatus((await readIdentityEngineFailure(response)).status);

  try {
    const user: unknown = await response.json();
    if (!isRecord(user) || user.id !== userId) return { kind: 'internal-error' };
    return { kind: 'success', value: projectAccountDetails(user) };
  } catch {
    return { kind: 'internal-error' };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function outcomeForStatus(status: number): AdminAccountDetailsOutcome {
  if (status === 401) return { kind: 'unauthenticated' };
  if (status === 403) return { kind: 'forbidden' };
  if (status === 404) return { kind: 'not-found' };
  if (status === 400) return { kind: 'bad-request' };
  return { kind: 'internal-error' };
}
