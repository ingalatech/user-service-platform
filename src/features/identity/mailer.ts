import type { Env } from '../../env.js';
import { ResendAuthMailer, resolveResendConfig } from './resend-transport.js';
import { SmtpAuthMailer, resolveSmtpConfig } from './smtp-transport.js';

// Application-owned transactional auth mail boundary (ADR-0010). Better Auth
// email callbacks adapt into these purpose-specific operations; provider SDK
// types never cross this interface. Template/branding inputs stay minimal so
// transports cannot observe business objects.
export interface VerificationMessage {
  readonly to: string;
  readonly url: string;
  readonly token: string;
  readonly expiresAt?: Date;
}

export interface PasswordResetMessage {
  readonly to: string;
  readonly url: string;
  readonly token: string;
  readonly expiresAt?: Date;
}

export type AuthMailDeliveryResult =
  { readonly status: 'sent' } | { readonly status: 'skipped' } | { readonly status: 'failed' };

export interface AuthMailer {
  sendVerificationEmail(message: VerificationMessage): Promise<void>;
  // Optional result-aware seam for bootstrap's durable delivery state. Existing
  // application mailers remain source-compatible and resolve as sent.
  sendVerificationEmailWithResult?(message: VerificationMessage): Promise<AuthMailDeliveryResult>;
  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void>;
}

interface CapturedMessage extends VerificationMessage {
  readonly capturedAt: string;
}

// In-memory AuthMailer for Workers-runtime tests. Captured actions are
// readable only inside the isolated test process; verification and
// password-reset URLs and tokens never reach logs, events, or error payloads
// through this transport.
export class InMemoryAuthMailer implements AuthMailer {
  private readonly messages: CapturedMessage[] = [];
  private readonly resetMessages: CapturedMessage[] = [];

  get sent(): readonly CapturedMessage[] {
    return this.messages;
  }

  get passwordResets(): readonly CapturedMessage[] {
    return this.resetMessages;
  }

  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    return this.sendVerificationEmailWithResult(message).then(() => undefined);
  }

  sendVerificationEmailWithResult(message: VerificationMessage): Promise<AuthMailDeliveryResult> {
    this.messages.push({ ...message, capturedAt: new Date().toISOString() });
    return Promise.resolve({ status: 'sent' });
  }

  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
    this.resetMessages.push({ ...message, capturedAt: new Date().toISOString() });
    return Promise.resolve();
  }

  clear(): void {
    this.messages.length = 0;
    this.resetMessages.length = 0;
  }
}

// Local development sink: records only operational metadata (recipient domain
// and purpose) so verification and password-reset flows can be exercised
// without credentials or network delivery. Bodies, tokens and action URLs are
// never logged.
export class DevelopmentAuthMailer implements AuthMailer {
  sendVerificationEmail(message: VerificationMessage): Promise<void> {
    return this.sendVerificationEmailWithResult(message).then(() => undefined);
  }

  sendVerificationEmailWithResult(message: VerificationMessage): Promise<AuthMailDeliveryResult> {
    const domain = message.to.split('@')[1] ?? 'invalid';
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auth-mail.scheduled',
        purpose: 'email-verification',
        recipientDomain: domain,
      }),
    );
    return Promise.resolve({ status: 'skipped' });
  }

  sendPasswordResetEmail(message: PasswordResetMessage): Promise<void> {
    const domain = message.to.split('@')[1] ?? 'invalid';
    console.log(
      JSON.stringify({
        level: 'info',
        event: 'auth-mail.scheduled',
        purpose: 'password-reset',
        recipientDomain: domain,
      }),
    );
    return Promise.resolve();
  }
}

// Resolves the mailer for the current environment. Tests inject an
// InMemoryAuthMailer explicitly or select it via AUTH_MAIL_TRANSPORT; local
// development uses the metadata-only sink and never reads provider secrets.
// Staging, sandbox and production resolve their profile transport (ticket
// #13 Resend, ticket #58 SMTP) and fail closed when its configuration is
// missing rather than silently dropping mail.
export function resolveAuthMailer(
  env: Pick<
    Env,
    | 'ENVIRONMENT'
    | 'AUTH_MAIL_TRANSPORT'
    | 'RESEND_API_KEY'
    | 'SMTP_HOST'
    | 'SMTP_PORT'
    | 'SMTP_SECURE'
    | 'SMTP_USER'
    | 'SMTP_PASSWORD'
    | 'AUTH_MAIL_FROM'
    | 'AUTH_APP_NAME'
    | 'AUTH_MAIL_ALLOWLIST'
  >,
  override?: AuthMailer,
): AuthMailer {
  if (override !== undefined) {
    return override;
  }
  const selection = env.AUTH_MAIL_TRANSPORT?.trim().toLowerCase();
  if (selection === 'inmemory') {
    return new InMemoryAuthMailer();
  }
  if (selection === 'resend') {
    return new ResendAuthMailer(resolveResendConfig(env));
  }
  if (selection === 'smtp') {
    return new SmtpAuthMailer(resolveSmtpConfig(env));
  }
  if (selection !== undefined && selection !== '') {
    throw new Error(
      `Unknown AUTH_MAIL_TRANSPORT "${selection}"; expected "inmemory", "resend" or "smtp".`,
    );
  }
  const environment = env.ENVIRONMENT ?? 'local';
  if (environment === 'staging' || environment === 'sandbox' || environment === 'production') {
    return new ResendAuthMailer(resolveResendConfig(env));
  }
  return new DevelopmentAuthMailer();
}

// Identity/session permission reads do not send mail. Keep transport validation
// fail-closed at the first actual send without coupling those reads to SMTP.
export function deferredAuthMailer(
  env: Parameters<typeof resolveAuthMailer>[0],
  override?: AuthMailer,
): AuthMailer {
  let resolved: AuthMailer | undefined = override;
  const current = (): AuthMailer => (resolved ??= resolveAuthMailer(env));
  return {
    sendVerificationEmail: (message) => current().sendVerificationEmail(message),
    sendVerificationEmailWithResult: async (message) => {
      const mailer = current();
      if (mailer.sendVerificationEmailWithResult !== undefined) {
        return mailer.sendVerificationEmailWithResult(message);
      }
      await mailer.sendVerificationEmail(message);
      return { status: 'sent' };
    },
    sendPasswordResetEmail: (message) => current().sendPasswordResetEmail(message),
  };
}

export { ResendAuthMailer } from './resend-transport.js';
export type {
  AuthMailLogger,
  AuthMailLogRecord,
  AuthMailPurpose,
  ResendTransportConfig,
} from './resend-transport.js';
export { SmtpAuthMailer } from './smtp-transport.js';
export type {
  SmtpMailLogger,
  SmtpMailLogRecord,
  SmtpMailPurpose,
  SmtpOutboundMail,
  SmtpSendMail,
  SmtpSendResult,
  SmtpTransportConfig,
} from './smtp-transport.js';
export type { SmtpFailureCause, SmtpFailurePhase } from './smtp-client.js';
export { SmtpDeliveryError } from './smtp-client.js';
