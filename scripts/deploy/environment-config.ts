import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  databaseName,
  parseDeployEnvironment,
  workerName,
  type DeployableEnvironment,
} from './naming.js';
import { resolveEffectiveConfig } from '../../src/config/config.js';
import { resolveConsumerTokenConfig } from '../../src/features/identity/consumer-tokens.js';
import { resolveGatewayOrigins } from '../../src/features/identity/origin-guard.js';
import { validateSmtpSettings } from '../../src/features/identity/smtp-transport.js';
import type { NonSecretProfile } from '../../src/config/index.js';

const DATABASE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isProvisionedDatabaseId(databaseId: string): boolean {
  if (!DATABASE_ID_PATTERN.test(databaseId)) return false;
  const hex = databaseId.replace(/-/g, '').toLowerCase();
  return !hex.split('').every((char) => char === hex[0]);
}

export const ENVIRONMENT_VAR_NAMES = [
  'ENVIRONMENT',
  'CLOUDFLARE_ACCOUNT_ID',
  'WORKER_NAME',
  'WORKER_URL',
  'D1_NAME',
  'D1_ID',
  'AUTH_REGISTRATION_ENABLED',
  'AUTH_EMAIL_PASSWORD_ENABLED',
  'AUTH_REQUIRE_EMAIL_VERIFICATION',
  'AUTH_MAIL_TRANSPORT',
  'AUTH_MAIL_FROM',
  'AUTH_APP_NAME',
  'AUTH_MAIL_ALLOWLIST',
  'AUTH_VERIFY_EMAIL_ACTION_URL',
  'AUTH_RESET_PASSWORD_ACTION_URL',
  'AUTH_JWT_ISSUER',
  'AUTH_JWT_AUDIENCE',
  'AUTH_JWT_TTL_SECONDS',
  'AUTH_GATEWAY_ORIGINS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
] as const;

const SECRET_NAMES = new Set([
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASSWORD',
  'CLOUDFLARE_API_TOKEN',
]);
const KNOWN_NAMES = new Set<string>(ENVIRONMENT_VAR_NAMES);

export type EnvironmentVarName = (typeof ENVIRONMENT_VAR_NAMES)[number];
export type EnvironmentFile = Readonly<Record<EnvironmentVarName, string>>;

export interface EnvironmentDeployment {
  readonly targetKey: string;
  readonly company: string;
  readonly site: string;
  readonly service: 'user-service';
  readonly environment: DeployableEnvironment;
  readonly workerName: string;
  readonly workerUrl: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly accountId?: string;
  readonly applicationConfig: NonSecretProfile;
}

export type ResolvedDeployment = EnvironmentDeployment;

function parseLines(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match === null)
      throw new Error(`Invalid environment configuration line ${String(index + 1)}.`);
    const name = match[1];
    const value = match[2];
    if (name === undefined || value === undefined)
      throw new Error('Invalid environment configuration.');
    if (values.has(name)) throw new Error(`Duplicate environment configuration key "${name}".`);
    if (SECRET_NAMES.has(name))
      throw new Error(`Secret key "${name}" is not allowed in an environment file.`);
    if (!KNOWN_NAMES.has(name)) throw new Error(`Unknown environment configuration key "${name}".`);
    values.set(name, value.trim().replace(/^(['"])(.*)\1$/, '$2'));
  }
  for (const name of ENVIRONMENT_VAR_NAMES) {
    if (!values.has(name)) throw new Error(`Missing environment configuration key "${name}".`);
  }
  return values;
}

export function parseEnvironmentFile(text: string): EnvironmentFile {
  return Object.fromEntries(parseLines(text)) as EnvironmentFile;
}

export function loadEnvironmentFile(path: string): EnvironmentFile {
  return parseEnvironmentFile(readFileSync(path, 'utf8'));
}

export function environmentFilePath(repoRoot: string, environment: unknown): string {
  const selected = parseDeployEnvironment(environment);
  return join(repoRoot, 'config', 'environments', `.env.${selected}`);
}

function assertEnvironmentValue(
  file: EnvironmentFile,
  name: EnvironmentVarName,
  pattern?: RegExp,
): void {
  if (file[name].length === 0 || (pattern !== undefined && !pattern.test(file[name]))) {
    throw new Error(`Invalid environment configuration value for "${name}".`);
  }
}

export function resolveEnvironmentDeployment(
  file: EnvironmentFile,
  options: { readonly requireRemoteReady?: boolean } = {},
): EnvironmentDeployment {
  const environment = parseDeployEnvironment(file.ENVIRONMENT);
  assertEnvironmentValue(file, 'WORKER_NAME', /^[a-z0-9-]+$/);
  assertEnvironmentValue(file, 'WORKER_URL', /^https:\/\//);
  assertEnvironmentValue(file, 'D1_NAME', /^[a-z0-9-]+$/);
  assertEnvironmentValue(file, 'AUTH_MAIL_TRANSPORT');
  assertEnvironmentValue(file, 'AUTH_MAIL_FROM');
  if (file.CLOUDFLARE_ACCOUNT_ID !== '' && !/^[0-9a-f]{32}$/i.test(file.CLOUDFLARE_ACCOUNT_ID)) {
    throw new Error('Invalid environment configuration value for "CLOUDFLARE_ACCOUNT_ID".');
  }
  if (file.D1_ID !== '' && !isProvisionedDatabaseId(file.D1_ID)) {
    throw new Error('Invalid environment configuration value for "D1_ID".');
  }
  if (options.requireRemoteReady === true) {
    if (file.CLOUDFLARE_ACCOUNT_ID === '') {
      throw new Error(
        'Environment configuration is not deployable: "CLOUDFLARE_ACCOUNT_ID" is empty.',
      );
    }
    if (!isProvisionedDatabaseId(file.D1_ID)) {
      throw new Error('Environment configuration is not deployable: "D1_ID" is not provisioned.');
    }
  }
  const expectedWorker = workerName({
    company: 'rch',
    site: 'rugbychampagne',
    service: 'user-service',
    environment,
  });
  const expectedDatabase = databaseName({
    company: 'rch',
    site: 'rugbychampagne',
    service: 'user-service',
    environment,
  });
  if (file.WORKER_NAME !== expectedWorker || file.D1_NAME !== expectedDatabase) {
    throw new Error('Environment configuration names do not match the selected environment.');
  }
  const vars = Object.fromEntries(
    ENVIRONMENT_VAR_NAMES.filter(
      (name) =>
        ![
          'ENVIRONMENT',
          'CLOUDFLARE_ACCOUNT_ID',
          'WORKER_NAME',
          'WORKER_URL',
          'D1_NAME',
          'D1_ID',
        ].includes(name),
    ).map((name) => [name, file[name]]),
  );
  const applicationConfig = resolveEffectiveConfig({ environment, runtime: vars }).config;
  resolveConsumerTokenConfig({
    environment: 'local',
    issuer: file.AUTH_JWT_ISSUER,
    audience: file.AUTH_JWT_AUDIENCE,
    ttlSeconds: file.AUTH_JWT_TTL_SECONDS,
  });
  resolveGatewayOrigins(file.AUTH_GATEWAY_ORIGINS);
  if (file.AUTH_MAIL_TRANSPORT.trim().toLowerCase() === 'smtp') {
    validateSmtpSettings({ SMTP_PORT: file.SMTP_PORT, SMTP_SECURE: file.SMTP_SECURE });
  }
  return {
    targetKey: 'rch-rugbychampagne',
    company: 'rch',
    site: 'rugbychampagne',
    service: 'user-service',
    environment,
    workerName: file.WORKER_NAME,
    workerUrl: file.WORKER_URL,
    databaseName: file.D1_NAME,
    databaseId: file.D1_ID,
    accountId: file.CLOUDFLARE_ACCOUNT_ID,
    applicationConfig,
  };
}

export function stageDatabaseId(path: string, databaseId: string): void {
  if (!isProvisionedDatabaseId(databaseId))
    throw new Error('Refusing to stage an invalid D1 database id.');
  const file = loadEnvironmentFile(path);
  const lines = readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((line) => (line.startsWith('D1_ID=') ? `D1_ID=${databaseId}` : line));
  if (file.D1_ID === databaseId) return;
  writeFileSync(path, lines.join('\n'), 'utf8');
}
