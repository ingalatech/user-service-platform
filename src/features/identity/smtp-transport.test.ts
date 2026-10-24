import { describe, expect, it } from 'vitest';
import type { Env } from '../../env.js';
import { InMemoryAuthMailer, resolveAuthMailer, SmtpAuthMailer } from './mailer.js';
import { SmtpDeliveryError } from './smtp-client.js';
import {
  resolveSmtpConfig,
  type SmtpMailLogRecord,
  type SmtpTransportConfig,
} from './smtp-transport.js';

// Seam under test (ticket #58, ADR-0010): the provider-neutral SMTP mail
// transport boundary. Delivery I/O goes through an injected send stub and
// telemetry through an injected log sink, so these tests prove adapter
// behaviour, configuration validation, redaction and environment safety
// without live delivery, credentials or network calls.

interface CapturedMail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
}

function smtpEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 's3cret-password-do-not-use',
    AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
    AUTH_APP_NAME: 'User Service',
    ...overrides,
  } as Env;
}

function sandboxSmtpEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'sandbox',
    SMTP_HOST: 'smtp.example.com',
    SMTP_PORT: '587',
    SMTP_SECURE: 'false',
    SMTP_USER: 'mailer@example.com',
    SMTP_PASSWORD: 's3cret-password-do-not-use',
    AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
    AUTH_APP_NAME: 'User Service',
    AUTH_MAIL_ALLOWLIST: 'ops@example.com,@example.org',
    ...overrides,
  } as Env;
}

interface TestTransport {
  mailer: SmtpAuthMailer;
  records: SmtpMailLogRecord[];
  sent: CapturedMail[];
}

function testTransport(
  env: Env,
  handler?: (mail: CapturedMail) => { messageId?: string },
): TestTransport & {
  config: SmtpTransportConfig;
} {
  const config = resolveSmtpConfig(env);
  const records: SmtpMailLogRecord[] = [];
  const sent: CapturedMail[] = [];
  const mailer = new SmtpAuthMailer(
    config,
    (mail) => {
      sent.push(mail);
      const outcome = handler?.(mail);
      return Promise.resolve(outcome ?? { messageId: 'smtp-msg-1' });
    },
    (record) => {
      records.push(record);
    },
  );
  return { mailer, records, sent, config };
}

describe('resolveSmtpConfig', () => {
  it('resolves a valid STARTTLS submission configuration', () => {
    const config = resolveSmtpConfig(smtpEnv());

    expect(config.host).toBe('smtp.example.com');
    expect(config.port).toBe(587);
    expect(config.secure).toBe(false);
    expect(config.from).toBe('User Service <noreply@example.com>');
    expect(config.appName).toBe('User Service');
    expect(config.sandboxGuard).toBe(false);
  });

  it('resolves an implicit-TLS submission configuration', () => {
    const config = resolveSmtpConfig(smtpEnv({ SMTP_PORT: '465', SMTP_SECURE: 'true' }));

    expect(config.port).toBe(465);
    expect(config.secure).toBe(true);
  });

  it('exposes no supported knob that disables TLS certificate verification', () => {
    const config = resolveSmtpConfig(
      smtpEnv({
        SMTP_TLS_INSECURE: 'true',
        SMTP_REJECT_UNAUTHORIZED: 'false',
      } as Partial<Env>),
    );

    expect(config).not.toHaveProperty('rejectUnauthorized');
    expect(config).not.toHaveProperty('ignoreTLS');
    expect(config).not.toHaveProperty('tls');
    expect(config).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      user: 'mailer@example.com',
      pass: 's3cret-password-do-not-use',
      from: 'User Service <noreply@example.com>',
      appName: 'User Service',
      sandboxGuard: false,
      allowlist: [],
    });
  });

  it('fails closed when the SMTP host is missing or provider-specific', () => {
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_HOST: '' }))).toThrow(/SMTP_HOST/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_HOST: undefined }))).toThrow(/SMTP_HOST/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_HOST: 'smtp://smtp.example.com' }))).toThrow(
      /SMTP_HOST/,
    );
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_HOST: 'smtp host' }))).toThrow(/SMTP_HOST/);
  });

  it('fails closed on malformed ports', () => {
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PORT: '' }))).toThrow(/SMTP_PORT/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PORT: 'not-a-port' }))).toThrow(/SMTP_PORT/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PORT: '0' }))).toThrow(/SMTP_PORT/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PORT: '99999' }))).toThrow(/SMTP_PORT/);
  });

  it('rejects port 25 as Workers-invalid', () => {
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PORT: '25' }))).toThrow(/SMTP_PORT/);
  });

  it('rejects unknown TLS mode values instead of guessing', () => {
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_SECURE: '' }))).toThrow(/SMTP_SECURE/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_SECURE: 'starttls' }))).toThrow(/SMTP_SECURE/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_SECURE: undefined }))).toThrow(/SMTP_SECURE/);
  });

  it('fails closed without authentication credentials or a sender', () => {
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_USER: '' }))).toThrow(/SMTP_USER/);
    expect(() => resolveSmtpConfig(smtpEnv({ SMTP_PASSWORD: '' }))).toThrow(/SMTP_PASSWORD/);
    expect(() => resolveSmtpConfig(smtpEnv({ AUTH_MAIL_FROM: '' }))).toThrow(/AUTH_MAIL_FROM/);
  });

  it('fails closed in sandbox without an explicit allowlist', () => {
    expect(() => resolveSmtpConfig(sandboxSmtpEnv({ AUTH_MAIL_ALLOWLIST: '' }))).toThrow(
      /AUTH_MAIL_ALLOWLIST/,
    );
    expect(() => resolveSmtpConfig(sandboxSmtpEnv({ AUTH_MAIL_ALLOWLIST: undefined }))).toThrow(
      /AUTH_MAIL_ALLOWLIST/,
    );
  });

  it('treats the legacy staging name as a sandbox context', () => {
    expect(() =>
      resolveSmtpConfig(sandboxSmtpEnv({ ENVIRONMENT: 'staging', AUTH_MAIL_ALLOWLIST: '' })),
    ).toThrow(/AUTH_MAIL_ALLOWLIST/);
    expect(resolveSmtpConfig(sandboxSmtpEnv({ ENVIRONMENT: 'staging' })).sandboxGuard).toBe(true);
  });

  it('disables the allowlist guard in production', () => {
    expect(resolveSmtpConfig(smtpEnv()).sandboxGuard).toBe(false);
    expect(resolveSmtpConfig(sandboxSmtpEnv()).sandboxGuard).toBe(true);
  });

  it('never echoes credentials or addresses in validation errors', () => {
    let message = '';
    try {
      resolveSmtpConfig(smtpEnv({ SMTP_HOST: '', SMTP_PASSWORD: 's3cret-password-do-not-use' }));
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).toContain('SMTP_HOST');
    expect(message).not.toContain('s3cret-password-do-not-use');
    expect(message).not.toContain('mailer@example.com');
  });
});

describe('SmtpAuthMailer', () => {
  it('sends verification mail through the SMTP transport with the shared template', async () => {
    const { mailer, records, sent } = testTransport(smtpEnv());

    const delivery = await mailer.sendVerificationEmailWithResult({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(delivery).toEqual({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('ada@example.com');
    expect(sent[0]?.from).toBe('User Service <noreply@example.com>');
    expect(sent[0]?.subject.length).toBeGreaterThan(0);
    expect(sent[0]?.html).toContain('https://example.com/verify?token=secret-token');
    expect(sent[0]?.text).toContain('https://example.com/verify?token=secret-token');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: 'email-verification',
      transport: 'smtp',
      recipientDomain: 'example.com',
      providerMessageId: 'smtp-msg-1',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('s3cret-password-do-not-use');
    expect(transcript).not.toContain('mailer@example.com');
    expect(transcript).not.toContain('ada@example.com');
  });

  it('sends password-reset mail with the reset template', async () => {
    const { mailer, records, sent } = testTransport(smtpEnv());

    await mailer.sendPasswordResetEmail({
      to: 'grace@example.com',
      url: 'https://example.com/reset?token=reset-secret',
      token: 'reset-secret',
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.subject).toContain('Reset');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: 'password-reset',
      transport: 'smtp',
      providerMessageId: 'smtp-msg-1',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('reset-secret');
    expect(transcript).not.toContain('s3cret-password-do-not-use');
  });

  it('records a structured failure without throwing when delivery fails', async () => {
    const records: SmtpMailLogRecord[] = [];
    const mailer = new SmtpAuthMailer(
      resolveSmtpConfig(smtpEnv()),
      () => Promise.reject(new Error('connection reset')),
      (record) => {
        records.push(record);
      },
    );

    await mailer.sendVerificationEmail({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'auth-mail.failed',
      purpose: 'email-verification',
      transport: 'smtp',
      recipientDomain: 'example.com',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('s3cret-password-do-not-use');
  });

  it('propagates the safe SMTP phase and reply code for AUTH failures', async () => {
    const records: SmtpMailLogRecord[] = [];
    const mailer = new SmtpAuthMailer(
      resolveSmtpConfig(smtpEnv()),
      () =>
        Promise.reject(
          new SmtpDeliveryError('password', {
            replyCode: 535,
          }),
        ),
      (record) => {
        records.push(record);
      },
    );

    await mailer.sendVerificationEmail({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'auth-mail.failed',
      purpose: 'email-verification',
      transport: 'smtp',
      recipientDomain: 'example.com',
      reason: 'send-failed',
      smtpPhase: 'password',
      smtpReplyCode: 535,
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('s3cret-password-do-not-use');
    expect(transcript).not.toContain('mailer@example.com');
    expect(transcript).not.toContain('ada@example.com');
  });

  it('marks transport failures without an SMTP reply as transport phase', async () => {
    const records: SmtpMailLogRecord[] = [];
    const mailer = new SmtpAuthMailer(
      resolveSmtpConfig(smtpEnv()),
      () => Promise.reject(new Error('connection reset by 10.0.0.1: provider says bad thing')),
      (record) => {
        records.push(record);
      },
    );

    await mailer.sendVerificationEmail({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'auth-mail.failed',
      purpose: 'email-verification',
      transport: 'smtp',
      recipientDomain: 'example.com',
      reason: 'send-failed',
      smtpPhase: 'transport',
    });
    expect(records[0]).not.toHaveProperty('smtpReplyCode');
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('connection reset');
    expect(transcript).not.toContain('10.0.0.1');
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('ada@example.com');
  });
});

describe('sandbox allowlist guard for SMTP', () => {
  it('delivers to allowlisted recipients in sandbox', async () => {
    const { mailer, records, sent } = testTransport(sandboxSmtpEnv());

    await mailer.sendVerificationEmail({
      to: 'ops@example.com',
      url: 'https://example.com/verify?token=t1',
      token: 't1',
    });
    await mailer.sendPasswordResetEmail({
      to: 'anyone@example.org',
      url: 'https://example.com/reset?token=t2',
      token: 't2',
    });

    expect(sent).toHaveLength(2);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.event === 'auth-mail.sent')).toBe(true);
  });

  it('skips non-allowlisted recipients in sandbox without calling the transport', async () => {
    const { mailer, records, sent } = testTransport(sandboxSmtpEnv());

    const delivery = await mailer.sendVerificationEmailWithResult({
      to: 'real-user@production.com',
      url: 'https://example.com/verify?token=prod-token',
      token: 'prod-token',
    });

    expect(delivery).toEqual({ status: 'skipped' });
    expect(sent).toHaveLength(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      event: 'auth-mail.sandbox-skipped',
      purpose: 'email-verification',
      transport: 'smtp',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('prod-token');
    expect(transcript).not.toContain('real-user@production.com');
  });
});

describe('resolveAuthMailer with SMTP', () => {
  it('returns the SMTP transport when selected', () => {
    const mailer = resolveAuthMailer({ ...smtpEnv(), AUTH_MAIL_TRANSPORT: 'smtp' });
    expect(mailer).toBeInstanceOf(SmtpAuthMailer);
  });
  it('keeps the in-memory transport available for credential-free tests', () => {
    expect(resolveAuthMailer({ AUTH_MAIL_TRANSPORT: 'inmemory' })).toBeInstanceOf(
      InMemoryAuthMailer,
    );
  });

  it('rejects unknown transport selections instead of silently downgrading', () => {
    expect(() =>
      resolveAuthMailer({ ENVIRONMENT: 'local', AUTH_MAIL_TRANSPORT: 'sendmail' }),
    ).toThrow(/AUTH_MAIL_TRANSPORT/);
  });
});

describe('application-owned action URLs through SMTP (ticket #77)', () => {
  it('renders fallback and custom consumer action URLs verbatim without engine callbacks', async () => {
    const { mailer, sent } = testTransport(smtpEnv());

    // The transformation happens above the transport (auth.ts): the adapter
    // renders whatever application-owned action URL it receives, so the
    // service-owned fallback pages and branded consumer pages both survive
    // delivery unchanged.
    await mailer.sendVerificationEmail({
      to: 'ops@example.com',
      url: 'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
      token: 'fallback-token',
    });
    await mailer.sendPasswordResetEmail({
      to: 'ops@example.com',
      url: 'https://app.example.com/reset?next=%2Fwelcome&token=custom-token',
      token: 'custom-token',
    });

    expect(sent).toHaveLength(2);
    for (const mail of sent) {
      expect(mail.html).not.toContain('/api/auth');
      expect(mail.text).not.toContain('/api/auth');
    }
    expect(sent[0]?.text).toContain(
      'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
    );
    expect(sent[0]?.html).toContain(
      'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
    );
    expect(sent[1]?.text).toContain(
      'https://app.example.com/reset?next=%2Fwelcome&token=custom-token',
    );
    expect(sent[1]?.html).toContain('https://app.example.com/reset');
    expect(sent[1]?.html).toContain('token=custom-token');
  });
});
