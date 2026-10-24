import { applyD1Migrations, env } from 'cloudflare:test';
import type { D1Migration } from 'cloudflare:test';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import {
  LOCAL_PROFILE,
  resolveEffectiveConfig,
  type NonSecretProfile,
} from '../../config/index.js';
import type { Env } from '../../env.js';
import { DevelopmentAuthMailer, InMemoryAuthMailer, resolveAuthMailer } from './mailer.js';
import { resolveAuthPolicy } from './policy.js';

// Seam under test (ticket #57, PR #61 review): the public HTTP boundary plus
// the Identity policy/mailer resolution that must consume one effective
// application configuration (selected versioned non-secret profile +
// same-name runtime overrides). Secrets/bindings continue directly from
// runtime and never enter the versioned/effective non-secret config.
const workerEnv = env;
const testMigrations = env.TEST_MIGRATIONS as D1Migration[];

const mailer = new InMemoryAuthMailer();
const app = createApp({ authMailer: mailer });

function minimalEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: workerEnv.DB,
    ENVIRONMENT: 'test',
    ...overrides,
  };
}

async function postRegister(body: unknown, overrides: Partial<Env> = {}): Promise<Response> {
  return app.request(
    '/v1/auth/register',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
    minimalEnv(overrides),
  );
}

async function waitForVerificationMessage(): Promise<void> {
  for (let attempt = 0; attempt < 20 && mailer.sent.length === 0; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(mailer.sent.length).toBeGreaterThan(0);
}

beforeAll(async () => {
  await applyD1Migrations(workerEnv.DB, testMigrations);
});

beforeEach(async () => {
  const db = workerEnv.DB;
  await db.batch([
    db.prepare('DELETE FROM "session"'),
    db.prepare('DELETE FROM "account"'),
    db.prepare('DELETE FROM "verification"'),
    db.prepare('DELETE FROM "email_verification_token"'),
    db.prepare('DELETE FROM "user"'),
  ]);
  mailer.clear();
});

describe('effective configuration as Identity source of truth', () => {
  it('drives registration policy from the versioned profile without redundant runtime keys', async () => {
    const effective = resolveEffectiveConfig({
      environment: 'test',
      runtime: { ENVIRONMENT: 'test' },
    });
    expect(effective.config.AUTH_REGISTRATION_ENABLED).toBe(
      LOCAL_PROFILE.AUTH_REGISTRATION_ENABLED,
    );
    expect(resolveAuthPolicy(effective.config).registrationEnabled).toBe(true);

    const res = await postRegister({
      name: 'Profile Probe',
      email: 'profile-probe@example.com',
      password: 'Correct-horse-41',
    });

    expect(res.status).toBe(201);
    await waitForVerificationMessage();
    expect(mailer.sent).toHaveLength(1);
  });

  it('lets a same-name runtime override win over the versioned profile', async () => {
    const effective = resolveEffectiveConfig({
      environment: 'test',
      runtime: { ENVIRONMENT: 'test', AUTH_REGISTRATION_ENABLED: 'false' },
    });
    expect(effective.config.AUTH_REGISTRATION_ENABLED).toBe('false');
    expect(resolveAuthPolicy(effective.config).registrationEnabled).toBe(false);

    const res = await postRegister(
      {
        name: 'Override Probe',
        email: 'override-probe@example.com',
        password: 'Correct-horse-41',
      },
      { AUTH_REGISTRATION_ENABLED: 'false' },
    );

    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; status: number };
    expect(body.code).toBe('registration-disabled');
    expect(body.status).toBe(403);
    expect(mailer.sent).toHaveLength(0);
  });

  it('selects the mail transport from the versioned profile without a redundant runtime key', () => {
    const localEffective = resolveEffectiveConfig({ environment: 'local', runtime: {} });
    expect(localEffective.config.AUTH_MAIL_TRANSPORT).toBe(LOCAL_PROFILE.AUTH_MAIL_TRANSPORT);
    expect(resolveAuthMailer({ ...localEffective.config })).toBeInstanceOf(DevelopmentAuthMailer);

    const sandboxEffective = resolveEffectiveConfig({ environment: 'sandbox', runtime: {} });
    expect(sandboxEffective.config.AUTH_MAIL_TRANSPORT).toBe('');
    expect(() => resolveAuthMailer({ ...sandboxEffective.config })).toThrow(/RESEND_API_KEY/);

    const overridden = resolveEffectiveConfig({
      environment: 'sandbox',
      runtime: { AUTH_MAIL_TRANSPORT: 'inmemory' },
    });
    expect(overridden.config.AUTH_MAIL_TRANSPORT).toBe('inmemory');
    expect(resolveAuthMailer({ ...overridden.config })).toBeInstanceOf(InMemoryAuthMailer);
  });

  it('never merges secrets into the effective non-secret configuration', () => {
    const effective = resolveEffectiveConfig({
      environment: 'local',
      runtime: {
        BETTER_AUTH_SECRET: 'super-secret-value',
        RESEND_API_KEY: 're_secret_value',
        SMTP_USER: 'mailer@example.com',
        SMTP_PASSWORD: 'smtp_secret_value',
        AUTH_APP_NAME: 'Local Suite',
      },
    });
    const config = effective.config as NonSecretProfile & Record<string, unknown>;
    expect(config).not.toHaveProperty('BETTER_AUTH_SECRET');
    expect(config).not.toHaveProperty('RESEND_API_KEY');
    expect(config).not.toHaveProperty('SMTP_USER');
    expect(config).not.toHaveProperty('SMTP_PASSWORD');
    expect(JSON.stringify(effective.config)).not.toContain('super-secret-value');
    expect(JSON.stringify(effective.config)).not.toContain('re_secret_value');
    expect(JSON.stringify(effective.config)).not.toContain('smtp_secret_value');
  });
});
