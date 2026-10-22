import type { D1Database } from '@cloudflare/workers-types';

export const EMAIL_VERIFICATION_TTL_SECONDS = 3600;

interface VerificationTokenRow {
  readonly token_digest: string;
  readonly expires_at: number;
  readonly consumed_at: number | null;
}

export function normalizeVerificationTarget(email: string): string {
  return email.trim().toLowerCase();
}

async function digestToken(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function reserveLatestVerificationToken(input: {
  readonly db: D1Database;
  readonly targetEmail: string;
  readonly token: string;
  readonly expiresAt: Date;
}): Promise<void> {
  const tokenDigest = await digestToken(input.token);
  const issuedAt = Date.now();
  await input.db
    .prepare(
      `INSERT INTO "email_verification_token" ("target_email", "token_digest", "expires_at", "issued_at", "consumed_at")
       VALUES (?, ?, ?, ?, NULL)
       ON CONFLICT ("target_email") DO UPDATE SET
         "token_digest" = excluded."token_digest",
         "expires_at" = excluded."expires_at",
         "issued_at" = excluded."issued_at",
         "consumed_at" = NULL
       WHERE excluded."issued_at" >= "email_verification_token"."issued_at"`,
    )
    .bind(
      normalizeVerificationTarget(input.targetEmail),
      tokenDigest,
      input.expiresAt.getTime(),
      issuedAt,
    )
    .run();
}

export async function isLatestVerificationToken(input: {
  readonly db: D1Database;
  readonly token: string;
}): Promise<boolean> {
  const tokenDigest = await digestToken(input.token);
  const row = await input.db
    .prepare(
      `SELECT "token_digest", "expires_at", "consumed_at"
       FROM "email_verification_token"
       WHERE "token_digest" = ?`,
    )
    .bind(tokenDigest)
    .first<VerificationTokenRow>();
  return (
    row !== null &&
    row.token_digest === tokenDigest &&
    row.consumed_at === null &&
    row.expires_at > Date.now()
  );
}

export async function consumeLatestVerificationToken(input: {
  readonly db: D1Database;
  readonly token: string;
}): Promise<boolean> {
  const tokenDigest = await digestToken(input.token);
  const result = await input.db
    .prepare(
      `UPDATE "email_verification_token"
       SET "consumed_at" = ?
       WHERE "token_digest" = ?
         AND "consumed_at" IS NULL
         AND "expires_at" > ?`,
    )
    .bind(Date.now(), tokenDigest, Date.now())
    .run();
  return result.meta.changes === 1;
}
