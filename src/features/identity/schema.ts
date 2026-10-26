import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Identity persistence owned by the identity feature slice (ADR-0002,
// ADR-0004). These tables back Better Auth through its Drizzle adapter; they
// are the only place D1 row shapes exist. Public contracts, domain behaviour
// and other feature slices must never import this module — they consume the
// stable application-owned identity boundary instead (ticket #10).
export const user = sqliteTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull(),
  image: text('image'),
  firstName: text('first_name'),
  lastName: text('last_name'),
  birthDate: text('birth_date'),
  phone: text('phone'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  // Better Auth Admin plugin capability (ticket #59). `role` carries the
  // administrative role (`admin`) versus the default (`user`); ban fields
  // support the engine's ban lifecycle. All are nullable at the storage
  // level (pre-admin rows predate the capability); the plugin supplies the
  // application defaults. No row here ever seeds credentials or privileged
  // identities: the first administrator is created by the explicit bootstrap
  // operation through Better Auth APIs.
  role: text('role'),
  banned: integer('banned', { mode: 'boolean' }).notNull().default(false),
  banReason: text('ban_reason'),
  banExpires: integer('ban_expires', { mode: 'timestamp' }),
});

export const session = sqliteTable('session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  // Better Auth Admin plugin session field for impersonation tracking
  // (ticket #59). Null for ordinary sessions.
  impersonatedBy: text('impersonated_by'),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
});

export const account = sqliteTable('account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' }).notNull(),
});

export const verification = sqliteTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
});

// Application-owned latest-token guard. Better Auth remains the signer and
// verifier; this table only stores a digest and lifecycle metadata.
export const emailVerificationToken = sqliteTable('email_verification_token', {
  targetEmail: text('target_email').primaryKey(),
  tokenDigest: text('token_digest').notNull().unique(),
  expiresAt: integer('expires_at').notNull(),
  issuedAt: integer('issued_at').notNull(),
  consumedAt: integer('consumed_at'),
});

// Singleton application-owned first-admin state machine. The expiry makes an
// unclaimed lease recoverable; provisionalUserId is preallocated before calling
// Better Auth so a crash after createUser remains identifiable. winnerUserId is
// the durable, non-expiring claim that fences later promotion/cleanup. Delivery
// status remains pending until the AuthMailer promise succeeds.
export const adminBootstrapGuard = sqliteTable('admin_bootstrap_guard', {
  id: integer('id').primaryKey(),
  ownerNonce: text('owner_nonce').notNull(),
  expiresAt: integer('expires_at').notNull(),
  completedAt: integer('completed_at'),
  provisionalUserId: text('provisional_user_id'),
  winnerUserId: text('winner_user_id'),
  verificationStatus: text('verification_status'),
});

// Application-owned record of every preallocated provisional identity. Keeping
// each attempt separate lets a new lease owner use a fresh ID without losing
// the exact IDs an older, crashed Better Auth createUser may have persisted.
export const adminBootstrapAttempt = sqliteTable('admin_bootstrap_attempt', {
  userId: text('user_id').primaryKey(),
  ownerNonce: text('owner_nonce').notNull(),
  state: text('state').notNull(),
  createdAt: integer('created_at').notNull(),
});

// Durable consumer-JWT signing-key ring (spec #150, ADR-0013). This table
// backs the pinned Better Auth JWT capability through its Drizzle adapter:
// one row per asymmetric signing key, with the private key encrypted through
// the engine facility. Keys persist per deployment in D1 so separate
// auth/Worker instances with the same database reuse them; no per-request or
// per-isolate ephemeral generation. Only public key material ever leaves the
// service through GET /v1/auth/jwks.
export const jwks = sqliteTable('jwks', {
  id: text('id').primaryKey(),
  publicKey: text('public_key').notNull(),
  privateKey: text('private_key').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp' }),
  alg: text('alg'),
  crv: text('crv'),
});

// Private R2-backed Account Photos (ticket #247, ADR-0003). Better Auth's
// user.image contains only the opaque service route reference; the private R2
// object key stays in D1. Superseded-object deletion is durable and retried by
// the Worker scheduler rather than being a best-effort orphan-prone side effect.
export const userPhoto = sqliteTable(
  'user_photo',
  {
    photoId: text('photo_id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    objectKey: text('object_key').notNull().unique(),
    contentType: text('content_type').notNull(),
    byteLength: integer('byte_length').notNull(),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('user_photo_state_created_idx').on(table.state, table.createdAt)],
);

// A short-lived per-User mutation lease serializes photo replacement/removal
// while allowing ordinary Account Details writes that do not touch `image`.
export const userPhotoLock = sqliteTable('user_photo_lock', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  lockToken: text('lock_token').notNull(),
  expiresAt: integer('expires_at').notNull(),
});

// Durable cleanup intent survives R2 failures and Worker restarts. Staged rows
// are reconciled against the authoritative Better Auth image reference before
// the old object may be deleted.
export const userPhotoCleanup = sqliteTable(
  'user_photo_cleanup',
  {
    cleanupId: text('cleanup_id').primaryKey(),
    userId: text('user_id').notNull(),
    objectKey: text('object_key').notNull(),
    photoId: text('photo_id'),
    sourcePhotoId: text('source_photo_id'),
    replacementPhotoId: text('replacement_photo_id'),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('user_photo_cleanup_state_created_idx').on(table.state, table.createdAt)],
);

// Adapter-facing schema object for Better Auth's Drizzle adapter. Kept next
// to the tables so the mapping cannot drift from the table definitions.
export const identitySchema = {
  user,
  session,
  account,
  verification,
  emailVerificationToken,
  adminBootstrapGuard,
  adminBootstrapAttempt,
  jwks,
};
