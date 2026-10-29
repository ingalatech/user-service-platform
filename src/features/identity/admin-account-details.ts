import type { D1Database } from '@cloudflare/workers-types';
import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { AccountDetails, UpdateAccountDetails } from './contract.js';
import type { IdentityRuntime } from './identity-runtime.js';
import { identitySchema, user } from './schema.js';
import { projectAccountDetails } from './account-details-operations.js';

export type AdminAccountDetailsOutcome =
  | { readonly kind: 'success'; readonly value: AccountDetails }
  | { readonly kind: 'unauthenticated' }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'bad-request' }
  | { readonly kind: 'internal-error' };

// Admin authorization is resolved in the Administrator realm. The selected
// target is then read or updated explicitly in Reader storage; Better Auth's
// adminUpdateUser is intentionally not used because its target is the Admin
// realm's own admin_user table.
export function createAdminAccountDetailsOperations(input: {
  readonly runtime: IdentityRuntime;
  readonly db: D1Database;
}) {
  async function authorize(headers: Headers): Promise<'unauthenticated' | 'forbidden' | 'allowed'> {
    const session = await input.runtime.resolveAdministratorSessionContext(headers);
    if (session === null) return 'unauthenticated';
    const permission: unknown = await input.runtime.administration().api.userHasPermission({
      headers,
      body: { userId: session.administrator.id, permissions: { user: ['list'] } },
    });
    return isRecord(permission) && permission.success === true ? 'allowed' : 'forbidden';
  }

  async function readReaderAccount(userId: string): Promise<AccountDetails | null> {
    const database = drizzle(input.db, { schema: identitySchema });
    const rows = await database
      .select({
        id: user.id,
        firstName: user.firstName,
        lastName: user.lastName,
        birthDate: user.birthDate,
        phone: user.phone,
        image: user.image,
      })
      .from(user)
      .where(and(eq(user.id, userId), or(isNull(user.role), sql`${user.role} <> 'admin'`)))
      .limit(1);
    const row = rows[0];
    return row === undefined ? null : projectAccountDetails(row);
  }

  return {
    async get(userId: string, headers: Headers): Promise<AdminAccountDetailsOutcome> {
      const authorization = await authorize(headers);
      if (authorization !== 'allowed') return { kind: authorization };
      try {
        const value = await readReaderAccount(userId);
        return value === null ? { kind: 'not-found' } : { kind: 'success', value };
      } catch {
        return { kind: 'internal-error' };
      }
    },

    async update(
      userId: string,
      headers: Headers,
      patch: UpdateAccountDetails,
    ): Promise<AdminAccountDetailsOutcome> {
      const authorization = await authorize(headers);
      if (authorization !== 'allowed') return { kind: authorization };
      const data: Partial<{
        firstName: string | null;
        lastName: string | null;
        birthDate: string | null;
        phone: string | null;
        image: string | null;
      }> = {};
      if (patch.firstName !== undefined) data.firstName = patch.firstName;
      if (patch.lastName !== undefined) data.lastName = patch.lastName;
      if (patch.birthDate !== undefined) data.birthDate = patch.birthDate;
      if (patch.phone !== undefined) data.phone = patch.phone;
      if (patch.image !== undefined) data.image = patch.image;
      try {
        const database = drizzle(input.db, { schema: identitySchema });
        const readerTarget = and(
          eq(user.id, userId),
          or(isNull(user.role), sql`${user.role} <> 'admin'`),
        );
        // An explicit image edit is allowed only while the image is not an
        // owner-managed private photo. The condition makes that ownership
        // check part of the write, so a concurrent photo mutation cannot be
        // overwritten by a stale read.
        const updateTarget =
          patch.image === undefined
            ? readerTarget
            : and(
                readerTarget,
                or(isNull(user.image), sql`${user.image} NOT LIKE '/v1/account-photo/%'`),
              );
        const rows = await database
          .update(user)
          .set({ ...data, updatedAt: new Date() })
          .where(updateTarget)
          .returning({ id: user.id });
        if (rows[0] === undefined) {
          const current = await readReaderAccount(userId);
          if (current === null) return { kind: 'not-found' };
          return patch.image === undefined ? { kind: 'not-found' } : { kind: 'bad-request' };
        }
        const value = await readReaderAccount(userId);
        return value === null ? { kind: 'not-found' } : { kind: 'success', value };
      } catch {
        return { kind: 'internal-error' };
      }
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
