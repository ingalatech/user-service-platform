import type { Env } from '../../env.js';
import { renderPasswordResetEmail, renderVerificationEmail } from './mail-templates.js';
import type {
  AuthMailDeliveryResult,
  AuthMailer,
  PasswordResetMessage,
  VerificationMessage,
} from './mailer.js';

// Production transactional-mail transport (ticket #13, ADR-0010, accepted
// research recommendation: Resend as the first production adapter). This
// module is the only place that knows Resend exists: it speaks the Resend
// HTTP API directly with `fetch` (no provider SDK dependency), renders
// message content through the application-owned templates, and exposes the
// result as the provider-independent `AuthMailer` boundary. Better Auth
// wiring (`auth.ts`) and feature slices never import this module.
//
// Retry/failure policy (no durable queue in this release, ADR-0010):
// - one delivery attempt per auth trigger; no automatic retry inside the
//   transport;
// - failures are recorded as structured `auth-mail.failed` telemetry and the
//   operation resolves, so the synchronous auth response stays generic and
//   its timing cannot reveal whether an account exists;
// - the email-verification gate is never weakened: a failed verification
//   send leaves the account unverified until the caller uses the explicit
//   request-verification / request-password-reset resend operations;
// - sandbox (and legacy staging) deliveries additionally require an explicit
//   recipient allowlist; anything outside it is skipped with
//   `auth-mail.sandbox-skipped` telemetry and never reaches the provider.
//
// Redaction (ADR-0009): logs carry purpose, transport, recipient domain and
// provider outcome metadata only. Recipient addresses, action URLs, tokens,
// message bodies, API keys and credentials never enter logs.

export const RESEND_API_URL = 'https://api.resend.com/emails';

export type AuthMailPurpose = 'email-verification' | 'password-reset';

// Structured telemetry record for a delivery outcome (ADR-0009). Only
// operational metadata: purpose, transport, recipient domain and provider
// outcome. Recipient addresses, action URLs, tokens, bodies, API keys and
// credentials are never fields of this record.
export interface AuthMailLogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: 'auth-mail.sent' | 'auth-mail.failed' | 'auth-mail.sandbox-skipped';
  readonly purpose: AuthMailPurpose;
  readonly transport: 'resend';
  readonly recipientDomain: string;
  readonly providerMessageId?: string;
  readonly status?: number;
  readonly reason?: string;
}

// Narrow log sink seam: production defaults to structured console output
// (Cloudflare Workers logs), tests inject a capturing sink so redaction and
// outcome telemetry are asserted without scraping process output.
export type AuthMailLogger = (record: AuthMailLogRecord) => void;

export interface ResendTransportConfig {
  readonly apiKey: string;
  readonly from: string;
  readonly appName: string;
  // True everywhere except production: deliveries are allowlist-guarded and
  // an explicit allowlist is required to resolve the config at all.
  readonly sandboxGuard: boolean;
  readonly allowlist: readonly string[];
}

type ResendEnv = Pick<
  Env,
  'ENVIRONMENT' | 'RESEND_API_KEY' | 'AUTH_MAIL_FROM' | 'AUTH_APP_NAME' | 'AUTH_MAIL_ALLOWLIST'
>;

export function parseAllowlist(value: string | undefined): readonly string[] {
  if (value === undefined) {
    return [];
  }
  return value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
}

// Allowlist matching: exact emails match case-insensitively, entries shaped
// as "@example.org" or bare "example.org" match the recipient domain.
export function isAllowlisted(email: string, allowlist: readonly string[]): boolean {
  const normalized = email.trim().toLowerCase();
  const separator = normalized.lastIndexOf('@');
  if (separator <= 0 || separator === normalized.length - 1) {
    return false;
  }
  const domain = normalized.slice(separator + 1);
  return allowlist.some((entry) => {
    if (entry.startsWith('@')) {
      return domain === entry.slice(1);
    }
    if (entry.includes('@')) {
      return normalized === entry;
    }
    return domain === entry;
  });
}

// Resolves the Resend transport configuration, failing closed with redacted
// errors (no secrets, tokens or addresses) when required values are absent.
export function resolveResendConfig(env: ResendEnv): ResendTransportConfig {
  const environment = env.ENVIRONMENT ?? 'local';
  const sandboxGuard = environment !== 'production';
  const apiKey = env.RESEND_API_KEY?.trim() ?? '';
  if (apiKey.length === 0) {
    throw new Error(
      `RESEND_API_KEY is required for the Resend mail transport in ${environment}; refusing to send auth mail without it.`,
    );
  }
  const from = env.AUTH_MAIL_FROM?.trim() ?? '';
  if (from.length === 0) {
    throw new Error(
      `AUTH_MAIL_FROM is required for the Resend mail transport in ${environment}; refusing to send auth mail without a verified sender.`,
    );
  }
  const appName = env.AUTH_APP_NAME?.trim() === '' ? undefined : env.AUTH_APP_NAME?.trim();
  const allowlist = parseAllowlist(env.AUTH_MAIL_ALLOWLIST);
  if (sandboxGuard && allowlist.length === 0) {
    throw new Error(
      `AUTH_MAIL_ALLOWLIST is required for the Resend mail transport outside production (current: ${environment}); refusing to send auth mail without an explicit recipient allowlist.`,
    );
  }
  return {
    apiKey,
    from,
    appName: appName ?? 'User Service',
    sandboxGuard,
    allowlist,
  };
}

function recipientDomain(to: string): string {
  return to.split('@')[1]?.toLowerCase() ?? 'invalid';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  return value as Record<string, unknown>;
}

export class ResendAuthMailer implements AuthMailer {
  private readonly config: ResendTransportConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly log: AuthMailLogger;

  constructor(
    config: ResendTransportConfig,
    fetchImpl: typeof fetch = globalThis.fetch,
    log: AuthMailLogger = (record) => {
      console.log(JSON.stringify(record));
    },
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.log = log;
  }

  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    return this.sendVerificationEmailWithResult(message).then(() => undefined);
  }

  sendVerificationEmailWithResult(message: VerificationMessage): Promise<AuthMailDeliveryResult> {
    const template = renderVerificationEmail({
      appName: this.config.appName,
      url: message.url,
    });
    return this.deliver({
      purpose: 'email-verification',
      to: message.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    });
  }

  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
    const template = renderPasswordResetEmail({
      appName: this.config.appName,
      url: message.url,
    });
    return this.deliver({
      purpose: 'password-reset',
      to: message.to,
      subject: template.subject,
      html: template.html,
      text: template.text,
    }).then(() => undefined);
  }

  private async deliver(input: {
    purpose: AuthMailPurpose;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<AuthMailDeliveryResult> {
    const domain = recipientDomain(input.to);
    if (this.config.sandboxGuard && !isAllowlisted(input.to, this.config.allowlist)) {
      this.log({
        level: 'warn',
        event: 'auth-mail.sandbox-skipped',
        purpose: input.purpose,
        transport: 'resend',
        recipientDomain: domain,
        reason: 'allowlist',
      });
      return { status: 'skipped' };
    }
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: this.config.from,
          to: [input.to],
          subject: input.subject,
          html: input.html,
          text: input.text,
        }),
      });
    } catch {
      this.log({
        level: 'error',
        event: 'auth-mail.failed',
        purpose: input.purpose,
        transport: 'resend',
        recipientDomain: domain,
        reason: 'network-error',
      });
      return { status: 'failed' };
    }
    if (!response.ok) {
      this.log({
        level: 'error',
        event: 'auth-mail.failed',
        purpose: input.purpose,
        transport: 'resend',
        recipientDomain: domain,
        status: response.status,
      });
      return { status: 'failed' };
    }
    const payload: unknown = await response.json().catch(() => null);
    const messageId = asRecord(payload)?.id;
    this.log({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: input.purpose,
      transport: 'resend',
      recipientDomain: domain,
      ...(typeof messageId === 'string' ? { providerMessageId: messageId } : {}),
    });
    return { status: 'sent' };
  }
}
