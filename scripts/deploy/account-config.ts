import type { DeployableEnvironment } from './naming.js';
import type { TargetsFile } from './targets.js';

export interface AccountOverrides {
  readonly version: 1;
  readonly targets: Readonly<Record<string, Partial<Record<DeployableEnvironment, string>>>>;
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/i;

function validatedAccountId(value: unknown, source: string, allowEmpty = false): string {
  if (allowEmpty && value === '') return '';
  if (typeof value !== 'string' || !ACCOUNT_ID.test(value)) {
    throw new Error(
      `Invalid Cloudflare account ID in ${source}; expected 32 hexadecimal characters.`,
    );
  }
  return value.toLowerCase();
}

export function loadAccountOverrides(value: unknown): AccountOverrides {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Invalid local account overrides: expected an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.targets !== 'object' ||
    record.targets === null ||
    Array.isArray(record.targets)
  ) {
    throw new Error('Invalid local account overrides: expected version 1 and a targets object.');
  }
  const targets: Record<string, Partial<Record<DeployableEnvironment, string>>> = {};
  for (const [targetKey, rawEnvironments] of Object.entries(
    record.targets as Record<string, unknown>,
  )) {
    if (
      typeof rawEnvironments !== 'object' ||
      rawEnvironments === null ||
      Array.isArray(rawEnvironments)
    ) {
      throw new Error(
        'Invalid local account overrides: each target must map environments to account IDs.',
      );
    }
    const environments: Partial<Record<DeployableEnvironment, string>> = {};
    for (const [environment, accountId] of Object.entries(rawEnvironments)) {
      if (environment !== 'sandbox' && environment !== 'production') {
        throw new Error(
          'Invalid local account overrides: only sandbox and production are supported.',
        );
      }
      environments[environment] = validatedAccountId(accountId, 'local overrides');
    }
    targets[targetKey] = environments;
  }
  return { version: 1, targets };
}

export function resolveCloudflareAccountId(
  versioned: string,
  localOverride?: string,
  processOverride?: string,
): string {
  const configured = validatedAccountId(versioned, 'deploy/targets.json', true);
  const local =
    localOverride === undefined ? undefined : validatedAccountId(localOverride, 'local overrides');
  const process =
    processOverride === undefined || processOverride.trim() === ''
      ? undefined
      : validatedAccountId(processOverride.trim(), 'CLOUDFLARE_ACCOUNT_ID');
  const selected = process ?? local ?? (configured || undefined);
  if (selected === undefined) {
    throw new Error('No Cloudflare account ID configured for the selected target and environment.');
  }
  return selected;
}

export function applyAccountOverrides(
  file: TargetsFile,
  overrides: AccountOverrides,
  processOverride?: string,
): TargetsFile {
  const targetKeys = new Set(file.targets.map((target) => target.key));
  for (const key of Object.keys(overrides.targets)) {
    if (!targetKeys.has(key)) {
      throw new Error(`Invalid local account overrides: unknown deployment target "${key}".`);
    }
  }
  const processAccountId =
    processOverride === undefined || processOverride.trim() === ''
      ? undefined
      : validatedAccountId(processOverride.trim(), 'CLOUDFLARE_ACCOUNT_ID');
  const effective = (versioned: string, local?: string): string => {
    const localAccountId =
      local === undefined ? undefined : validatedAccountId(local, 'local overrides');
    const configured = validatedAccountId(versioned, 'deploy/targets.json', true);
    return processAccountId ?? localAccountId ?? configured;
  };
  return {
    ...file,
    targets: file.targets.map((target) => ({
      ...target,
      environments: {
        sandbox: {
          ...target.environments.sandbox,
          accountId: effective(
            target.environments.sandbox.accountId ?? '',
            overrides.targets[target.key]?.sandbox,
          ),
        },
        production: {
          ...target.environments.production,
          accountId: effective(
            target.environments.production.accountId ?? '',
            overrides.targets[target.key]?.production,
          ),
        },
      },
    })),
  };
}
