import type { D1Database } from '@cloudflare/workers-types';

// D1's Better Auth/Drizzle adapter persists Date values as epoch seconds in
// integer timestamp columns. Keep this comparison in the storage unit rather
// than using the JavaScript Date millisecond representation.
// Read-only view of Better Auth's current password-reset verification entry.
// Reset consumption remains exclusively owned by the engine's reset endpoint.
export async function isCurrentPasswordResetToken(input: {
  readonly db: D1Database;
  readonly realm?: 'administrator';
  readonly token: string;
  readonly nowSeconds?: number;
}): Promise<boolean> {
  const table = input.realm === 'administrator' ? 'admin_verification' : 'verification';
  const row = await input.db
    .prepare(
      `SELECT "id"
       FROM "${table}"
       WHERE "identifier" = ?
          AND "expires_at" > ?
       LIMIT 1`,
    )
    .bind(`reset-password:${input.token}`, input.nowSeconds ?? Math.floor(Date.now() / 1000))
    .first<{ id: string }>();
  return row !== null;
}
