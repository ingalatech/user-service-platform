import type { D1Database } from '@cloudflare/workers-types';
import { and, asc, count, eq, gt, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { createAdministrationAuth } from './auth.js';
import type { AdminMe, AdminReaderDetail, AdminUser, AdminUserList } from './contract.js';
import { authorizeAdministrator } from './admin-authorization.js';
import { SOCIAL_PROVIDER_DISPLAY_NAMES } from './policy.js';
import type { SocialProvider } from './policy.js';
import {
  account,
  identitySchema,
  readerDeletionRequest,
  readerEmailChangeWorkflow,
  readerAccessState,
  readerMessageWorkflow,
  user,
} from './schema.js';

// Application-owned protected User listing (ticket #125, spec #123). This
// module owns the read query inside Identity's infrastructure boundary: it
// projects only the explicitly selected administrative fields in ascending
// email order, so credentials, session tokens and raw persistence rows never
// reach callers. The exported query functions are read-only primitives; the
// `AdminUserReader` below owns the permission check before composing them.
export interface ListAdminUsersInput {
  // Slice-owned D1 binding, used read-only for the listing and its total.
  readonly db: D1Database;
  // Validated bounds from the public contract: limit 1..100, offset >= 0.
  readonly limit: number;
  readonly offset: number;
  // Optional validated literal email substring (trimmed, nonempty, <= 254).
  // Undefined lists every User.
  readonly email?: string;
}

// Escapes the three LIKE metacharacters so the search term stays a literal
// substring: backslash (the escape character itself), percent and underscore.
// The escaped term is matched case-insensitively through `lower(email)`;
// the pattern parameter stays bound, never interpolated into SQL text.
function escapeLikeLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function toAdminUser(row: {
  id: string;
  email: string;
  emailVerified: boolean;
  role: string | null;
}): AdminUser {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.emailVerified,
    realm: 'reader',
    role: row.role ?? 'user',
  };
}

export interface GetAdminUserInput {
  // Slice-owned D1 binding, used read-only for the single-row lookup.
  readonly db: D1Database;
  // Validated opaque identifier from the public contract (nonempty, <= 128).
  readonly userId: string;
  readonly emailPasswordEnabled: boolean;
  readonly requireEmailVerification: boolean;
  readonly socialProviders: readonly SocialProvider[];
}

export interface AdminUserReaderInput {
  readonly auth: ReturnType<typeof createAdministrationAuth>;
  readonly db: D1Database;
  readonly userId: string;
  readonly headers: Headers;
  readonly emailPasswordEnabled: boolean;
  readonly requireEmailVerification: boolean;
  readonly socialProviders: readonly SocialProvider[];
}

export type AdminReadOutcome<T> =
  { readonly kind: 'allowed'; readonly value: T } | { readonly kind: 'forbidden' };

export type AdminUserDetailOutcome =
  | AdminReadOutcome<AdminReaderDetail>
  | { readonly kind: 'administrator-disabled' }
  | { readonly kind: 'not-found' };

export interface AdminUserReader {
  current(): Promise<AdminReadOutcome<AdminMe> | { readonly kind: 'administrator-disabled' }>;
  list(
    query: Pick<ListAdminUsersInput, 'limit' | 'offset' | 'email'>,
  ): Promise<AdminReadOutcome<AdminUserList> | { readonly kind: 'administrator-disabled' }>;
  get(userId: string): Promise<AdminUserDetailOutcome>;
}

async function authorizedAdministrator(
  input: AdminUserReaderInput,
): Promise<AdminReadOutcome<AdminMe> | { readonly kind: 'administrator-disabled' }> {
  const outcome = await authorizeAdministrator({
    auth: input.auth,
    db: input.db,
    administratorId: input.userId,
    headers: input.headers,
  });
  return outcome.kind === 'allowed'
    ? { kind: 'allowed', value: outcome.administrator }
    : { kind: outcome.kind };
}

// Application-owned administration read family. One caller first resolves the
// authoritative session; this module then owns the Admin-plugin permission
// check and the safe D1 projections for current/list/detail operations.
export function createAdminUserReader(input: AdminUserReaderInput): AdminUserReader {
  return {
    async current() {
      return authorizedAdministrator(input);
    },
    async list(query) {
      const authorization = await authorizedAdministrator(input);
      if (authorization.kind !== 'allowed') return authorization;
      return {
        kind: 'allowed',
        value: await listAdminUsers({ db: input.db, ...query }),
      };
    },
    async get(userId) {
      const authorization = await authorizedAdministrator(input);
      if (authorization.kind !== 'allowed') return authorization;
      const detail = await getAdminUserById({
        db: input.db,
        userId,
        emailPasswordEnabled: input.emailPasswordEnabled,
        requireEmailVerification: input.requireEmailVerification,
        socialProviders: input.socialProviders,
      });
      return detail === null ? { kind: 'not-found' } : { kind: 'allowed', value: detail };
    },
  };
}

// Reads one administrative User through the exact safe projection. Returns
// null when no row matches the opaque identifier. This query primitive does
// not perform a permission check; callers should use `AdminUserReader` or
// establish authorization before calling it. Identifiers and result contents
// are never logged here.
export async function getAdminUserById(
  input: GetAdminUserInput,
): Promise<AdminReaderDetail | null> {
  const database = drizzle(input.db, { schema: identitySchema });
  const rows = await database
    .select({
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified,
      role: user.role,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
      accessState: readerAccessState.state,
      revision: readerAccessState.revision,
    })
    .from(user)
    .leftJoin(readerAccessState, eq(readerAccessState.userId, user.id))
    .where(and(eq(user.id, input.userId), or(isNull(user.role), sql`${user.role} <> 'admin'`)))
    .limit(1);
  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  const methodRows = await database
    .select({
      id: account.id,
      providerId: account.providerId,
      password: account.password,
      createdAt: account.createdAt,
    })
    .from(account)
    .where(eq(account.userId, row.id));
  const messageRows = await database
    .select({
      id: readerMessageWorkflow.id,
      kind: readerMessageWorkflow.kind,
      state: readerMessageWorkflow.state,
      cooldownUntil: readerMessageWorkflow.cooldownUntil,
      createdAt: readerMessageWorkflow.createdAt,
    })
    .from(readerMessageWorkflow)
    .where(eq(readerMessageWorkflow.userId, row.id))
    .orderBy(asc(readerMessageWorkflow.createdAt));
  const emailChangeRows = await database
    .select({
      id: readerEmailChangeWorkflow.id,
      email: readerEmailChangeWorkflow.newEmail,
      revision: readerEmailChangeWorkflow.revision,
      createdAt: readerEmailChangeWorkflow.createdAt,
      expiresAt: readerEmailChangeWorkflow.expiresAt,
      cooldownUntil: readerEmailChangeWorkflow.cooldownUntil,
    })
    .from(readerEmailChangeWorkflow)
    .where(
      and(
        eq(readerEmailChangeWorkflow.userId, row.id),
        eq(readerEmailChangeWorkflow.state, 'pending'),
        gt(readerEmailChangeWorkflow.expiresAt, Date.now()),
      ),
    )
    .orderBy(asc(readerEmailChangeWorkflow.createdAt));
  const deletionRows = await database
    .select({
      id: readerDeletionRequest.id,
      state: readerDeletionRequest.state,
      revision: readerDeletionRequest.revision,
      previousAccessState: readerDeletionRequest.previousAccessState,
      createdAt: readerDeletionRequest.createdAt,
    })
    .from(readerDeletionRequest)
    .where(
      and(
        eq(readerDeletionRequest.userId, row.id),
        inArray(readerDeletionRequest.state, ['pending_review', 'approved']),
      ),
    )
    .orderBy(asc(readerDeletionRequest.createdAt))
    .limit(1);
  const methods: AdminReaderDetail['methods'] = [];
  const seen = new Set<string>();
  for (const method of methodRows) {
    if (
      method.providerId === 'credential' &&
      method.password !== null &&
      input.emailPasswordEnabled &&
      (!input.requireEmailVerification || row.emailVerified) &&
      !seen.has('password')
    ) {
      methods.push({ type: 'password' });
      seen.add('password');
    }
  }
  const socialIdentities: AdminReaderDetail['socialIdentities'] = methodRows.flatMap((method) => {
    if (method.providerId !== 'google' && method.providerId !== 'facebook') return [];
    return [
      {
        associationId: method.id,
        provider: method.providerId,
        providerDisplayName: input.socialProviders.includes(method.providerId)
          ? SOCIAL_PROVIDER_DISPLAY_NAMES[method.providerId]
          : 'Social provider',
        linkedAt: method.createdAt.toISOString(),
        state: 'unavailable',
      },
    ];
  });
  const legacy = toAdminUser(row);
  const state = row.accessState === 'disabled' ? 'disabled' : 'active';
  const deletionRequest = deletionRows[0];
  const deletionState =
    deletionRequest?.state === 'pending_review'
      ? 'pending_review'
      : deletionRequest?.state === 'approved'
        ? 'approved'
        : null;
  const effectiveState = deletionState === null ? state : 'suspended';
  const now = Date.now();
  const messageWorkflows: AdminReaderDetail['activeWorkflows'] = messageRows
    .filter((message) => message.state !== 'scheduled' || message.cooldownUntil > now)
    .map((message) => ({
      id: message.id,
      type:
        message.kind === 'email-verification'
          ? ('email-verification-message' as const)
          : ('password-recovery-message' as const),
      state: message.state,
      createdAt: new Date(message.createdAt).toISOString(),
      cooldownUntil: new Date(message.cooldownUntil).toISOString(),
    }));
  const emailChangeWorkflows: AdminReaderDetail['activeWorkflows'] = emailChangeRows.map(
    (workflow) => ({
      id: workflow.id,
      type: 'email-change',
      state: 'pending',
      createdAt: new Date(workflow.createdAt).toISOString(),
      email: workflow.email,
      expiresAt: new Date(workflow.expiresAt).toISOString(),
      cooldownUntil: new Date(workflow.cooldownUntil).toISOString(),
      revision: workflow.revision,
    }),
  );
  const deletionWorkflows: AdminReaderDetail['activeWorkflows'] =
    deletionRequest === undefined
      ? []
      : [
          {
            id: deletionRequest.id,
            type: 'deletion-request',
            state: deletionState ?? 'pending_review',
            createdAt: new Date(deletionRequest.createdAt).toISOString(),
            revision: deletionRequest.revision,
            previousAccessState:
              deletionRequest.previousAccessState === 'disabled' ? 'disabled' : 'active',
          },
        ];
  return {
    ...legacy,
    revision: row.revision ?? 1,
    summary: {
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    },
    access: { state, effectiveState },
    deletionState,
    methods,
    socialIdentities,
    activeWorkflows: [...messageWorkflows, ...emailChangeWorkflows, ...deletionWorkflows],
  };
}
// Lists administrative Users with deterministic ascending-email pagination.
// `total` counts every literal match before limit/offset apply, so clients
// can page without re-reading. Search terms, addresses and result contents
// are never logged here; callers keep request logs to safe metadata only.
export async function listAdminUsers(input: ListAdminUsersInput): Promise<AdminUserList> {
  const database = drizzle(input.db, { schema: identitySchema });
  const selection = {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerified,
    role: user.role,
  };

  if (input.email === undefined) {
    const [rows, totals] = await Promise.all([
      database
        .select(selection)
        .from(user)
        .where(or(isNull(user.role), sql`${user.role} <> 'admin'`))
        .orderBy(asc(user.email))
        .limit(input.limit)
        .offset(input.offset),
      database
        .select({ total: count() })
        .from(user)
        .where(or(isNull(user.role), sql`${user.role} <> 'admin'`)),
    ]);
    return { items: rows.map(toAdminUser), total: totals[0]?.total ?? 0 };
  }

  const pattern = `%${escapeLikeLiteral(input.email.toLowerCase())}%`;
  const matches = sql`lower(${user.email}) LIKE ${pattern} ESCAPE '\\'`;
  const [rows, totals] = await Promise.all([
    database
      .select(selection)
      .from(user)
      .where(and(matches, or(isNull(user.role), sql`${user.role} <> 'admin'`)))
      .orderBy(asc(user.email))
      .limit(input.limit)
      .offset(input.offset),
    database
      .select({ total: count() })
      .from(user)
      .where(and(matches, or(isNull(user.role), sql`${user.role} <> 'admin'`))),
  ]);
  return { items: rows.map(toAdminUser), total: totals[0]?.total ?? 0 };
}
