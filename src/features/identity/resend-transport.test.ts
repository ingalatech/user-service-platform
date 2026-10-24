import { describe, expect, it } from 'vitest';
import type { Env } from '../../env.js';
import {
  InMemoryAuthMailer,
  ResendAuthMailer,
  DevelopmentAuthMailer,
  resolveAuthMailer,
} from './mailer.js';
import { renderPasswordResetEmail, renderVerificationEmail } from './mail-templates.js';
import {
  isAllowlisted,
  resolveResendConfig,
  type AuthMailLogRecord,
  type ResendTransportConfig,
} from './resend-transport.js';

// Seam under test (ticket #13, ADR-0010): the production mail transport
// boundary. Provider I/O goes through an injected fetch stub and telemetry
// through an injected log sink, so these tests prove adapter behaviour,
// redaction and environment safety without live delivery or network calls.

function stubFetch(handler: (url: string, init?: RequestInit) => Response): typeof fetch {
  return ((url: string, init?: RequestInit) => Promise.resolve(handler(url, init))) as typeof fetch;
}

function okResponse(id: string): Response {
  return new Response(JSON.stringify({ id }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function errorResponse(status: number, message: string): Response {
  return new Response(JSON.stringify({ message }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function productionEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'production',
    RESEND_API_KEY: 're_test_key_do_not_use',
    AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
    AUTH_APP_NAME: 'User Service',
    ...overrides,
  } as Env;
}

function sandboxEnv(overrides: Partial<Env> = {}): Env {
  return {
    ENVIRONMENT: 'sandbox',
    RESEND_API_KEY: 're_test_key_do_not_use',
    AUTH_MAIL_FROM: 'User Service <noreply@example.com>',
    AUTH_APP_NAME: 'User Service',
    AUTH_MAIL_ALLOWLIST: 'ops@example.com,@example.org',
    ...overrides,
  } as Env;
}

interface TestTransport {
  mailer: ResendAuthMailer;
  records: AuthMailLogRecord[];
}

function testTransport(
  env: Env,
  handler: (url: string, init?: RequestInit) => Response,
): TestTransport & {
  config: ResendTransportConfig;
} {
  const config = resolveResendConfig(env);
  const records: AuthMailLogRecord[] = [];
  const mailer = new ResendAuthMailer(config, stubFetch(handler), (record) => {
    records.push(record);
  });
  return { mailer, records, config };
}

describe('renderVerificationEmail', () => {
  it('renders application-owned subject, html and text bodies from branding inputs', () => {
    const template = renderVerificationEmail({
      appName: 'User Service',
      url: 'https://example.com/verify?token=abc123',
    });

    expect(template.subject).toContain('User Service');
    expect(template.text).toContain('https://example.com/verify?token=abc123');
    expect(template.html).toContain('https://example.com/verify?token=abc123');
    expect(template.html).toContain('User Service');
  });

  it('escapes branding and URL inputs in the html body', () => {
    const template = renderVerificationEmail({
      appName: '<script>alert(1)</script>',
      url: 'https://example.com/verify?token=a&next=<b>',
    });

    expect(template.html).not.toContain('<script>alert(1)</script>');
    expect(template.html).toContain('&lt;script&gt;');
    expect(template.html).toContain('&amp;');
  });
});

describe('renderPasswordResetEmail', () => {
  it('renders application-owned subject, html and text bodies from branding inputs', () => {
    const template = renderPasswordResetEmail({
      appName: 'User Service',
      url: 'https://example.com/reset?token=reset123',
    });

    expect(template.subject).toContain('User Service');
    expect(template.text).toContain('https://example.com/reset?token=reset123');
    expect(template.html).toContain('https://example.com/reset?token=reset123');
  });
});

describe('ResendAuthMailer', () => {
  it('sends verification mail through the Resend HTTP API with the rendered template', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const { mailer, records } = testTransport(productionEnv(), (url, init) => {
      seen.push({ url, init });
      return okResponse('msg_123');
    });

    const delivery = await mailer.sendVerificationEmailWithResult({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(delivery).toEqual({ status: 'sent' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe('https://api.resend.com/emails');
    const headers = seen[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_test_key_do_not_use');
    const rawBody = seen[0]?.init?.body;
    if (typeof rawBody !== 'string') {
      throw new Error('Expected a JSON string request body.');
    }
    const body = JSON.parse(rawBody) as {
      from: string;
      to: string[];
      subject: string;
      html: string;
      text: string;
    };
    expect(body.from).toBe('User Service <noreply@example.com>');
    expect(body.to).toEqual(['ada@example.com']);
    expect(body.subject.length).toBeGreaterThan(0);
    expect(body.html).toContain('https://example.com/verify?token=secret-token');
    expect(body.text).toContain('https://example.com/verify?token=secret-token');

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: 'email-verification',
      transport: 'resend',
      recipientDomain: 'example.com',
      providerMessageId: 'msg_123',
    });
    // Redaction: tokens, URLs, bodies and credentials never reach telemetry.
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('re_test_key_do_not_use');
    expect(transcript).not.toContain('ada@example.com');
  });

  it('sends password-reset mail with the reset template', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const { mailer, records } = testTransport(productionEnv(), (url, init) => {
      seen.push({ url, init });
      return okResponse('msg_456');
    });

    await mailer.sendPasswordResetEmail({
      to: 'grace@example.com',
      url: 'https://example.com/reset?token=reset-secret',
      token: 'reset-secret',
    });

    expect(seen).toHaveLength(1);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'info',
      event: 'auth-mail.sent',
      purpose: 'password-reset',
      transport: 'resend',
      providerMessageId: 'msg_456',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('reset-secret');
    expect(transcript).not.toContain('re_test_key_do_not_use');
  });

  it('records a structured failure without throwing when the provider rejects delivery', async () => {
    const { mailer, records } = testTransport(productionEnv(), () =>
      errorResponse(401, 'Invalid API key'),
    );

    // The auth response path must not fail when mail delivery fails: the
    // verification gate stays enforced and retry happens via resend.
    const delivery = await mailer.sendVerificationEmailWithResult({
      to: 'ada@example.com',
      url: 'https://example.com/verify?token=secret-token',
      token: 'secret-token',
    });

    expect(delivery).toEqual({ status: 'failed' });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'auth-mail.failed',
      purpose: 'email-verification',
      transport: 'resend',
      recipientDomain: 'example.com',
      status: 401,
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('secret-token');
    expect(transcript).not.toContain('https://example.com/verify');
    expect(transcript).not.toContain('re_test_key_do_not_use');
  });

  it('records a structured failure without throwing when the network fails', async () => {
    const records: AuthMailLogRecord[] = [];
    const mailer = new ResendAuthMailer(
      resolveResendConfig(productionEnv()),
      () => Promise.reject(new Error('connection reset')),
      (record) => {
        records.push(record);
      },
    );

    await mailer.sendPasswordResetEmail({
      to: 'ada@example.com',
      url: 'https://example.com/reset?token=reset-secret',
      token: 'reset-secret',
    });

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'error',
      event: 'auth-mail.failed',
      purpose: 'password-reset',
      transport: 'resend',
      reason: 'network-error',
    });
  });
});

describe('isAllowlisted', () => {
  it('matches exact emails case-insensitively and @domain entries', () => {
    expect(isAllowlisted('ops@example.com', ['ops@example.com'])).toBe(true);
    expect(isAllowlisted('OPS@example.com', ['ops@example.com'])).toBe(true);
    expect(isAllowlisted('anyone@example.org', ['@example.org'])).toBe(true);
    expect(isAllowlisted('anyone@example.org', ['example.org'])).toBe(true);
    expect(isAllowlisted('mallory@evil.com', ['ops@example.com', '@example.org'])).toBe(false);
    expect(isAllowlisted('anyone@example.com', [])).toBe(false);
  });
});

describe('sandbox allowlist guard', () => {
  it('delivers to allowlisted recipients in sandbox', async () => {
    let calls = 0;
    const { mailer, records } = testTransport(sandboxEnv(), () => {
      calls += 1;
      return okResponse('msg_sandbox');
    });

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

    expect(calls).toBe(2);
    expect(records).toHaveLength(2);
    expect(records.every((record) => record.event === 'auth-mail.sent')).toBe(true);
  });

  it('skips non-allowlisted recipients in sandbox without calling the provider', async () => {
    let calls = 0;
    const { mailer, records } = testTransport(sandboxEnv(), () => {
      calls += 1;
      return okResponse('msg_should_not_happen');
    });

    const delivery = await mailer.sendVerificationEmailWithResult({
      to: 'real-user@production.com',
      url: 'https://example.com/verify?token=prod-token',
      token: 'prod-token',
    });

    expect(delivery).toEqual({ status: 'skipped' });
    expect(calls).toBe(0);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      level: 'warn',
      event: 'auth-mail.sandbox-skipped',
      purpose: 'email-verification',
      transport: 'resend',
    });
    const transcript = JSON.stringify(records);
    expect(transcript).not.toContain('prod-token');
    expect(transcript).not.toContain('real-user@production.com');
  });
});

describe('resolveResendConfig', () => {
  it('fails closed in production without an API key or sender', () => {
    expect(() => resolveResendConfig(productionEnv({ RESEND_API_KEY: '' }))).toThrow(
      /RESEND_API_KEY/,
    );
    expect(() => resolveResendConfig(productionEnv({ AUTH_MAIL_FROM: '' }))).toThrow(
      /AUTH_MAIL_FROM/,
    );
  });

  it('fails closed in sandbox without an explicit allowlist', () => {
    expect(() => resolveResendConfig(sandboxEnv({ AUTH_MAIL_ALLOWLIST: '' }))).toThrow(
      /AUTH_MAIL_ALLOWLIST/,
    );
    expect(() => resolveResendConfig(sandboxEnv({ AUTH_MAIL_ALLOWLIST: undefined }))).toThrow(
      /AUTH_MAIL_ALLOWLIST/,
    );
  });

  it('treats the legacy staging name as a sandbox context', () => {
    expect(() =>
      resolveResendConfig(sandboxEnv({ ENVIRONMENT: 'staging', AUTH_MAIL_ALLOWLIST: '' })),
    ).toThrow(/AUTH_MAIL_ALLOWLIST/);
    const config = resolveResendConfig(sandboxEnv({ ENVIRONMENT: 'staging' }));
    expect(config.sandboxGuard).toBe(true);
  });

  it('disables the allowlist guard in production', () => {
    expect(resolveResendConfig(productionEnv()).sandboxGuard).toBe(false);
    expect(resolveResendConfig(sandboxEnv()).sandboxGuard).toBe(true);
  });
});

describe('resolveAuthMailer', () => {
  it('returns the production transport in production without changing identity contracts', () => {
    const mailer = resolveAuthMailer(productionEnv());
    expect(mailer).toBeInstanceOf(ResendAuthMailer);
  });

  it('returns the guarded transport in sandbox and staging', () => {
    expect(resolveAuthMailer(sandboxEnv())).toBeInstanceOf(ResendAuthMailer);
    expect(resolveAuthMailer(sandboxEnv({ ENVIRONMENT: 'staging' }))).toBeInstanceOf(
      ResendAuthMailer,
    );
  });

  it('keeps local and test environments on non-network transports', () => {
    expect(resolveAuthMailer({ ENVIRONMENT: 'local' })).toBeInstanceOf(DevelopmentAuthMailer);
    expect(resolveAuthMailer({ ENVIRONMENT: 'test' })).toBeInstanceOf(DevelopmentAuthMailer);
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

describe('application-owned action URLs through Resend (ticket #77)', () => {
  it('renders fallback and custom consumer action URLs verbatim without engine callbacks', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const { mailer } = testTransport(productionEnv(), (url, init) => {
      seen.push({ url, init });
      return okResponse('msg_action');
    });

    // The transformation happens above the transport (auth.ts): the adapter
    // renders whatever application-owned action URL it receives, so the
    // service-owned fallback pages and branded consumer pages both survive
    // delivery unchanged.
    await mailer.sendVerificationEmail({
      to: 'ada@example.com',
      url: 'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
      token: 'fallback-token',
    });
    await mailer.sendPasswordResetEmail({
      to: 'ada@example.com',
      url: 'https://app.example.com/reset?next=%2Fwelcome&token=custom-token',
      token: 'custom-token',
    });

    expect(seen).toHaveLength(2);
    const bodies = seen.map((entry) => {
      const raw = entry.init?.body;
      if (typeof raw !== 'string') {
        throw new Error('Expected a JSON string request body.');
      }
      return JSON.parse(raw) as { html: string; text: string };
    });
    for (const body of bodies) {
      expect(body.html).not.toContain('/api/auth');
      expect(body.text).not.toContain('/api/auth');
    }
    expect(bodies[0]?.text).toContain(
      'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
    );
    expect(bodies[0]?.html).toContain(
      'http://localhost:8787/auth-actions/verify-email?token=fallback-token',
    );
    expect(bodies[1]?.text).toContain(
      'https://app.example.com/reset?next=%2Fwelcome&token=custom-token',
    );
    expect(bodies[1]?.html).toContain('https://app.example.com/reset');
    expect(bodies[1]?.html).toContain('token=custom-token');
  });
});
