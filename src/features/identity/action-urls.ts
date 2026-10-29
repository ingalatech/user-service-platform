// Application-owned auth action URLs (ticket #77, ADR-0005, ADR-0010).
//
// Better Auth supplies a `token` plus an engine callback `url` to its mail
// callbacks. The callback URL is an engine implementation detail and must
// never cross the `AuthMailer` boundary: Identity builds the user-facing
// action URL from a configured consumer action page (or the service-owned
// fallback route on the request origin) plus exactly one `token` query
// parameter. Transports render that URL verbatim, so the transformation
// above the transports covers SMTP and Resend alike.
//
// Redaction: errors name only the expected shape, never the configured value
// or the token. Builders never log.
export const VERIFY_EMAIL_ACTION_PATH = '/auth-actions/verify-email';
export const RESET_PASSWORD_ACTION_PATH = '/auth-actions/reset-password';
export const ADMIN_VERIFY_EMAIL_ACTION_PATH = '/auth-actions/admin/verify-email';
export const ADMIN_RESET_PASSWORD_ACTION_PATH = '/auth-actions/admin/reset-password';

export interface BuildAuthActionUrlInput {
  // Canonical configuration slot naming this action (for example
  // `AUTH_VERIFY_EMAIL_ACTION_URL`). Failures name only this variable and the
  // expected shape, never the configured value or the token.
  readonly varName: string;
  readonly configured: string | undefined;
  readonly requestOrigin: string;
  readonly fallbackPath: string;
  readonly token: string;
}

function failRedacted(varName: string): never {
  throw new Error(
    `Configuration error: ${varName} must be an absolute http(s) action URL without credentials or fragments.`,
  );
}

// Builds the application-owned action URL for one auth-mail send. An empty or
// absent configured value selects the service-owned fallback route on the
// request origin; otherwise the configured consumer page is used verbatim.
// Exactly one canonical `token` parameter is set; unrelated configured query
// parameters are preserved.
export function buildAuthActionUrl(input: BuildAuthActionUrlInput): string {
  if (input.token.length === 0) {
    throw new Error(`Configuration error: ${input.varName} requires a token.`);
  }
  const configured = input.configured?.trim() ?? '';
  if (configured.length === 0) {
    let origin: URL;
    try {
      origin = new URL(input.requestOrigin);
    } catch {
      failRedacted(input.varName);
    }
    const fallback = new URL(input.fallbackPath, origin);
    fallback.searchParams.set('token', input.token);
    return fallback.toString();
  }
  let target: URL;
  try {
    target = new URL(configured);
  } catch {
    failRedacted(input.varName);
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') {
    failRedacted(input.varName);
  }
  if (target.username.length > 0 || target.password.length > 0) {
    failRedacted(input.varName);
  }
  if (target.hash.length > 0) {
    failRedacted(input.varName);
  }
  target.searchParams.set('token', input.token);
  return target.toString();
}
