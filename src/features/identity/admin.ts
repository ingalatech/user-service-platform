import type { D1Database } from '@cloudflare/workers-types';
import { parseSetCookieHeader, stripSecureCookiePrefix } from 'better-auth/cookies';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { createBootstrapIdentityAuth, createIdentityAuth } from './auth.js';
import type { AdminBootstrapResult } from './contract.js';
import { identitySchema, user } from './schema.js';

// Explicit first-administrator bootstrap (ticket #59, spec #8). Better Auth
// creates an ordinary provisional User; an owner-fenced application claim is
// persisted before the supported Admin plugin API promotes only that winner.
// Password hashing and identity mutations stay in Better Auth; credentials are
// explicit operator inputs and this module defines no default password or logs.
//
// Bootstrap is first-admin-wins: once any `admin`-role User exists, every
// further attempt fails closed with an explicit non-secret outcome instead
// of duplicating privileged accounts. Run it immediately after migrations on
// a fresh environment; afterwards the operation stays locked.
export interface BootstrapAdminInput {
  // Request-scoped Better Auth instance from the identity infrastructure
  // boundary (already carries the Admin plugin, policy, mailer and secret).
  readonly auth: ReturnType<typeof createIdentityAuth>;
  // Private, unmounted Better Auth context whose Admin capability is scoped to
  // the provisional identity currently being promoted or cleaned up.
  readonly createBootstrapAuth: (userId: string) => ReturnType<typeof createBootstrapIdentityAuth>;
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
  readonly setRole?: BootstrapSetRole;
  readonly deleteUser?: BootstrapDeleteUser;
}

export interface BootstrapCreateUserBody {
  readonly name: string;
  readonly email: string;
  readonly password: string;
  readonly role: 'user';
}

export type BootstrapCreateUser = (
  auth: BootstrapAdminInput['auth'],
  body: BootstrapCreateUserBody,
) => Promise<unknown>;

export type BootstrapSetRole = (
  auth: ReturnType<typeof createBootstrapIdentityAuth>,
  userId: string,
  headers: Headers,
) => Promise<unknown>;

export type BootstrapDeleteUser = (
  auth: ReturnType<typeof createBootstrapIdentityAuth>,
  password: string,
  headers: Headers,
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

// A crashed invocation leaves the reservation recoverable after this interval;
// promotion is separately fenced by the owner nonce and expiry.
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
    (role !== 'admin' && role !== 'user') ||
    typeof emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id, email, role: 'admin', emailVerified };
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
       WHERE completed_at IS NULL AND winner_user_id IS NULL AND expires_at <= ?`,
    )
    .bind(BOOTSTRAP_GUARD_ID, ownerNonce, now + leaseTtlMs, now)
    .run();
  return result.meta.changes === 1;
}

interface BootstrapGuardState {
  readonly completed_at: number | null;
  readonly expires_at: number;
  readonly winner_user_id: string | null;
}

async function readBootstrapGuard(db: D1Database): Promise<BootstrapGuardState | null> {
  return db
    .prepare(
      'SELECT completed_at, expires_at, winner_user_id FROM admin_bootstrap_guard WHERE id = ?',
    )
    .bind(BOOTSTRAP_GUARD_ID)
    .first<BootstrapGuardState>();
}

async function releaseBootstrapGuard(db: D1Database, ownerNonce: string): Promise<void> {
  await db
    .prepare(
      `DELETE FROM admin_bootstrap_guard
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL AND winner_user_id IS NULL`,
    )
    .bind(BOOTSTRAP_GUARD_ID, ownerNonce)
    .run();
}

async function sessionHeaders(
  auth: ReturnType<typeof createBootstrapIdentityAuth>,
  email: string,
  password: string,
  userId: string,
): Promise<Headers> {
  const response = await auth.api.signInEmail({
    body: { email, password, rememberMe: false },
    asResponse: true,
  });
  if (!response.ok) throw new Error('Unable to establish the internal bootstrap session.');
  const payload: unknown = await response.json();
  const record = asRecord(payload);
  const signedInUser = asRecord(record?.user);
  const setCookie = response.headers.get('set-cookie') ?? '';
  const sessionCookie = [...parseSetCookieHeader(setCookie)].find(
    ([name]) => stripSecureCookiePrefix(name) === 'better-auth.session_token',
  );
  if (signedInUser?.id !== userId || sessionCookie === undefined) {
    throw new Error('Better Auth returned an unexpected internal bootstrap session.');
  }
  const headers = new Headers();
  headers.set('cookie', `${sessionCookie[0]}=${sessionCookie[1].value}`);
  return headers;
}

async function deleteProvisionalUser(input: BootstrapAdminInput, userId: string): Promise<void> {
  const guard = await readBootstrapGuard(input.db);
  if (guard?.winner_user_id === userId) return;
  const auth = input.createBootstrapAuth(userId);
  const headers = await sessionHeaders(auth, input.email, input.password, userId);
  // Re-read immediately before the destructive API: a winner claim always
  // wins over stale cleanup, including cleanup racing a retry.
  const currentGuard = await readBootstrapGuard(input.db);
  if (currentGuard?.winner_user_id === userId) {
    await auth.api.signOut({ headers }).catch(() => undefined);
    return;
  }
  try {
    if (input.deleteUser !== undefined) {
      await input.deleteUser(auth, input.password, headers);
    } else {
      await auth.api.deleteUser({ body: { password: input.password }, headers });
    }
  } finally {
    await auth.api.signOut({ headers }).catch(() => undefined);
  }
}

async function claimBootstrapWinner(
  db: D1Database,
  ownerNonce: string,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET winner_user_id = ?
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL
         AND winner_user_id IS NULL AND expires_at > ?`,
    )
    .bind(userId, BOOTSTRAP_GUARD_ID, ownerNonce, now)
    .run();
  return result.meta.changes === 1;
}

async function completeBootstrapGuard(
  db: D1Database,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET completed_at = ?, expires_at = ?
       WHERE id = ? AND winner_user_id = ? AND completed_at IS NULL`,
    )
    .bind(now, now, BOOTSTRAP_GUARD_ID, userId)
    .run();
  if (result.meta.changes === 1) return true;
  const guard = await readBootstrapGuard(db);
  if (guard?.winner_user_id === userId && guard.completed_at !== null) return false;
  throw new Error('The claimed administrator could not complete bootstrap.');
}

interface BootstrapPromotion {
  readonly admin: AdminBootstrapResult;
  readonly completedNow: boolean;
}

async function promoteClaimedWinner(
  input: BootstrapAdminInput,
  winnerUserId: string,
  now: number,
): Promise<BootstrapPromotion> {
  const auth = input.createBootstrapAuth(winnerUserId);
  const headers = await sessionHeaders(auth, input.email, input.password, winnerUserId);
  try {
    const result = input.setRole
      ? await input.setRole(auth, winnerUserId, headers)
      : await auth.api.setRole({
          body: { userId: winnerUserId, role: 'admin' },
          headers,
        });
    const promotedRecord = asRecord(asRecord(result)?.user ?? result);
    if (promotedRecord?.role !== 'admin') {
      throw new Error('Better Auth returned an unexpected promoted-user shape.');
    }
    const admin = toBootstrappedAdmin(promotedRecord);
    if (admin === null) throw new Error('Better Auth returned an unexpected promoted-user shape.');
    const completedNow = await completeBootstrapGuard(input.db, winnerUserId, now);
    return { admin, completedNow };
  } finally {
    await auth.api.signOut({ headers }).catch(() => undefined);
  }
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function bootstrapAdminUser(
  input: BootstrapAdminInput,
): Promise<BootstrapAdminOutcome> {
  const now = input.now ?? Date.now;
  const leaseTtlMs = input.leaseTtlMs ?? BOOTSTRAP_LEASE_TTL_MS;
  let guard = await readBootstrapGuard(input.db);
  if (guard !== null && guard.completed_at !== null) {
    return { status: 'already-bootstrapped' };
  }
  if (guard !== null && guard.winner_user_id !== null) {
    const promotion = await promoteClaimedWinner(input, guard.winner_user_id, now());
    if (!promotion.completedNow) return { status: 'already-bootstrapped' };
    await sendBootstrapVerification(input, promotion.admin.email);
    return { status: 'created', admin: promotion.admin };
  }
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
    guard = await readBootstrapGuard(input.db);
    if (guard !== null && guard.completed_at !== null) {
      return { status: 'already-bootstrapped' };
    }
  }
  if (ownerNonce === undefined) return { status: 'in-progress' };
  // Protect compatibility with a legacy writer that may have created an admin
  // between the initial read and the atomic reservation.
  if (await hasBootstrappedAdmin(input.db)) {
    await closeBootstrapGuard(input.db, now());
    return { status: 'already-bootstrapped' };
  }

  let created: unknown;
  try {
    const body: BootstrapCreateUserBody = {
      name: input.name,
      email: input.email,
      password: input.password,
      role: 'user',
    };
    const result = input.createUser
      ? await input.createUser(input.auth, body)
      : await input.auth.api.createUser({ body });
    created = (result as { user?: unknown }).user ?? result;
  } catch (error) {
    if (ENGINE_DUPLICATE_EMAIL_CODES.has(engineErrorCode(error) ?? '')) {
      await releaseBootstrapGuard(input.db, ownerNonce);
      return { status: 'email-conflict' };
    }
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw error;
  }
  const provisional = toBootstrappedAdmin(created);
  if (provisional === null) {
    const createdId = asRecord(created)?.id;
    if (typeof createdId === 'string') {
      await deleteProvisionalUser(input, createdId);
    }
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw new Error('Admin bootstrap returned an unexpected provisional-user shape.');
  }
  let claimed: boolean;
  try {
    claimed = await claimBootstrapWinner(input.db, ownerNonce, provisional.id, now());
  } catch (error) {
    await deleteProvisionalUser(input, provisional.id);
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw error;
  }
  if (!claimed) {
    await deleteProvisionalUser(input, provisional.id);
    guard = await readBootstrapGuard(input.db);
    await releaseBootstrapGuard(input.db, ownerNonce);
    return guard !== null && (guard.completed_at !== null || guard.winner_user_id !== null)
      ? { status: 'already-bootstrapped' }
      : { status: 'in-progress' };
  }
  const promotion = await promoteClaimedWinner(input, provisional.id, now());
  if (!promotion.completedNow) return { status: 'already-bootstrapped' };
  await sendBootstrapVerification(input, promotion.admin.email);
  return { status: 'created', admin: promotion.admin };
}

async function sendBootstrapVerification(input: BootstrapAdminInput, email: string): Promise<void> {
  // Reuse Better Auth's supported API rather than recursing through HTTP. This
  // runs the same verification callback, token guard, AuthMailer and
  // background scheduler used by registration and request-verification.
  // Creation is already complete, so delivery failure remains retryable and
  // must not change the bootstrap creation response.
  try {
    await input.auth.api.sendVerificationEmail({ body: { email } });
  } catch {
    // Mail transports own sent/failed/skipped operational logging.
  }
}
