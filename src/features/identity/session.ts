import type { Env } from '../../env.js';
import type { AuthMailer } from './mailer.js';

// Stable application-owned authenticated identity (ADR-0005, GLOSSARY.md).
// Feature slices consume this contract instead of Better Auth persistence
// models, provider-specific types, session tokens or D1 row representations.
// It mirrors the public `/v1/me` representation: only the stable identity
// fields cross the boundary.
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
}

// Stable application-facing session data available to authenticated feature
// slices. It carries the resolved user; session mechanics (tokens, cookies,
// storage rows) stay inside the identity slice.
export interface SessionContext {
  readonly user: AuthenticatedUser;
}

export interface ResolveSessionInput {
  readonly env: Env;
  readonly headers: Headers;
  readonly baseURL: string;
  readonly authMailer?: AuthMailer;
  // Request execution-context scheduler for provider-latency work. Callers
  // with an execution context (request handlers) pass it through so session
  // resolution shares the slice's background semantics; callers without one
  // fall back to supervised fire-and-forget. Session reads never trigger
  // mail, so this only preserves consistent wiring.
  readonly background?: (task: Promise<unknown>) => void;
  // Correlation id for failure telemetry (ADR-0009). The `/v1/me` handler
  // forwards the request id set by the composition-root middleware so session
  // failures join the same request trace as the request/error logs.
  readonly requestId?: string;
}

// Stable session-resolution failure phase (ticket #93, ADR-0009). Every
// unexpected session defect is logged with one of these phases before it
// reaches the 500 boundary so operators can distinguish configuration,
// auth-construction and session-store failures without raw exception text.
export type SessionResolvePhase = 'config' | 'auth' | 'session';

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

// Pure boundary mapper: engine session payloads become application-owned
// users. Returns null when the payload does not carry the stable shape so
// callers treat unknown shapes as unauthenticated rather than crash.
export function toAuthenticatedUser(payload: unknown): AuthenticatedUser | null {
  const user = asRecord(asRecord(payload)?.user);
  if (
    user === null ||
    typeof user.id !== 'string' ||
    typeof user.email !== 'string' ||
    typeof user.emailVerified !== 'boolean'
  ) {
    return null;
  }
  return { id: user.id, email: user.email, emailVerified: user.emailVerified };
}

export function toSessionContext(payload: unknown): SessionContext | null {
  const user = toAuthenticatedUser(payload);
  if (user === null) {
    return null;
  }
  return { user };
}
