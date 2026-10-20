import {
  assertWorkerName,
  databaseName,
  parseDeployEnvironment,
  workerName,
  type DeployableEnvironment,
} from './naming.js';

// Versioned secret-free deployment targets (ticket #78, ADR-0008).
//
// `deploy/targets.json` owns every company/site target so application code
// never hard-codes client-specific behavior. The file carries only non-secret
// deployment values: Worker/D1 naming derives from the company/site/service
// slugs, and per-environment `vars` admit only known non-secret configuration
// names. Runtime secrets (`BETTER_AUTH_SECRET`, mail-provider credentials,
// Cloudflare credentials) are configured directly in Cloudflare for the
// selected target Worker and must never appear here.

export interface TargetEnvironmentConfig {
  readonly databaseId: string;
  readonly accountId?: string;
  readonly vars: Record<string, string>;
}

export interface DeploymentTargetConfig {
  readonly key: string;
  readonly company: string;
  readonly site: string;
  readonly service: string;
  readonly displayName: string;
  readonly environments: Record<DeployableEnvironment, TargetEnvironmentConfig>;
}

export interface TargetsFile {
  readonly version: 1;
  readonly service: string;
  readonly targets: DeploymentTargetConfig[];
}

export interface ResolvedDeployment {
  readonly targetKey: string;
  readonly company: string;
  readonly site: string;
  readonly service: string;
  readonly environment: DeployableEnvironment;
  readonly workerName: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly accountId?: string;
  readonly vars: Record<string, string>;
}

export interface ResolveTargetSelection {
  readonly target: unknown;
  readonly environment: unknown;
}

// Non-secret deployment vars a target may override. `ENVIRONMENT` is derived
// from the selected environment by the deployer and is never read from the
// file, so per-target drift cannot desynchronize the deployment key.
const DEPLOYABLE_VAR_NAMES: ReadonlySet<string> = new Set([
  'AUTH_REGISTRATION_ENABLED',
  'AUTH_EMAIL_PASSWORD_ENABLED',
  'AUTH_REQUIRE_EMAIL_VERIFICATION',
  'AUTH_MAIL_TRANSPORT',
  'AUTH_MAIL_FROM',
  'AUTH_APP_NAME',
  'AUTH_MAIL_ALLOWLIST',
  'AUTH_VERIFY_EMAIL_ACTION_URL',
  'AUTH_RESET_PASSWORD_ACTION_URL',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
]);

const SECRET_VAR_NAMES: ReadonlySet<string> = new Set([
  'BETTER_AUTH_SECRET',
  'RESEND_API_KEY',
  'SMTP_USER',
  'SMTP_PASSWORD',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, field: string, what: string): string {
  const value: unknown = record[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Invalid deployment targets: ${what} requires a non-empty "${field}".`);
  }
  return value;
}

// Error messages name offending keys but never echo configured values:
// values stay out of logs even though target vars are non-secret by
// construction, so a future misconfiguration cannot leak through diagnostics.
function assertSecretFreeVars(
  targetKey: string,
  environment: string,
  vars: unknown,
): Record<string, string> {
  if (!isRecord(vars)) {
    throw new Error(
      `Invalid deployment target "${targetKey}" environment "${environment}": "vars" must be an object.`,
    );
  }
  const clean: Record<string, string> = {};
  for (const [name, value] of Object.entries(vars)) {
    if (SECRET_VAR_NAMES.has(name) || name.startsWith('CLOUDFLARE_')) {
      throw new Error(
        `Refusing deployment target "${targetKey}" environment "${environment}": "${name}" is a runtime secret and must be configured directly in Cloudflare, never in versioned target configuration.`,
      );
    }
    if (name === 'ENVIRONMENT') {
      throw new Error(
        `Invalid deployment target "${targetKey}" environment "${environment}": "ENVIRONMENT" is derived from the selected environment, not target configuration.`,
      );
    }
    if (!DEPLOYABLE_VAR_NAMES.has(name)) {
      throw new Error(
        `Invalid deployment target "${targetKey}" environment "${environment}": unknown var "${name}".`,
      );
    }
    if (typeof value !== 'string') {
      throw new Error(
        `Invalid deployment target "${targetKey}" environment "${environment}": var "${name}" must be a string.`,
      );
    }
    clean[name] = value;
  }
  return clean;
}

function loadEnvironmentConfig(
  targetKey: string,
  environment: string,
  value: unknown,
): TargetEnvironmentConfig {
  if (!isRecord(value)) {
    throw new Error(
      `Invalid deployment target "${targetKey}": environment "${environment}" must be an object.`,
    );
  }
  const databaseId: unknown = value.databaseId;
  const accountId: unknown = value.accountId ?? '';
  if (typeof databaseId !== 'string') {
    throw new Error(
      `Invalid deployment target "${targetKey}" environment "${environment}": "databaseId" must be a string (empty until provisioned).`,
    );
  }
  if (typeof accountId !== 'string' || (accountId !== '' && !/^[0-9a-f]{32}$/i.test(accountId))) {
    throw new Error(
      `Invalid deployment target "${targetKey}" environment "${environment}": "accountId" must be empty or a 32-character hexadecimal Cloudflare account ID.`,
    );
  }
  return { databaseId, accountId, vars: assertSecretFreeVars(targetKey, environment, value.vars) };
}

function loadTarget(value: unknown, service: string): DeploymentTargetConfig {
  if (!isRecord(value)) {
    throw new Error('Invalid deployment targets: each target must be an object.');
  }
  const company = requiredString(value, 'company', 'target');
  const site = requiredString(value, 'site', `target "${company}"`);
  const key = requiredString(value, 'key', `target "${company}/${site}"`);
  if (key !== `${company}-${site}`) {
    throw new Error(`Invalid deployment target "${key}": key must be "<company>-<site>".`);
  }
  const targetService = requiredString(value, 'service', `target "${key}"`);
  if (targetService !== service) {
    throw new Error(
      `Invalid deployment target "${key}": service must match the file service "${service}".`,
    );
  }
  const displayName = requiredString(value, 'displayName', `target "${key}"`);
  const environments: unknown = value.environments;
  if (!isRecord(environments)) {
    throw new Error(`Invalid deployment target "${key}": "environments" must be an object.`);
  }
  for (const name of Object.keys(environments)) {
    if (name !== 'sandbox' && name !== 'production') {
      throw new Error(
        `Invalid deployment target "${key}": unknown environment "${name}" (canonical environments are "sandbox" and "production" only).`,
      );
    }
  }
  const sandbox: unknown = environments.sandbox;
  const production: unknown = environments.production;
  if (sandbox === undefined || production === undefined) {
    throw new Error(
      `Invalid deployment target "${key}": both "sandbox" and "production" environments are required.`,
    );
  }
  return {
    key,
    company,
    site,
    service: targetService,
    displayName,
    environments: {
      sandbox: loadEnvironmentConfig(key, 'sandbox', sandbox),
      production: loadEnvironmentConfig(key, 'production', production),
    },
  };
}

export function loadTargetsFile(data: unknown): TargetsFile {
  if (!isRecord(data)) {
    throw new Error('Invalid deployment targets: expected an object.');
  }
  if (data.version !== 1) {
    throw new Error('Invalid deployment targets: expected "version" 1.');
  }
  const service = requiredString(data, 'service', 'targets file');
  const rawTargets: unknown = data.targets;
  if (!Array.isArray(rawTargets) || rawTargets.length === 0) {
    throw new Error('Invalid deployment targets: "targets" must be a non-empty array.');
  }
  const targets = rawTargets.map((entry) => loadTarget(entry, service));
  const keys = targets.map((target) => target.key);
  if (new Set(keys).size !== keys.length) {
    throw new Error('Invalid deployment targets: target keys must be unique.');
  }
  return { version: 1, service, targets };
}

const DATABASE_ID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// Provisioned database ids are canonical Cloudflare D1 identifiers in UUID
// form (`xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`) as emitted by Wrangler.
// Uniform ids (`aaaa…`, `bbbb…`, nil UUID, …) match the repository
// placeholder convention and are never real Cloudflare-issued identifiers,
// so they fail closed like an empty slot. Unhyphenated 32-hex strings are
// synthetic test fixtures, not Wrangler-issued ids, and are rejected.
export function isProvisionedDatabaseId(databaseId: string): boolean {
  if (!DATABASE_ID_PATTERN.test(databaseId)) {
    return false;
  }
  const hex = databaseId.replace(/-/g, '').toLowerCase();
  return !hex.split('').every((char) => char === hex[0]);
}

// Provisioning gate: an empty, malformed or placeholder database id means the
// target's D1 has not been provisioned/recorded yet. The deployer fails closed
// here — before preflight remote checks — rather than deploying against the
// wrong database.
function assertProvisionedDatabaseId(
  targetKey: string,
  environment: DeployableEnvironment,
  databaseId: string,
): void {
  if (!isProvisionedDatabaseId(databaseId)) {
    throw new Error(
      `Unprovisioned D1 database for target "${targetKey}" environment "${environment}": create the client-scoped database and record its database_id in deploy/targets.json (see docs/operations/sandbox-release-runbook.md).`,
    );
  }
}

export function resolveTargetDeployment(
  file: TargetsFile,
  selection: ResolveTargetSelection,
): ResolvedDeployment {
  return resolveDeployment(file, selection, { requireProvisionedDatabase: true });
}

// Provisioning target resolution (ticket #80): first-time provisioning must
// accept an empty database id so the exact-name remote resource can be
// discovered or created and then staged. The deployment boundary above keeps
// refusing unprovisioned ids; this entry point never weakens that gate.
export function resolveProvisioningTarget(
  file: TargetsFile,
  selection: ResolveTargetSelection,
): ResolvedDeployment {
  return resolveDeployment(file, selection, { requireProvisionedDatabase: false });
}

function resolveDeployment(
  file: TargetsFile,
  selection: ResolveTargetSelection,
  options: { readonly requireProvisionedDatabase: boolean },
): ResolvedDeployment {
  const environment = parseDeployEnvironment(selection.environment);
  const targetKey = typeof selection.target === 'string' ? selection.target.trim() : '';
  const target = file.targets.find((entry) => entry.key === targetKey);
  if (target === undefined) {
    const available = file.targets.map((entry) => entry.key).join(', ');
    throw new Error(`Unknown deployment target "${targetKey}": available targets: ${available}.`);
  }
  const config = target.environments[environment];
  if (options.requireProvisionedDatabase) {
    assertProvisionedDatabaseId(target.key, environment, config.databaseId);
  }
  const identity = {
    company: target.company,
    site: target.site,
    service: target.service,
    environment,
  };
  const name = workerName(identity);
  assertWorkerName(name);
  return {
    targetKey: target.key,
    company: target.company,
    site: target.site,
    service: target.service,
    environment,
    workerName: name,
    databaseName: databaseName(identity),
    databaseId: config.databaseId,
    accountId: config.accountId,
    vars: { ...config.vars },
  };
}

export function listTargetKeys(file: TargetsFile): string[] {
  return file.targets.map((target) => target.key);
}
