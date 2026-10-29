import type { D1Database } from '@cloudflare/workers-types';

export function normalizeVerificationTarget(email: string): string {
  return email.trim().toLowerCase();
}

async function digestToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function reserveLatestVerificationToken(input: {
  readonly db: D1Database;
  readonly realm?: 'administrator';
  readonly targetEmail: string;
  readonly token: string;
  readonly expiresAt: Date;
}): Promise<void> {
  const table =
    input.realm === 'administrator' ? 'admin_email_verification_token' : 'email_verification_token';
  const tokenDigest = await digestToken(input.token);
  const issuedAt = Date.now();
  await input.db
    .prepare(
      `INSERT INTO "${table}" ("target_email", "token_digest", "expires_at", "issued_at", "consumed_at")
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT ("target_email") DO UPDATE SET
         "token_digest" = excluded."token_digest",
         "expires_at" = excluded."expires_at",
         "issued_at" = excluded."issued_at",
         "consumed_at" = NULL
          WHERE excluded."issued_at" >= "${table}"."issued_at"`,
    )
    .bind(
      normalizeVerificationTarget(input.targetEmail),
      tokenDigest,
      input.expiresAt.getTime(),
      issuedAt,
    )
    .run();
}

export async function consumeLatestVerificationToken(input: {
  readonly db: D1Database;
  readonly realm?: 'administrator';
  readonly token: string;
}): Promise<boolean> {
  const table =
    input.realm === 'administrator' ? 'admin_email_verification_token' : 'email_verification_token';
  const tokenDigest = await digestToken(input.token);
  const result = await input.db
    .prepare(
      `UPDATE "${table}"
       SET "consumed_at" = ?
       WHERE "token_digest" = ?
         AND "consumed_at" IS NULL
         AND "expires_at" > ?`,
    )
    .bind(Date.now(), tokenDigest, Date.now())
    .run();
  return result.meta.changes === 1;
}
