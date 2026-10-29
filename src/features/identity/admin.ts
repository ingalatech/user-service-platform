import type { D1Database } from '@cloudflare/workers-types';
import { parseSetCookieHeader, stripSecureCookiePrefix } from 'better-auth/cookies';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { createAdministrationAuth, createBootstrapIdentityAuth } from './auth.js';
import type { AdminBootstrapResult } from './contract.js';
import { adminIdentitySchema, adminUser } from './schema.js';

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
  readonly auth: ReturnType<typeof createAdministrationAuth>;
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
  // Better Auth Admin createUser's supported `data` record accepts the
  // application-supplied primary id; its internal adapter preserves it.
  readonly data: { readonly id: string };
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
  return { id, email, realm: 'administrator', role: 'admin', emailVerified };
}

async function hasBootstrappedAdmin(db: D1Database): Promise<boolean> {
  const database = drizzle(db, { schema: adminIdentitySchema });
  const rows = await database
    .select({ id: adminUser.id })
    .from(adminUser)
    .where(eq(adminUser.role, 'admin'))
    .limit(1);
  return rows.length > 0;
}

const BOOTSTRAP_GUARD_ID = 1;

async function closeBootstrapGuard(db: D1Database, now: number): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_bootstrap_guard
         (id, owner_nonce, expires_at, completed_at, verification_status)
       VALUES (?, ?, ?, ?, 'not-required')
       ON CONFLICT(id) DO UPDATE SET
         completed_at = COALESCE(completed_at, excluded.completed_at),
         verification_status = COALESCE(verification_status, excluded.verification_status)`,
    )
    .bind(BOOTSTRAP_GUARD_ID, 'legacy-admin', now, now)
    .run();
}

async function acquireBootstrapGuard(
  db: D1Database,
  ownerNonce: string,
  provisionalUserId: string,
  now: number,
  leaseTtlMs: number,
): Promise<string | null> {
  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO admin_bootstrap_guard
         (id, owner_nonce, expires_at, completed_at, provisional_user_id)
       VALUES (?, ?, ?, NULL, ?)
       ON CONFLICT(id) DO UPDATE SET
         owner_nonce = excluded.owner_nonce,
         expires_at = excluded.expires_at,
         provisional_user_id = excluded.provisional_user_id
       WHERE completed_at IS NULL AND winner_user_id IS NULL AND expires_at <= ?
      `,
      )
      .bind(BOOTSTRAP_GUARD_ID, ownerNonce, now + leaseTtlMs, provisionalUserId, now),
    db
      .prepare(
        `INSERT OR IGNORE INTO admin_bootstrap_attempt (user_id, owner_nonce, state, created_at)
         SELECT ?, ?, 'creating', ?
         WHERE EXISTS (
           SELECT 1 FROM admin_bootstrap_guard
           WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL
             AND winner_user_id IS NULL AND provisional_user_id = ?
         )`,
      )
      .bind(provisionalUserId, ownerNonce, now, BOOTSTRAP_GUARD_ID, ownerNonce, provisionalUserId),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1
    ? provisionalUserId
    : null;
}

interface BootstrapGuardState {
  readonly completed_at: number | null;
  readonly expires_at: number;
  readonly provisional_user_id: string | null;
  readonly winner_user_id: string | null;
  readonly verification_status: string | null;
}

async function readBootstrapGuard(db: D1Database): Promise<BootstrapGuardState | null> {
  return db
    .prepare(
      `SELECT completed_at, expires_at, provisional_user_id, winner_user_id, verification_status
       FROM admin_bootstrap_guard WHERE id = ?`,
    )
    .bind(BOOTSTRAP_GUARD_ID)
    .first<BootstrapGuardState>();
}

async function releaseBootstrapGuard(db: D1Database, ownerNonce: string): Promise<void> {
  await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET expires_at = 0
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL AND winner_user_id IS NULL`,
    )
    .bind(BOOTSTRAP_GUARD_ID, ownerNonce)
    .run();
}

interface BootstrapSession {
  readonly headers: Headers;
  readonly user: Record<string, unknown>;
}

async function bootstrapSession(
  auth: ReturnType<typeof createBootstrapIdentityAuth>,
  email: string,
  password: string,
): Promise<BootstrapSession> {
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
    ([name]) => stripSecureCookiePrefix(name) === 'rch-admin.session_token',
  );
  if (signedInUser === null || sessionCookie === undefined) {
    throw new Error('Better Auth returned an unexpected internal bootstrap session.');
  }
  const headers = new Headers();
  headers.set('cookie', `${sessionCookie[0]}=${sessionCookie[1].value}`);
  return { headers, user: signedInUser };
}

function matchesBootstrapIdentity(
  session: BootstrapSession,
  userId: string,
  email: string,
): boolean {
  return (
    session.user.id === userId &&
    typeof session.user.email === 'string' &&
    session.user.email.toLowerCase() === email.toLowerCase()
  );
}

async function signOutBootstrapSession(
  auth: ReturnType<typeof createBootstrapIdentityAuth>,
  session: BootstrapSession,
): Promise<void> {
  await auth.api.signOut({ headers: session.headers }).catch(() => undefined);
}

async function recoverProvisionalUser(
  input: BootstrapAdminInput,
  provisionalUserId: string,
): Promise<{ readonly id: string; readonly user: Record<string, unknown> } | null> {
  const auth = input.createBootstrapAuth(provisionalUserId);
  let session: BootstrapSession;
  try {
    session = await bootstrapSession(auth, input.email, input.password);
  } catch {
    return null;
  }
  try {
    return matchesBootstrapIdentity(session, provisionalUserId, input.email)
      ? { id: provisionalUserId, user: session.user }
      : null;
  } finally {
    await signOutBootstrapSession(auth, session);
  }
}

async function recoverAnyProvisionalUser(
  input: BootstrapAdminInput,
  excludedUserId?: string,
): Promise<{ readonly id: string; readonly user: Record<string, unknown> } | null> {
  const result = await input.db
    .prepare(
      `SELECT user_id FROM admin_bootstrap_attempt
       WHERE state IN ('creating', 'provisional') ORDER BY created_at`,
    )
    .all<{ user_id: string }>();
  for (const row of result.results as unknown[]) {
    const userId = asRecord(row)?.user_id;
    if (typeof userId !== 'string' || userId === excludedUserId) continue;
    const recovered = await recoverProvisionalUser(input, userId);
    if (recovered !== null) return recovered;
  }
  return null;
}

async function cleanupProvisionalAttempts(
  input: BootstrapAdminInput,
  winnerUserId: string,
): Promise<void> {
  const result = await input.db
    .prepare(
      `SELECT user_id FROM admin_bootstrap_attempt
       WHERE state IN ('creating', 'provisional') AND user_id <> ? ORDER BY created_at`,
    )
    .bind(winnerUserId)
    .all<{ user_id: string }>();
  for (const row of result.results as unknown[]) {
    const userId = asRecord(row)?.user_id;
    if (typeof userId !== 'string') continue;
    try {
      await deleteProvisionalUser(input, userId);
    } catch {
      // Keep an unconfirmed attempt recorded; a later request with its exact
      // credentials can still authenticate it and safely finish cleanup.
    }
  }
}

async function updateAttemptState(
  db: D1Database,
  userId: string,
  from: 'creating' | 'provisional',
  to: 'provisional' | 'winner' | 'cleaned' | 'abandoned',
): Promise<void> {
  await db
    .prepare('UPDATE admin_bootstrap_attempt SET state = ? WHERE user_id = ? AND state = ?')
    .bind(to, userId, from)
    .run();
}

async function deleteProvisionalUser(input: BootstrapAdminInput, userId: string): Promise<void> {
  const guard = await readBootstrapGuard(input.db);
  if (guard?.winner_user_id === userId) return;
  const auth = input.createBootstrapAuth(userId);
  const session = await bootstrapSession(auth, input.email, input.password);
  // Re-read immediately before the destructive API: a winner claim always
  // wins over stale cleanup, including cleanup racing a retry.
  const currentGuard = await readBootstrapGuard(input.db);
  if (
    currentGuard?.winner_user_id === userId ||
    !matchesBootstrapIdentity(session, userId, input.email)
  ) {
    await signOutBootstrapSession(auth, session);
    return;
  }
  try {
    if (input.deleteUser !== undefined) {
      await input.deleteUser(auth, input.password, session.headers);
    } else {
      await auth.api.deleteUser({
        body: { password: input.password },
        headers: session.headers,
      });
    }
    await updateAttemptState(input.db, userId, 'creating', 'cleaned');
    await updateAttemptState(input.db, userId, 'provisional', 'cleaned');
  } finally {
    await signOutBootstrapSession(auth, session);
  }
}

async function claimBootstrapWinner(
  db: D1Database,
  ownerNonce: string,
  userId: string,
  reservedUserId: string,
  now: number,
): Promise<boolean> {
  const results = await db.batch([
    db
      .prepare(
        `UPDATE admin_bootstrap_guard
       SET winner_user_id = ?, provisional_user_id = ?
       WHERE id = ? AND owner_nonce = ? AND completed_at IS NULL
         AND winner_user_id IS NULL AND expires_at > ?
         AND EXISTS (
           SELECT 1 FROM admin_bootstrap_attempt
           WHERE user_id = ? AND state IN ('creating', 'provisional')
         )`,
      )
      .bind(userId, userId, BOOTSTRAP_GUARD_ID, ownerNonce, now, userId),
    db
      .prepare(
        `UPDATE admin_bootstrap_attempt
         SET state = 'winner'
         WHERE user_id = ? AND state IN ('creating', 'provisional')
           AND EXISTS (
             SELECT 1 FROM admin_bootstrap_guard
             WHERE id = ? AND owner_nonce = ? AND winner_user_id = ?
           )`,
      )
      .bind(userId, BOOTSTRAP_GUARD_ID, ownerNonce, userId),
    db
      .prepare(
        `UPDATE admin_bootstrap_attempt
         SET state = 'abandoned'
         WHERE user_id = ? AND user_id <> ? AND state = 'creating'
           AND EXISTS (
             SELECT 1 FROM admin_bootstrap_guard
             WHERE id = ? AND owner_nonce = ? AND winner_user_id = ?
           )`,
      )
      .bind(reservedUserId, userId, BOOTSTRAP_GUARD_ID, ownerNonce, userId),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
}

async function completeBootstrapGuard(
  db: D1Database,
  userId: string,
  now: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET completed_at = ?, expires_at = ?, verification_status = 'pending'
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
  const session = await bootstrapSession(auth, input.email, input.password);
  try {
    if (!matchesBootstrapIdentity(session, winnerUserId, input.email)) {
      throw new Error('Bootstrap credentials do not identify the claimed administrator.');
    }
    const result = input.setRole
      ? await input.setRole(auth, winnerUserId, session.headers)
      : await auth.api.setRole({
          body: { userId: winnerUserId, role: 'admin' },
          headers: session.headers,
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
    await signOutBootstrapSession(auth, session);
  }
}

async function markVerificationDelivered(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE admin_bootstrap_guard
       SET verification_status = 'delivered'
       WHERE id = ? AND winner_user_id = ? AND completed_at IS NOT NULL
         AND verification_status = 'pending'`,
    )
    .bind(BOOTSTRAP_GUARD_ID, userId)
    .run();
}

// This path is intentionally synchronous at the AuthMailer boundary: only a
// successful transport promise advances the durable state. A crash after send
// but before this state update can cause an at-least-once retry, never a false
// delivered marker.
async function sendBootstrapVerification(
  input: BootstrapAdminInput,
  userId: string,
): Promise<void> {
  const auth = input.createBootstrapAuth(userId);
  let session: BootstrapSession | undefined;
  try {
    const guard = await readBootstrapGuard(input.db);
    if (guard?.winner_user_id !== userId || guard.verification_status !== 'pending') return;
    session = await bootstrapSession(auth, input.email, input.password);
    if (!matchesBootstrapIdentity(session, userId, input.email)) return;
    if (session.user.emailVerified !== true) {
      const result = await auth.api.sendVerificationEmail({
        body: { email: input.email },
        headers: session.headers,
      });
      if (asRecord(result)?.status !== true) return;
    }
    await markVerificationDelivered(input.db, userId);
  } catch {
    // The durable pending state drives a retry on the next bootstrap request.
  } finally {
    if (session !== undefined) await signOutBootstrapSession(auth, session);
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
    if (guard.winner_user_id !== null) {
      if (guard.verification_status === 'pending') {
        await sendBootstrapVerification(input, guard.winner_user_id);
      }
      await cleanupProvisionalAttempts(input, guard.winner_user_id);
    }
    return { status: 'already-bootstrapped' };
  }
  if (guard !== null && guard.winner_user_id !== null) {
    const promotion = await promoteClaimedWinner(input, guard.winner_user_id, now());
    await sendBootstrapVerification(input, guard.winner_user_id);
    await cleanupProvisionalAttempts(input, guard.winner_user_id);
    if (!promotion.completedNow) return { status: 'already-bootstrapped' };
    return { status: 'created', admin: promotion.admin };
  }
  if (await hasBootstrappedAdmin(input.db)) {
    await closeBootstrapGuard(input.db, now());
    return { status: 'already-bootstrapped' };
  }

  let ownerNonce: string | undefined;
  let reservedUserId: string | undefined;
  for (const [attempt, delay] of BOOTSTRAP_RETRY_DELAYS_MS.entries()) {
    if (attempt > 0) await wait(delay);
    if (await hasBootstrappedAdmin(input.db)) {
      await closeBootstrapGuard(input.db, now());
      return { status: 'already-bootstrapped' };
    }
    const candidate = crypto.randomUUID();
    const provisionalUserId = crypto.randomUUID();
    const acquiredUserId = await acquireBootstrapGuard(
      input.db,
      candidate,
      provisionalUserId,
      now(),
      leaseTtlMs,
    );
    if (acquiredUserId !== null) {
      ownerNonce = candidate;
      reservedUserId = acquiredUserId;
      break;
    }
    guard = await readBootstrapGuard(input.db);
    if (guard !== null && guard.completed_at !== null) {
      return { status: 'already-bootstrapped' };
    }
  }
  if (ownerNonce === undefined || reservedUserId === undefined) {
    return { status: 'in-progress' };
  }
  // Protect compatibility with a legacy writer that may have created an admin
  // between the initial read and the atomic reservation.
  if (await hasBootstrappedAdmin(input.db)) {
    await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
    await closeBootstrapGuard(input.db, now());
    return { status: 'already-bootstrapped' };
  }

  let created: unknown;
  let provisionalUserId = reservedUserId;
  const recoveredBeforeCreate = await recoverAnyProvisionalUser(input, reservedUserId);
  if (recoveredBeforeCreate !== null) {
    provisionalUserId = recoveredBeforeCreate.id;
    created = recoveredBeforeCreate.user;
    await updateAttemptState(input.db, provisionalUserId, 'creating', 'provisional');
    await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
  } else {
    const body: BootstrapCreateUserBody = {
      name: input.name,
      email: input.email,
      password: input.password,
      role: 'user',
      data: { id: reservedUserId },
    };
    try {
      const result = input.createUser
        ? await input.createUser(input.auth, body)
        : await input.auth.api.createUser({ body });
      created = (result as { user?: unknown }).user ?? result;
      await updateAttemptState(input.db, reservedUserId, 'creating', 'provisional');
    } catch (error) {
      if (ENGINE_DUPLICATE_EMAIL_CODES.has(engineErrorCode(error) ?? '')) {
        const recovered = await recoverAnyProvisionalUser(input);
        if (recovered !== null) {
          provisionalUserId = recovered.id;
          created = recovered.user;
          await updateAttemptState(input.db, provisionalUserId, 'creating', 'provisional');
          await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
        } else {
          // Better Auth 1.7.12 reports this duplicate before it creates a User;
          // the app-supplied ID therefore has no matching provisional row.
          await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
          await releaseBootstrapGuard(input.db, ownerNonce);
          return { status: 'email-conflict' };
        }
      } else {
        await releaseBootstrapGuard(input.db, ownerNonce);
        throw error;
      }
    }
  }
  const provisional = toBootstrappedAdmin(created);
  if (provisional === null) {
    const createdId = asRecord(created)?.id;
    if (typeof createdId === 'string') {
      await deleteProvisionalUser(input, createdId);
    }
    await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw new Error('Admin bootstrap returned an unexpected provisional-user shape.');
  }
  if (provisional.id !== provisionalUserId) {
    await deleteProvisionalUser(input, provisional.id);
    await updateAttemptState(input.db, reservedUserId, 'creating', 'abandoned');
    await releaseBootstrapGuard(input.db, ownerNonce);
    throw new Error('Better Auth did not preserve the application-supplied provisional User id.');
  }
  let claimed: boolean;
  try {
    claimed = await claimBootstrapWinner(
      input.db,
      ownerNonce,
      provisional.id,
      reservedUserId,
      now(),
    );
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
  await sendBootstrapVerification(input, provisional.id);
  await cleanupProvisionalAttempts(input, provisional.id);
  if (!promotion.completedNow) return { status: 'already-bootstrapped' };
  return { status: 'created', admin: promotion.admin };
}
