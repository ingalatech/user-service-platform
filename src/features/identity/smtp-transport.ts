import type { Env } from '../../env.js';
import { createWorkersSmtpSendMail, SmtpDeliveryError } from './smtp-client.js';
import type { SmtpFailurePhase } from './smtp-client.js';
import { renderPasswordResetEmail, renderVerificationEmail } from './mail-templates.js';
import type {
  AuthMailDeliveryResult,
  AuthMailer,
  PasswordResetMessage,
  VerificationMessage,
} from './mailer.js';
import { isAllowlisted, parseAllowlist } from './resend-transport.js';

// Provider-neutral SMTP transactional-mail transport (ticket #58, ADR-0010,
// ticket #71 Workers runtime compatibility). This module is the only place
// that knows SMTP exists: it speaks SMTP through the Workers-native client
// (`smtp-client.ts`, built on the `cloudflare:sockets` TCP API), renders
// message content through the application-owned templates shared with the
// Resend adapter, and exposes the result as the provider-independent
// `AuthMailer` boundary. Better Auth wiring (`auth.ts`) and feature slices
// never import this module.
//
// The transport targets ordinary authenticated submission providers (Gmail,
// Amazon SES SMTP, Exchange, client-owned SMTP services). There are no
// provider-specific branches: host, port, implicit-TLS versus STARTTLS mode,
// credentials and sender identity are plain configuration.
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
// Transport security:
// - every connection negotiates verified TLS: implicit TLS
//   (`SMTP_SECURE=true`, typically port 465, `secureTransport: 'on'`) or
//   mandatory STARTTLS (`SMTP_SECURE=false`, typically port 587,
//   `secureTransport: 'starttls'` plus an explicit `startTls()` upgrade);
// - certificate verification is always enforced by the Workers runtime TLS
//   stack and there is intentionally no supported configuration knob that
//   disables it;
// - port 25 is rejected at configuration time: Cloudflare Workers cannot
//   deliver through it and it implies unencrypted submission.
//
// Redaction (ADR-0009): logs carry purpose, transport, recipient domain and
// provider outcome metadata only. Recipient addresses, action URLs, tokens,
// message bodies, usernames, passwords and credentials never enter logs.

export type SmtpMailPurpose = 'email-verification' | 'password-reset';

// Structured telemetry record for a delivery outcome (ADR-0009). Only
// operational metadata: purpose, transport, recipient domain and provider
// outcome. Recipient addresses, action URLs, tokens, bodies, usernames,
// passwords and credentials are never fields of this record.
//
// Failure classification (ticket #73): `auth-mail.failed` records carry the
// safe SMTP phase (`smtpPhase`, a closed set such as greeting, ehlo,
// starttls, auth/username/password, mail-from, rcpt-to, data or message) and
// the numeric SMTP reply code (`smtpReplyCode`) when the provider sent one.
// Transport/network failures without an SMTP reply use `smtpPhase:
// 'transport'` (or the phase where the connection dropped) with no reply
// code, so they stay distinguishable without logging raw exception text.
// `reason` keeps the stable `'send-failed'` value for compatibility.
export interface SmtpMailLogRecord {
  readonly level: 'info' | 'warn' | 'error';
  readonly event: 'auth-mail.sent' | 'auth-mail.failed' | 'auth-mail.sandbox-skipped';
  readonly purpose: SmtpMailPurpose;
  readonly transport: 'smtp';
  readonly recipientDomain: string;
  readonly providerMessageId?: string;
  readonly reason?: string;
  readonly smtpPhase?: SmtpFailurePhase;
  readonly smtpReplyCode?: number;
}

// Narrow log sink seam: production defaults to structured console output
// (Cloudflare Workers logs), tests inject a capturing sink so redaction and
// outcome telemetry are asserted without scraping process output.
export type SmtpMailLogger = (record: SmtpMailLogRecord) => void;

export interface SmtpTransportConfig {
  readonly host: string;
  readonly port: number;
  // True for implicit TLS, false for STARTTLS. There is no third value: every
  // supported mode negotiates verified TLS.
  readonly secure: boolean;
  readonly user: string;
  readonly pass: string;
  readonly from: string;
  readonly appName: string;
  // True everywhere except production: deliveries are allowlist-guarded and
  // an explicit allowlist is required to resolve the config at all.
  readonly sandboxGuard: boolean;
  readonly allowlist: readonly string[];
}

type SmtpEnv = Pick<
  Env,
  | 'ENVIRONMENT'
  | 'SMTP_HOST'
  | 'SMTP_PORT'
  | 'SMTP_SECURE'
  | 'SMTP_USER'
  | 'SMTP_PASSWORD'
  | 'AUTH_MAIL_FROM'
  | 'AUTH_APP_NAME'
  | 'AUTH_MAIL_ALLOWLIST'
>;

// Outbound message observed by the delivery seam. Tests inject a capturing
// implementation; production builds the Workers-native SMTP delivery lazily
// on first send so importing this module never opens a connection.
export interface SmtpOutboundMail {
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface SmtpSendResult {
  readonly messageId?: string;
}

export type SmtpSendMail = (mail: SmtpOutboundMail) => Promise<SmtpSendResult>;

const HOST_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

function parsePort(value: string | undefined): number {
  const raw = value?.trim() ?? '';
  if (!/^[0-9]{1,5}$/.test(raw)) {
    throw new Error(
      'Configuration error: SMTP_PORT must be a decimal port number for the SMTP mail transport.',
    );
  }
  const port = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'Configuration error: SMTP_PORT must be a decimal port number for the SMTP mail transport.',
    );
  }
  if (port === 25) {
    throw new Error(
      'Configuration error: SMTP_PORT 25 is not supported on Workers for the SMTP mail transport.',
    );
  }
  return port;
}

function parseSecure(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }
  throw new Error(
    'Configuration error: SMTP_SECURE must be "true" (implicit TLS) or "false" (STARTTLS) for the SMTP mail transport.',
  );
}

// Resolves the SMTP transport configuration, failing closed with redacted
// errors (variable names and expected shapes only; values, credentials,
// tokens and addresses are never echoed) when required values are absent or
// Workers-invalid.
export function resolveSmtpConfig(env: SmtpEnv): SmtpTransportConfig {
  const environment = env.ENVIRONMENT ?? 'local';
  const sandboxGuard = environment !== 'production';
  const host = env.SMTP_HOST?.trim() ?? '';
  if (host.length === 0 || !HOST_PATTERN.test(host)) {
    throw new Error(
      'Configuration error: SMTP_HOST must be a submission hostname for the SMTP mail transport.',
    );
  }
  const port = parsePort(env.SMTP_PORT);
  const secure = parseSecure(env.SMTP_SECURE);
  const user = env.SMTP_USER?.trim() ?? '';
  if (user.length === 0) {
    throw new Error(
      'Configuration error: SMTP_USER is required for the SMTP mail transport; refusing to send auth mail without it.',
    );
  }
  const pass = env.SMTP_PASSWORD ?? '';
  if (pass.length === 0) {
    throw new Error(
      'Configuration error: SMTP_PASSWORD is required for the SMTP mail transport; refusing to send auth mail without it.',
    );
  }
  const from = env.AUTH_MAIL_FROM?.trim() ?? '';
  if (from.length === 0) {
    throw new Error(
      `Configuration error: AUTH_MAIL_FROM is required for the SMTP mail transport in ${environment}; refusing to send auth mail without a verified sender.`,
    );
  }
  const appName = env.AUTH_APP_NAME?.trim() === '' ? undefined : env.AUTH_APP_NAME?.trim();
  const allowlist = parseAllowlist(env.AUTH_MAIL_ALLOWLIST);
  if (sandboxGuard && allowlist.length === 0) {
    throw new Error(
      `Configuration error: AUTH_MAIL_ALLOWLIST is required for the SMTP mail transport outside production (current: ${environment}); refusing to send auth mail without an explicit recipient allowlist.`,
    );
  }
  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    appName: appName ?? 'User Service',
    sandboxGuard,
    allowlist,
  };
}

export function validateSmtpSettings(input: Pick<SmtpEnv, 'SMTP_PORT' | 'SMTP_SECURE'>): void {
  parsePort(input.SMTP_PORT);
  parseSecure(input.SMTP_SECURE);
}

function recipientDomain(to: string): string {
  return to.split('@')[1]?.toLowerCase() ?? 'invalid';
}

// Builds the production delivery seam from the Workers-native SMTP client.
// The runtime `connect` is resolved lazily inside the first send so
// configuration resolution and module import never open a connection; TLS is
// always negotiated (implicit TLS or mandatory STARTTLS) and certificate
// verification can never be disabled through supported application
// configuration.
//
// Ticket #71: this replaced the previous Nodemailer 10 transport, whose
// `node:tls` STARTTLS path the Workers runtime rejects. No Nodemailer
// dependency remains.
function createWorkersSmtpSend(config: SmtpTransportConfig): SmtpSendMail {
  return createWorkersSmtpSendMail({
    host: config.host,
    port: config.port,
    secure: config.secure,
    user: config.user,
    pass: config.pass,
  });
}

// Maps a delivery throw to safe telemetry fields (ticket #73). Typed
// `SmtpDeliveryError` values contribute their phase and reply code directly;
// anything else (a rejected send seam, an unexpected throwable) is classified
// as a `transport` failure with no reply code. Raw exception text is never
// returned, so provider reply text and connection details cannot leak.
function toSmtpFailure(error: unknown): { phase: SmtpFailurePhase; replyCode?: number } {
  if (error instanceof SmtpDeliveryError) {
    return error.replyCode === undefined
      ? { phase: error.phase }
      : { phase: error.phase, replyCode: error.replyCode };
  }
  return { phase: 'transport' };
}

export class SmtpAuthMailer implements AuthMailer {
  private readonly config: SmtpTransportConfig;
  private readonly send: SmtpSendMail;
  private readonly log: SmtpMailLogger;

  constructor(
    config: SmtpTransportConfig,
    send: SmtpSendMail = createWorkersSmtpSend(config),
    log: SmtpMailLogger = (record) => {
      console.log(JSON.stringify(record));
    },
  ) {
    this.config = config;
    this.send = send;
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
    purpose: SmtpMailPurpose;
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
        transport: 'smtp',
        recipientDomain: domain,
        reason: 'allowlist',
      });
      return { status: 'skipped' };
    }
    let result: SmtpSendResult;
    try {
      result = await this.send({
        from: this.config.from,
        to: input.to,
        subject: input.subject,
        html: input.html,
        text: input.text,
      });
    } catch (error) {
      const failure = toSmtpFailure(error);
      this.log({
        level: 'error',
        event: 'auth-mail.failed',
        purpose: input.purpose,
        transport: 'smtp',
        recipientDomain: domain,
        reason: 'send-failed',
        smtpPhase: failure.phase,
        ...(failure.replyCode === undefined ? {} : { smtpReplyCode: failure.replyCode }),
      });
      return { status: 'failed' };
    }
    this.log({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: input.purpose,
      transport: 'smtp',
      recipientDomain: domain,
      ...(result.messageId === undefined ? {} : { providerMessageId: result.messageId }),
    });
    return { status: 'sent' };
  }
}
