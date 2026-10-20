import { readFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildTargetWranglerConfig } from '../../scripts/deploy/materialize.js';
import { resolveTargetDeployment, type TargetsFile } from '../../scripts/deploy/targets.js';
import { loadTargetsFromRepo, provisionedTargetsForContract } from './deploy-test-utils.js';
import {
  assertSafeSmokeTarget,
  assertSandboxSmokeEmail,
  buildSmokeEmail,
  classifyExactSmokeLogin,
  parseExactSmokeEmail,
  resolveSmokeConfig,
  resolveSmokeEmail,
} from '../../scripts/smoke-sandbox.js';
import { resolveAuthSecret } from '../../src/features/identity/secret.js';
import { isAllowlisted, parseAllowlist } from '../../src/features/identity/resend-transport.js';
import {
  resolveSmtpConfig,
  SmtpAuthMailer,
  type SmtpMailLogRecord,
} from '../../src/features/identity/smtp-transport.js';

// Seam under test (tickets #14, #78): static deployment-contract assertions plus
// the sandbox smoke-script guards. Ticket #121 wires the versioned sandbox
// allowlist through the existing SMTP mailer guard to prove all three
// allowlisted recipients deliver and unrelated recipients stay skipped.
// These tests pin the ADR-0008/ADR-0009/ADR-0010
// invariants that must hold before the identity service is operable in
// sandbox: isolated per-target resources, version-controlled secret-free
// config, Cloudflare-native observability, sandbox-only mail, and explicit
// local release operations. Tests never touch Cloudflare credentials or
// provisioned resources.

// Minimal JSONC reader for wrangler.jsonc: strips // and /* */ comments only
// outside string literals so values containing "//" survive intact.
function readJsonc(path: string): unknown {
  const raw = readFileSync(path, 'utf8');
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    const next = raw[i + 1];
    if (ch === undefined) {
      break;
    }
    if (inString) {
      out += ch;
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      i += 1;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < raw.length && raw[i] !== '\n') {
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < raw.length && !(raw[i] === '*' && raw[i + 1] === '/')) {
        i += 1;
      }
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  // JSONC permits trailing commas; JSON.parse does not.
  const withoutTrailingCommas = out.replace(/,\s*([}\]])/g, '$1');
  return JSON.parse(withoutTrailingCommas) as unknown;
}

interface WranglerEnv {
  vars?: Record<string, string>;
  d1_databases?: {
    binding?: string;
    database_name?: string;
    database_id?: string;
    migrations_dir?: string;
  }[];
  observability?: { enabled?: boolean };
}

interface WranglerConfig {
  vars?: Record<string, string>;
  d1_databases?: WranglerEnv['d1_databases'];
  observability?: { enabled?: boolean };
  env?: Record<string, WranglerEnv>;
}

function loadWrangler(): WranglerConfig {
  return readJsonc('wrangler.jsonc') as WranglerConfig;
}

function loadTargets(): TargetsFile {
  return loadTargetsFromRepo();
}

// Real database ids are provisioned out-of-band and recorded in
// deploy/targets.json; contract tests resolve a provisioned copy so naming
// and isolation hold independently of provisioning state.
function provisionedTargets(): TargetsFile {
  return provisionedTargetsForContract(loadTargets());
}
describe('target-aware worker configuration (ticket #78)', () => {
  it('keeps wrangler.jsonc as a local base config without remote env shortcuts', () => {
    const config = loadWrangler();
    expect(config.env ?? {}).toEqual({});
    expect(config.vars?.ENVIRONMENT).toBe('local');
    expect(readFileSync('wrangler.jsonc', 'utf8')).not.toMatch(/staging/);
  });

  it('isolates mutable resources per target environment', () => {
    const config = loadWrangler();
    expect(config.d1_databases?.[0]?.database_name).toBe('user-service-local');
    const file = provisionedTargets();
    const sandbox = resolveTargetDeployment(file, {
      target: 'rch-rugbychampagne',
      environment: 'sandbox',
    });
    const production = resolveTargetDeployment(file, {
      target: 'rch-rugbychampagne',
      environment: 'production',
    });
    expect(sandbox.workerName).toBe('rch-rugbychampagne-user-service-sandbox');
    expect(production.workerName).toBe('rch-rugbychampagne-user-service-production');
    expect(sandbox.databaseName).toBe('rch-rugbychampagne-user-service-sandbox-db');
    expect(production.databaseName).toBe('rch-rugbychampagne-user-service-production-db');
    expect(sandbox.databaseId).not.toBe(production.databaseId);
  });

  it('keeps the stable DB binding on materialized target configs', () => {
    const file = provisionedTargets();
    for (const environment of ['sandbox', 'production'] as const) {
      const resolved = resolveTargetDeployment(file, {
        target: 'rch-rugbychampagne',
        environment,
      });
      const materialized = buildTargetWranglerConfig(resolved);
      expect(materialized.d1_databases).toHaveLength(1);
      expect(materialized.d1_databases[0].binding).toBe('DB');
      // Ticket #85: temp configs carry the absolute repository drizzle path
      // (Wrangler resolves relative entries from the temp config location).
      const migrationsDir = materialized.d1_databases[0].migrations_dir;
      expect(isAbsolute(migrationsDir)).toBe(true);
      expect(basename(migrationsDir)).toBe('drizzle');
      expect(isAbsolute(materialized.main)).toBe(true);
    }
  });

  it('points every environment at the same versioned migrations directory', () => {
    const config = loadWrangler();
    expect(config.d1_databases?.[0]?.migrations_dir).toBe('drizzle');
  });

  it('commits no secrets in worker or target configuration', () => {
    const config = loadWrangler();
    expect(config.vars ?? {}).not.toHaveProperty('RESEND_API_KEY');
    expect(config.vars ?? {}).not.toHaveProperty('BETTER_AUTH_SECRET');
    const raw = readFileSync('wrangler.jsonc', 'utf8');
    expect(raw).not.toMatch(/"RESEND_API_KEY"\s*:/);
    expect(raw).not.toMatch(/"BETTER_AUTH_SECRET"\s*:/);
    const targetsRaw = readFileSync('deploy/targets.json', 'utf8');
    for (const secret of [
      'BETTER_AUTH_SECRET',
      'RESEND_API_KEY',
      'SMTP_USER',
      'SMTP_PASSWORD',
      'CLOUDFLARE_API_TOKEN',
    ]) {
      expect(targetsRaw).not.toMatch(new RegExp(`"${secret}"\\s*:`));
    }
  });

  it('enforces the sandbox recipient allowlist in target configuration', () => {
    // Ticket #121: RCH sandbox mail no longer depends on ingalatech.com; the
    // allowlist holds the stable smoke recipient, the manual QA mailbox, and
    // the administrator QA mailbox. No domain/wildcard entries.
    const file = loadTargets();
    const sandbox = file.targets.find((entry) => entry.key === 'rch-rugbychampagne');
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_TRANSPORT).toBe('smtp');
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_ALLOWLIST).toBe(
      'jonatangarbuyo@gmail.com,cronistadev@gmail.com,ingaladev@gmail.com',
    );
    expect(sandbox?.environments.sandbox.vars.AUTH_MAIL_FROM).toBe(
      'User Service <jonatangarbuyo@gmail.com>',
    );
    expect(JSON.stringify(sandbox?.environments.sandbox.vars)).not.toContain('ingalatech.com');
    expect(sandbox?.environments.production.vars.AUTH_MAIL_ALLOWLIST ?? '').toBe('');
  });

  it('delivers sandbox verification and password-reset mail to all three allowlisted recipients (ticket #121)', async () => {
    // Public mailer seam: the versioned sandbox allowlist must let the
    // stable smoke recipient, the manual QA mailbox, and the administrator
    // QA mailbox through the existing SMTP guard for both auth intents,
    // while unrelated recipients stay skipped. The allowlist itself comes
    // from deploy/targets.json so this proves behaviour, not a repeated
    // literal.
    const file = loadTargets();
    const configured =
      file.targets.find((entry) => entry.key === 'rch-rugbychampagne')?.environments.sandbox.vars
        .AUTH_MAIL_ALLOWLIST ?? '';
    const allowlist = parseAllowlist(configured);
    expect(isAllowlisted('jonatangarbuyo@gmail.com', allowlist)).toBe(true);
    expect(isAllowlisted('cronistadev@gmail.com', allowlist)).toBe(true);
    expect(isAllowlisted('ingaladev@gmail.com', allowlist)).toBe(true);
    expect(isAllowlisted('mallory@evil.example', allowlist)).toBe(false);

    const config = resolveSmtpConfig({
      ENVIRONMENT: 'sandbox',
      SMTP_HOST: 'smtp.gmail.com',
      SMTP_PORT: '587',
      SMTP_SECURE: 'false',
      SMTP_USER: 'mailer@example.com',
      SMTP_PASSWORD: 's3cret-password-do-not-use',
      AUTH_MAIL_FROM: 'User Service <jonatangarbuyo@gmail.com>',
      AUTH_APP_NAME: 'User Service',
      AUTH_MAIL_ALLOWLIST: configured,
    });
    const records: SmtpMailLogRecord[] = [];
    const delivered: string[] = [];
    const mailer = new SmtpAuthMailer(
      config,
      (mail) => {
        delivered.push(mail.to);
        return Promise.resolve({ messageId: 'smtp-msg-1' });
      },
      (record) => {
        records.push(record);
      },
    );

    await mailer.sendVerificationEmail({
      to: 'cronistadev@gmail.com',
      url: 'https://example.com/verify?token=qa-token',
      token: 'qa-token',
    });
    await mailer.sendPasswordResetEmail({
      to: 'cronistadev@gmail.com',
      url: 'https://example.com/reset?token=qa-reset',
      token: 'qa-reset',
    });
    await mailer.sendVerificationEmail({
      to: 'jonatangarbuyo@gmail.com',
      url: 'https://example.com/verify?token=smoke-token',
      token: 'smoke-token',
    });
    await mailer.sendPasswordResetEmail({
      to: 'jonatangarbuyo@gmail.com',
      url: 'https://example.com/reset?token=smoke-reset',
      token: 'smoke-reset',
    });
    await mailer.sendVerificationEmail({
      to: 'ingaladev@gmail.com',
      url: 'https://example.com/verify?token=admin-token',
      token: 'admin-token',
    });
    await mailer.sendPasswordResetEmail({
      to: 'ingaladev@gmail.com',
      url: 'https://example.com/reset?token=admin-reset',
      token: 'admin-reset',
    });
    expect(delivered).toEqual([
      'cronistadev@gmail.com',
      'cronistadev@gmail.com',
      'jonatangarbuyo@gmail.com',
      'jonatangarbuyo@gmail.com',
      'ingaladev@gmail.com',
      'ingaladev@gmail.com',
    ]);
    expect(records.filter((record) => record.event === 'auth-mail.sent')).toHaveLength(6);

    await mailer.sendVerificationEmail({
      to: 'mallory@evil.example',
      url: 'https://example.com/verify?token=blocked',
      token: 'blocked',
    });
    await mailer.sendPasswordResetEmail({
      to: 'mallory@evil.example',
      url: 'https://example.com/reset?token=blocked-reset',
      token: 'blocked-reset',
    });
    expect(delivered).toHaveLength(6);
    expect(records.filter((record) => record.event === 'auth-mail.sandbox-skipped')).toHaveLength(
      2,
    );
    expect(records.at(-2)).toMatchObject({
      event: 'auth-mail.sandbox-skipped',
      purpose: 'email-verification',
      transport: 'smtp',
    });
    expect(records.at(-1)).toMatchObject({
      event: 'auth-mail.sandbox-skipped',
      purpose: 'password-reset',
      transport: 'smtp',
    });
  });

  it('enables the Cloudflare-native observability baseline', () => {
    const config = loadWrangler();
    expect(config.observability?.enabled).toBe(true);
  });

  it('fails closed without an explicit signing secret in sandbox', () => {
    expect(() => resolveAuthSecret({ ENVIRONMENT: 'sandbox' })).toThrow(/BETTER_AUTH_SECRET/);
    expect(
      resolveAuthSecret({ ENVIRONMENT: 'sandbox', BETTER_AUTH_SECRET: 'sandbox-secret' }),
    ).toBe('sandbox-secret');
  });
});

describe('sandbox runbook (ticket #14, #78)', () => {
  it('documents release, rollback, recovery, and promotion procedures', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    for (const heading of [
      'Worker code rollback',
      'Time Travel',
      'production promotion',
      'Secret rotation',
      'smoke test',
      'Logs, traces, and metrics',
    ]) {
      expect(runbook.toLowerCase()).toContain(heading.toLowerCase());
    }
  });

  it('documents the target-aware deploy boundary and first-target provisioning', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    expect(runbook).toMatch(/npm run deploy/);
    expect(runbook).toMatch(/rch-rugbychampagne-user-service-sandbox/);
    expect(runbook).toMatch(/deploy\/targets\.json/);
    expect(runbook).toMatch(/--write-config/);
    expect(runbook).toMatch(/secret put/);
  });
});

describe('sandbox smoke guards (ticket #14)', () => {
  it('builds unique sandbox recipients inside the allowlisted domain', () => {
    expect(buildSmokeEmail('ops.example.org', 'abc123')).toBe('smoke-abc123@ops.example.org');
  });

  it('refuses registration addresses outside the sandbox domain', () => {
    expect(() => {
      assertSandboxSmokeEmail('mallory@evil.com', 'ops.example.org');
    }).toThrow(/sandbox/i);
    expect(() => {
      assertSandboxSmokeEmail('smoke-x@ops.example.org', 'ops.example.org');
    }).not.toThrow();
  });

  it('prefers the exact allowlisted recipient without requiring an email domain', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: 'Smoke-Contact@ops.example.org',
      SMOKE_PASSWORD: 'operator-owned-stable-secret',
    });
    expect(config.recipient).toEqual({ kind: 'exact', email: 'smoke-contact@ops.example.org' });
    expect(config.password).toBe('operator-owned-stable-secret');
  });

  it('rejects a syntactically invalid exact recipient instead of falling back', () => {
    for (const bad of ['not-an-email', 'smoke@', '@ops.example.org', 'smoke@ops', '']) {
      expect(() => parseExactSmokeEmail(bad)).toThrow(/SMOKE_SANDBOX_EMAIL/);
    }
    for (const bad of ['not-an-email', 'smoke@', '@ops.example.org', 'smoke@ops']) {
      expect(() =>
        resolveSmokeConfig({
          SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
          SMOKE_SANDBOX_EMAIL: bad,
          SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
        }),
      ).toThrow(/SMOKE_SANDBOX_EMAIL/);
    }
  });

  it('treats an empty exact recipient as unset and keeps domain mode', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: '',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    expect(config.recipient).toEqual({ kind: 'domain', emailDomain: 'ops.example.org' });
  });

  it('normalizes a valid exact recipient without logging it', () => {
    expect(parseExactSmokeEmail('  Smoke-Contact@Ops.Example.Org  ')).toBe(
      'smoke-contact@ops.example.org',
    );
  });

  it('never generates or infers a recipient in exact mode', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: 'smoke-contact@ops.example.org',
      SMOKE_PASSWORD: 'operator-owned-stable-secret',
    });
    expect(resolveSmokeEmail(config, 'abc123')).toBe('smoke-contact@ops.example.org');
    expect(resolveSmokeEmail(config, 'zzz999')).toBe('smoke-contact@ops.example.org');
  });

  it('requires an explicit stable credential in exact mode and keeps random passwords for domain mode', () => {
    expect(() =>
      resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
        SMOKE_SANDBOX_EMAIL: 'smoke-contact@ops.example.org',
      }),
    ).toThrow(/SMOKE_PASSWORD/);
    const first = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    const second = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    expect(first.password.length).toBeGreaterThan(0);
    expect(second.password.length).toBeGreaterThan(0);
    expect(first.password).not.toBe(second.password);
    const stable = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL: 'smoke-contact@ops.example.org',
      SMOKE_PASSWORD: 'operator-owned-stable-secret',
    });
    expect(stable.password).toBe('operator-owned-stable-secret');
  });

  it('keeps domain-generated mode when no exact recipient is configured', () => {
    const config = resolveSmokeConfig({
      SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      SMOKE_SANDBOX_EMAIL_DOMAIN: 'ops.example.org',
    });
    expect(config.recipient).toEqual({ kind: 'domain', emailDomain: 'ops.example.org' });
    expect(resolveSmokeEmail(config, 'abc123')).toBe('smoke-abc123@ops.example.org');
  });

  it('still fails closed when neither recipient mode is configured', () => {
    expect(() =>
      resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
      }),
    ).toThrow(/SMOKE_SANDBOX_EMAIL/);
  });

  it('never logs the explicit recipient, password, or token', () => {
    const source = readFileSync('scripts/smoke-sandbox.ts', 'utf8');
    const logLines = source.split('\n').filter((line) => {
      const text = line.trim();
      if (text.startsWith('//')) {
        return false;
      }
      return text.includes('logStep(') || text.includes('console.log(') || text.includes('fail(');
    });
    expect(logLines.length).toBeGreaterThan(0);
    for (const line of logLines) {
      const code = line
        .replace(/'[^']*'/g, '')
        .replace(/"[^"]*"/g, '')
        .replace(/`[^`]*`/g, '');
      expect(code).not.toMatch(/\bemail\b/i);
      expect(code).not.toMatch(/\bpassword\b/i);
      expect(code).not.toMatch(/\btoken\b/i);
    }
  });

  it('documents exact-recipient sandbox acceptance in the runbook', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    expect(runbook).toMatch(/SANDBOX_SMOKE_EMAIL(?!_DOMAIN)/);
    expect(runbook).toMatch(/SMOKE_SANDBOX_EMAIL(?!_DOMAIN)/);
  });

  it('requires explicit smoke configuration and refuses localhost by default', () => {
    expect(() =>
      resolveSmokeConfig({ SMOKE_SANDBOX_BASE_URL: '', SMOKE_SANDBOX_EMAIL_DOMAIN: '' }),
    ).toThrow(/SMOKE_SANDBOX_BASE_URL/);
    expect(() =>
      resolveSmokeConfig({
        SMOKE_SANDBOX_BASE_URL: 'https://sandbox.example.workers.dev',
        SMOKE_SANDBOX_EMAIL_DOMAIN: '',
      }),
    ).toThrow(/SMOKE_SANDBOX_EMAIL_DOMAIN/);
    expect(() => assertSafeSmokeTarget('http://localhost:8787')).toThrow(/localhost/i);
    expect(() =>
      assertSafeSmokeTarget('http://localhost:8787', { allowLocalhost: true }),
    ).not.toThrow();
    expect(() => assertSafeSmokeTarget('https://sandbox.example.workers.dev')).not.toThrow();
  });

  it('models persisted exact-recipient login state without a false gate PASS (ticket #91)', () => {
    // Stable-credential unverified: the verification gate.
    expect(classifyExactSmokeLogin(403, 'email-verification-required')).toBe('unverified');
    // Stable-credential repeat after prior verification: session + resend
    // acceptance, never claimed as a fresh gate.
    expect(classifyExactSmokeLogin(200, '<missing-code>')).toBe('already-verified');
    // Credential mismatch: the configured stable credential does not own the
    // persisted identity and must fail closed, never pass.
    expect(classifyExactSmokeLogin(401, 'invalid-credentials')).toBe('unexpected');
  });

  it('fails closed on unexpected exact-recipient login states (ticket #91)', () => {
    for (const [status, code] of [
      [500, 'internal-error'],
      [403, 'invalid-credentials'],
      [401, 'email-verification-required'],
      [401, 'invalid-credentials'],
      [200, 'email-verification-required'],
      [404, '<missing-code>'],
    ] as const) {
      expect(classifyExactSmokeLogin(status, code)).toBe('unexpected');
    }
  });

  it('documents fresh versus repeatable exact-recipient semantics in the runbook (ticket #91)', () => {
    const runbook = readFileSync('docs/operations/sandbox-release-runbook.md', 'utf8');
    expect(runbook).toMatch(/already-verified/i);
    expect(runbook).toMatch(/SANDBOX_SMOKE_PASSWORD/);
    expect(runbook).toMatch(/same.*SMOKE_PASSWORD.*SMOKE_VERIFICATION_TOKEN/s);
    expect(runbook).toMatch(/401 invalid-credentials/i);
    expect(runbook).toMatch(/fails closed/i);
    expect(runbook).toMatch(/without a fresh database/i);
    expect(runbook).toMatch(/without a new recipient/i);
    expect(runbook).toMatch(/Never broaden/);
  });
});
