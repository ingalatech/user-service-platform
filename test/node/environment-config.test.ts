import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  environmentFilePath,
  loadEnvironmentFile,
  parseEnvironmentFile,
  resolveEnvironmentTarget,
  resolveEnvironmentDeployment,
  stageDatabaseId,
} from '../../scripts/deploy/environment-config.js';

describe('release environment files', () => {
  it('loads complete independent sandbox and production files', () => {
    const sandbox = resolveEnvironmentDeployment(
      loadEnvironmentFile(environmentFilePath('.', 'sandbox')),
    );
    const production = resolveEnvironmentDeployment(
      loadEnvironmentFile(environmentFilePath('.', 'production')),
    );
    expect(sandbox.workerName).toContain('-sandbox');
    expect(production.workerName).toContain('-production');
    expect(sandbox.applicationConfig.SMTP_HOST).toBe('smtp.gmail.com');
    expect(production.applicationConfig.SMTP_HOST).toBe('smtp.gmail.com');
    expect(sandbox.applicationConfig.AUTH_MAIL_ALLOWLIST).toBe(
      'jonatangarbuyo@gmail.com,cronistadev@gmail.com',
    );
    expect(sandbox.applicationConfig.AUTH_RESET_PASSWORD_ACTION_URL).toBe(
      'https://rch-rugbychampagneweb-sandbox.rch-evolucion.workers.dev/usuario/restablecer',
    );
    expect(production.applicationConfig.AUTH_RESET_PASSWORD_ACTION_URL).toBe(
      'https://www.rugbychampagneweb.com/usuario/restablecer',
    );
    expect(sandbox.applicationConfig.AUTH_VERIFY_EMAIL_ACTION_URL).toBe(
      'https://rch-rugbychampagneweb-sandbox.rch-evolucion.workers.dev/usuario/verificar',
    );
    expect(production.applicationConfig.AUTH_VERIFY_EMAIL_ACTION_URL).toBe(
      'https://www.rugbychampagneweb.com/usuario/verificar',
    );
  });

  it('documents the local Astro auth actions without credentials', () => {
    const example = readFileSync('.env.example', 'utf8');
    expect(example).toContain(
      'AUTH_VERIFY_EMAIL_ACTION_URL=http://localhost:4321/usuario/verificar',
    );
    expect(example).toContain(
      'AUTH_RESET_PASSWORD_ACTION_URL=http://localhost:4321/usuario/restablecer',
    );
  });

  it('resolves promotion identity without re-validating current application configuration', () => {
    const file = loadEnvironmentFile(environmentFilePath('.', 'sandbox'));
    const target = resolveEnvironmentTarget({
      ...file,
      AUTH_MAIL_TRANSPORT: 'changed-after-upload',
      AUTH_MAIL_FROM: '',
    });

    expect(target.workerName).toContain('-sandbox');
    expect(target.environment).toBe('sandbox');
    expect(() =>
      resolveEnvironmentDeployment({
        ...file,
        AUTH_MAIL_TRANSPORT: 'changed-after-upload',
        AUTH_MAIL_FROM: '',
      }),
    ).toThrow();
  });

  it.each([
    ['duplicate', 'ENVIRONMENT=sandbox\nENVIRONMENT=sandbox'],
    ['unknown', 'NOT_ALLOWED=value'],
    ['secret', 'SMTP_PASSWORD=value'],
    ['missing', ''],
  ])('rejects %s entries without echoing values', (_kind, text) => {
    expect(() => parseEnvironmentFile(text)).toThrow();
    try {
      parseEnvironmentFile(`${text}\nSMTP_PASSWORD=do-not-echo`);
    } catch (error) {
      expect(String(error)).not.toContain('do-not-echo');
    }
  });

  it('stages only the D1 id in the selected environment file', () => {
    const path = environmentFilePath('.', 'sandbox');
    const original = readFileSync(path, 'utf8');
    try {
      stageDatabaseId(path, 'a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b');
      expect(readFileSync(path, 'utf8')).toContain('D1_ID=a1b2c3d4-e5f6-4789-a3b5-c6d7e8f90a1b');
    } finally {
      writeFileSync(path, original, 'utf8');
    }
  });
});
