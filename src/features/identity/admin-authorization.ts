import type { D1Database } from '@cloudflare/workers-types';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { createAdministrationAuth } from './auth.js';
import type { AdminMe } from './contract.js';
import { administratorAccessState, adminUser } from './schema.js';

export type AdministratorAuthorization =
  | { readonly kind: 'allowed'; readonly administrator: AdminMe }
  | { readonly kind: 'forbidden' }
  | { readonly kind: 'administrator-disabled' };

function isPermissionGranted(value: unknown): boolean {
  return (
    typeof value === 'object' && value !== null && 'success' in value && value.success === true
  );
}

// Shared post-session authorization for every protected Administration read.
// It resolves the Administrator from its own realm and rejects inactive actors
// before any Reader lookup, so target existence cannot affect the response.
export async function authorizeAdministrator(input: {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly administratorId: string;
  readonly headers: Headers;
}): Promise<AdministratorAuthorization> {
  const database = drizzle(input.db);
  const rows = await database
    .select({
      id: adminUser.id,
      email: adminUser.email,
      emailVerified: adminUser.emailVerified,
      role: adminUser.role,
      accessState: administratorAccessState.state,
    })
    .from(adminUser)
    .leftJoin(administratorAccessState, eq(administratorAccessState.userId, adminUser.id))
    .where(eq(adminUser.id, input.administratorId))
    .limit(1);
  const row = rows[0];
  if (row?.role !== 'admin') return { kind: 'forbidden' };
  if (row.accessState === 'disabled') return { kind: 'administrator-disabled' };

  const permission: unknown = await input.auth.api.userHasPermission({
    headers: input.headers,
    body: { userId: row.id, permissions: { user: ['list'] } },
  });
  if (!isPermissionGranted(permission)) return { kind: 'forbidden' };
  return {
    kind: 'allowed',
    administrator: {
      id: row.id,
      email: row.email,
      emailVerified: row.emailVerified,
      realm: 'administrator',
      role: 'admin',
    },
  };
}
