import type { D1Database } from '@cloudflare/workers-types';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { createIdentityAuth } from './auth.js';
import type { AdminBootstrapResult } from './contract.js';
import { identitySchema, user } from './schema.js';

// Explicit first-administrator bootstrap (ticket #59, spec #8). The first
// administrative User is created through Better Auth's supported Admin API
// (`auth.api.createUser` with the `admin` role), never through direct SQL,
// persistence inserts, or migration-seeded credentials, so password hashing
// and engine invariants stay intact. Credentials are explicit operator
// inputs; this module defines no default password and logs nothing.
//
// Bootstrap is first-admin-wins: once any `admin`-role User exists, every
// further attempt fails closed with an explicit non-secret outcome instead
// of duplicating privileged accounts. Run it immediately after migrations on
// a fresh environment; afterwards the operation stays locked.
export interface BootstrapAdminInput {
  // Request-scoped Better Auth instance from the identity infrastructure
  // boundary (already carries the Admin plugin, policy, mailer and secret).
  readonly auth: ReturnType<typeof createIdentityAuth>;
  // Slice-owned D1 binding, used for the atomic application-owned bootstrap
  // reservation and compatibility checks. Creation itself always goes through
  // the engine.
  readonly db: D1Database;
  readonly name: string;
  readonly email: string;
  readonly password: string;
  // Test seam for deterministic lease-clock scenarios; production callers use
  // the Worker clock.
  readonly now?: () => number;
  // Test seam for deterministic long-running create-user scenarios.
  readonly leaseTtlMs?: number;
  // Narrow test seam for exercising engine failures without changing the
  // supported Better Auth create-user boundary used in production.
  readonly createUser?: BootstrapCreateUser;
}

export interface BootstrapCreateUserBody {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: 'admin';
}

export type BootstrapCreateUser = (
  auth: BootstrapAdminInput['auth'],
  body: BootstrapCreateUserBody,
) => Promise<unknown>;

export type BootstrapAdminOutcome =
  | { readonly status: 'created'; readonly admin: AdminBootstrapResult }
  | { readonly status: 'already-bootstrapped' }
  | { readonly status: 'in-progress' }
  | { readonly status: 'email-conflict' };

// Engine machine code for a duplicate email on the admin create-user path.
// Matched as a stable string, never logged or echoed: the public outcome is
// the application-owned `email-conflict` / `already-bootstrapped` union.
const ENGINE_DUPLICATE_EMAIL_CODES = new Set([
  'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL',
  'User already exists. Use another email.',
]);

// Password hashing and D1 round trips normally complete well inside this
// lease. A crashed invocation leaves the row recoverable after this interval;
// concurrent callers wait only for the bounded retry window below.
export const BOOTSTRAP_LEASE_TTL_MS = 30_000;
const BOOTSTRAP_RETRY_DELAYS_MS = [0, 10, 20, 40, 80, 120] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

function engineErrorCode(error: unknown): string | undefined {
  const record = asRecord(error);
  const body = asRecord(record?.body);
  const code = body?.code ?? body?.message ?? record?.message;
  return typeof code === 'string' ? code : undefined;
}

// Pure boundary mapper: engine-created users become the application-owned
// admin representation. Returns null when the payload does not carry the
// expected administrative shape so callers treat it as a defect rather than
// echo engine internals.
function toBootstrappedAdmin(payload: unknown): AdminBootstrapResult | null {
  const record = asRecord(payload);
  const id = record?.id;
  const email = record?.email;
  const role = record?.role;
  const emailVerified = record?.emailVerified;
  if (
    typeof id !== 'string' ||
    typeof email !== 'string' ||
    role !== 'admin' ||
    typeof emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id, email, role, emailVerified };
}

async function hasBootstrappedAdmin(db: D1Database): Promise<boolean> {
  const database = drizzle(db, { schema: identitySchema });
  const rows = await database
    .select({ id: user.id })
    .from(user)
    .where(eq(user.role, 'admin'))
    .limit(1);
  return rows.length > 0;
}

const BOOTSTRAP_GUARD_ID = 1;

async function closeBootstrapGuard(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_bootstrap_guard (id, owner_nonce, expires_at, completed_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET completed_at = COALESCE(completed_at, excluded.completed_at)`,
    )
    .bind(BOOTSTRAP_GUARD_ID, 'legacy-admin', now, now)
    .run();
}

async function acquireBootstrapGuard(
  db: D1Database,
  ownerNonce: string,
  now: number,
  leaseTtlMs: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO admin_bootstrap_guard (id, owner_nonce, expires_at, completed_at)
       VALUES (?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET
         owner_nonce = excluded.owner_nonce,
         expires_at = excluded.expires_at
       WHERE completed_at IS NULL AND expires_at <= ?`,
    )
    .bind(BOOTSTRAP_GUARD_ID, ownerNonce, now + leaseTtlMs, now)
    .run();
  return result.meta.changes === 1;
}

interface BootstrapGuardState {
  readonly completed_at: number | null;
  readonly expires_at: number;
}

async function readBootstrapGuard(db: D1Database): Promise<BootstrapGuardState | null> {
  return db
    .prepare('SELECT completed_at, expires_at FROM admin_bootstrap_guard WHERE id = ?')
    .bind(BOOTSTRAP_GUARD_ID)
    .first<BootstrapGuardState>();
}

async function releaseBootstrapGuard(db: D1Database, ownerNonce: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM admin_bootstrap_guard
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL`,
    )
    .bind(BOOTSTRAP_GUARD_ID, ownerNonce)
    .run();
}

async function renewBootstrapGuard(
  db: D1Database,
  ownerNonce: string,
  now: number,
  leaseTtlMs: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET expires_at = ?
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL`,
    )
    .bind(now + leaseTtlMs, BOOTSTRAP_GUARD_ID, ownerNonce)
    .run();
}

function maintainBootstrapGuard(
  db: D1Database,
  ownerNonce: string,
  now: () => number,
  leaseTtlMs: number,
): () => void {
  const interval = Math.max(1, Math.floor(leaseTtlMs / 3));
  const timer = setInterval(() => {
    void renewBootstrapGuard(db, ownerNonce, now(), leaseTtlMs).catch(() => undefined);
  }, interval);
  return () => {
    clearInterval(timer);
  };
}

async function completeBootstrapGuard(
  db: D1Database,
  ownerNonce: string,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET completed_at = ?, expires_at = ?
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL`,
    )
    .bind(now, now, BOOTSTRAP_GUARD_ID, ownerNonce)
    .run();
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function bootstrapAdminUser(
  input: BootstrapAdminInput,
): Promise<BootstrapAdminOutcome> {
  const now = input.now ?? Date.now;
  const leaseTtlMs = input.leaseTtlMs ?? BOOTSTRAP_LEASE_TTL_MS;
  if (await hasBootstrappedAdmin(input.db)) {
    await closeBootstrapGuard(input.db, now());
    return { status: 'already-bootstrapped' };
  }

  let ownerNonce: string | undefined;
  for (const [attempt, delay] of BOOTSTRAP_RETRY_DELAYS_MS.entries()) {
    if (attempt > 0) await wait(delay);
    if (await hasBootstrappedAdmin(input.db)) {
      await closeBootstrapGuard(input.db, now());
      return { status: 'already-bootstrapped' };
    }
    const candidate = crypto.randomUUID();
    if (await acquireBootstrapGuard(input.db, candidate, now(), leaseTtlMs)) {
      ownerNonce = candidate;
      break;
    }
    const guard = await readBootstrapGuard(input.db);
    if (guard !== null && guard.completed_at !== null) {
      return { status: 'already-bootstrapped' };
    }
  }
  if (ownerNonce === undefined) return { status: 'in-progress' };
  const stopGuardMaintenance = maintainBootstrapGuard(input.db, ownerNonce, now, leaseTtlMs);

  // Protect compatibility with a legacy writer that may have created an admin
  // between the initial read and the atomic reservation.
  if (await hasBootstrappedAdmin(input.db)) {
    stopGuardMaintenance();
    await completeBootstrapGuard(input.db, ownerNonce, now());
    return { status: 'already-bootstrapped' };
  }

  let created: unknown;
  try {
    const body: BootstrapCreateUserBody = {
      name: input.name,
      email: input.email,
      password: input.password,
      role: 'admin',
    };
    const result = input.createUser
      ? await input.createUser(input.auth, body)
      : await input.auth.api.createUser({ body });
    created = (result as { user?: unknown }).user ?? result;
  } catch (error) {
    stopGuardMaintenance();
    if (ENGINE_DUPLICATE_EMAIL_CODES.has(engineErrorCode(error) ?? '')) {
      await releaseBootstrapGuard(input.db, ownerNonce);
      return { status: 'email-conflict' };
    }
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw error;
  }
  const admin = toBootstrappedAdmin(created);
  if (admin === null) {
    stopGuardMaintenance();
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw new Error('Admin bootstrap returned an unexpected engine shape.');
  }
  stopGuardMaintenance();
  await completeBootstrapGuard(input.db, ownerNonce, now());
  // Reuse Better Auth's supported API rather than recursing through HTTP. This
  // runs the same verification callback, token guard, AuthMailer and
  // background scheduler used by registration and request-verification.
  // Creation is already complete, so delivery failure remains retryable and
  // must not change the bootstrap creation response.
  try {
    await input.auth.api.sendVerificationEmail({ body: { email: admin.email } });
  } catch {
    // Mail transports own sent/failed/skipped operational logging.
  }
  return { status: 'created', admin };
}
