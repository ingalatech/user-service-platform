import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

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

// Singleton application-owned first-admin lease. An expiry makes crashed
// reservations recoverable; a nullable completion timestamp is a separate,
// durable closed state. The owner nonce lets only the reserving operation
// release a failed attempt.
export const adminBootstrapGuard = sqliteTable('admin_bootstrap_guard', {
  id: integer('id').primaryKey(),
  ownerNonce: text('owner_nonce').notNull(),
  expiresAt: integer('expires_at').notNull(),
  completedAt: integer('completed_at'),
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

// Adapter-facing schema object for Better Auth's Drizzle adapter. Kept next
// to the tables so the mapping cannot drift from the table definitions.
export const identitySchema = {
  user,
  session,
  account,
  verification,
  emailVerificationToken,
  adminBootstrapGuard,
  jwks,
};
