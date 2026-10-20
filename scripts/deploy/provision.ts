import {
  d1CreateArgs,
  d1ListArgs,
  isAcceptedRemoteDatabaseId,
  matchExactDatabase,
  parseD1ListOutput,
} from './provision-d1.js';
import { parseWorkerDeploymentsOutput, workerDeploymentsListArgs } from './provision-worker.js';
import {
  isProvisionedDatabaseId,
  resolveProvisioningTarget,
  type ResolvedDeployment,
  type TargetsFile,
} from './targets.js';
import type { DeployableEnvironment } from './naming.js';

// Target provisioning orchestration (ticket #80, parent spec #8).
//
// One entry point provisions or verifies the declarative target dependencies
// needed by the service, keeping dependency provisioning separate from
// application deployment:
//
// - D1 is the only dependent resource provisioned today. Discovery lists
//   remote databases through Wrangler JSON output and matches the exact
//   canonical database name: zero matches plans (or creates on apply, then
//   rediscovers the created id with a second `d1 list --json`), one match
//   adopts/verifies its id, duplicate matches fail closed, and a configured
//   id that disagrees with the remote exact-name resource fails closed.
//   Creation uses the supported `wrangler d1 create <name>
//   --update-config=false` invocation; its opaque text output is never
//   parsed, logged or staged.
// - The Worker is discovered read-only. An absent Worker is not an error:
//   the first normal `npm run deploy` creates/publishes it. Provisioning
//   never publishes application code and never creates a placeholder Worker.
// - Required secrets are reported by names/types only. Provisioning never
//   reads, writes, copies or prints secret values and never accepts secret
//   values as CLI flags.
// - On apply, only the selected environment's non-secret database id is
//   staged in `deploy/targets.json`. The change is left as a reviewable
//   worktree diff: provisioning never commits or pushes.
//
// Closed resource-kind model: D1 is the only provisioned kind today. Future
// declared dependencies (KV/session, R2/files) join this model only when the
// service actually declares them; undeclared resources are never created.
//
// Secret boundary: logs and errors carry canonical resource names, required
// secret names and statuses only — never secret values, provider output,
// remote plaintext vars or credentials.

export const PROVISION_RESOURCE_KINDS = ['d1'] as const;

export type ProvisionResourceKind = (typeof PROVISION_RESOURCE_KINDS)[number];

export type ProvisionMode = 'plan' | 'apply';

export type ProvisionD1Action = 'ok' | 'adopt' | 'create' | 'created';

export type ProvisionWorkerState = 'found' | 'absent' | 'unknown';

export type ProvisionSecretStatus = 'ok' | 'missing' | 'worker-not-deployed' | 'unverified';

export interface ProvisionRequest {
  readonly target: string;
  readonly environment: DeployableEnvironment;
  readonly mode: ProvisionMode;
  readonly confirm?: string;
}

export interface ProvisionCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

export type ProvisionCommandRunner = (
  command: string,
  args: readonly string[],
  scope?: { readonly accountId: string },
) => Promise<ProvisionCommandResult>;

export interface ProvisionIo {
  readonly loadTargets: () => TargetsFile;
  readonly loadVersionedTargets: () => TargetsFile;
  readonly writeTargets: (file: TargetsFile) => void;
  readonly log: (message: string) => void;
}

export interface ProvisionOutcome {
  readonly workerName: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly d1Action: ProvisionD1Action;
  readonly workerState: ProvisionWorkerState;
  readonly secretStatus: ProvisionSecretStatus;
  readonly configUpdated: boolean;
}

// The only accepted production confirmation is the target Worker name
// itself: the operator must name the exact production Worker whose
// dependencies are being provisioned.
export function productionProvisionConfirmFor(resolved: ResolvedDeployment): string {
  return resolved.workerName;
}

// Stages the provisioned non-secret database id for the selected target
// environment, preserving every other target, environment, var and the file
// envelope. Only the selected slot changes, so unrelated configuration is
// never disturbed and no secret value can enter versioned configuration
// through this path.
export function stageProvisionedDatabaseId(
  file: TargetsFile,
  targetKey: string,
  environment: DeployableEnvironment,
  databaseId: string,
): TargetsFile {
  if (!isProvisionedDatabaseId(databaseId)) {
    throw new Error('Refusing to stage a database id that is not a provisioned D1 identifier.');
  }
  const target = file.targets.find((entry) => entry.key === targetKey);
  if (target === undefined) {
    throw new Error(`Unknown provisioning target "${targetKey}".`);
  }
  return {
    ...file,
    targets: file.targets.map((entry) =>
      entry.key === targetKey
        ? {
            ...entry,
            environments: {
              ...entry.environments,
              [environment]: { ...entry.environments[environment], databaseId },
            },
          }
        : entry,
    ),
  };
}

export async function runProvision(
  request: ProvisionRequest,
  io: ProvisionIo,
  runner: ProvisionCommandRunner,
): Promise<ProvisionOutcome> {
  const executionFile = io.loadTargets();
  const versionedFile = io.loadVersionedTargets();
  const resolved = resolveProvisioningTarget(executionFile, {
    target: request.target,
    environment: request.environment,
  });
  const accountId = resolved.accountId;
  if (accountId === undefined || accountId === '') {
    throw new Error('No Cloudflare account ID configured for the selected target and environment.');
  }
  const scopedRunner: ProvisionCommandRunner = (command, args) =>
    runner(command, args, { accountId });

  if (request.mode === 'apply' && resolved.environment === 'production') {
    const expected = productionProvisionConfirmFor(resolved);
    if (request.confirm !== expected) {
      throw new Error(
        `Refusing production provisioning without explicit confirmation: confirm must exactly equal the target Worker name ("${expected}"). Production is never an automatic side effect of sandbox.`,
      );
    }
  }

  io.log(
    `provision target=${resolved.targetKey} environment=${resolved.environment} worker=${resolved.workerName} database=${resolved.databaseName} mode=${request.mode}`,
  );

  const d1 = await provisionD1(request, resolved, io, scopedRunner);

  let configUpdated = false;
  if (request.mode === 'apply' && d1.effectiveId !== '' && d1.effectiveId !== resolved.databaseId) {
    const next = stageProvisionedDatabaseId(
      versionedFile,
      resolved.targetKey,
      resolved.environment,
      d1.effectiveId,
    );
    io.writeTargets(next);
    configUpdated = true;
    io.log(
      `staged non-secret database id in deploy/targets.json for target=${resolved.targetKey} environment=${resolved.environment}; review the diff and commit (provisioning never commits).`,
    );
  }

  const workerState = await discoverWorker(resolved, io, scopedRunner);
  const secretStatus: ProvisionSecretStatus = 'unverified';

  if (request.mode === 'plan' && d1.action === 'create') {
    io.log(
      `plan: D1 database ${resolved.databaseName} does not exist yet; rerun with --apply to create it and stage its id.`,
    );
  }
  if (workerState === 'absent') {
    io.log(
      `worker ${resolved.workerName} is not deployed yet; the first normal npm run deploy -- --target ${resolved.targetKey} --env ${resolved.environment} will create/publish it.`,
    );
  }

  return {
    workerName: resolved.workerName,
    databaseName: resolved.databaseName,
    databaseId: d1.effectiveId,
    d1Action: d1.action,
    workerState,
    secretStatus,
    configUpdated,
  };
}

async function provisionD1(
  request: ProvisionRequest,
  resolved: ResolvedDeployment,
  io: ProvisionIo,
  runner: ProvisionCommandRunner,
): Promise<{ readonly effectiveId: string; readonly action: ProvisionD1Action }> {
  const listed = await runner('npx', [...d1ListArgs()]);
  if (listed.exitCode !== 0) {
    throw new Error(
      `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": D1 discovery failed. Verify access with "npx wrangler d1 list --json" and rerun.`,
    );
  }
  const matches = matchExactDatabase(parseD1ListOutput(listed.stdout), resolved.databaseName);
  if (matches.length > 1) {
    throw new Error(
      `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": ambiguous D1 discovery for database "${resolved.databaseName}" (duplicate exact-name resources). Resolve the duplicate manually.`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    if (resolved.databaseId !== '') {
      throw new Error(
        `Refusing provisioning for target "${resolved.targetKey}" environment "${resolved.environment}": configured D1 ID is not present in the selected Cloudflare account. Verify the account or clear the stale ID before provisioning.`,
      );
    }
    if (request.mode === 'plan') {
      io.log(`d1 plan CREATE database=${resolved.databaseName}`);
      return { effectiveId: '', action: 'create' };
    }
    const created = await runner('npx', [...d1CreateArgs(resolved.databaseName)]);
    if (created.exitCode !== 0) {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": D1 creation failed for database "${resolved.databaseName}". Create it manually with "npx wrangler d1 create ${resolved.databaseName} --update-config=false" and rerun with --apply to stage its id.`,
      );
    }
    // Creation output is opaque success text plus a config snippet: it is
    // never parsed, logged or echoed. Rediscover the created id with the
    // approved `d1 list --json` contract and validate it before staging.
    const rediscovered = await runner('npx', [...d1ListArgs()]);
    if (rediscovered.exitCode !== 0) {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": D1 creation succeeded but rediscovery failed. Verify with "npx wrangler d1 list --json" and rerun with --apply to stage its id.`,
      );
    }
    let postMatches;
    try {
      postMatches = matchExactDatabase(
        parseD1ListOutput(rediscovered.stdout),
        resolved.databaseName,
      );
    } catch {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": D1 creation succeeded but rediscovery returned unexpected output for database "${resolved.databaseName}". Verify with "npx wrangler d1 list --json" and rerun with --apply to stage its id.`,
      );
    }
    if (postMatches.length > 1) {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": ambiguous D1 rediscovery for database "${resolved.databaseName}" (duplicate exact-name resources). Resolve the duplicate manually.`,
      );
    }
    const postMatch = postMatches[0];
    if (postMatch === undefined) {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": D1 creation succeeded but rediscovery found no exact-name database "${resolved.databaseName}". Verify with "npx wrangler d1 list --json" and rerun with --apply to stage its id.`,
      );
    }
    if (!isAcceptedRemoteDatabaseId(postMatch.uuid)) {
      throw new Error(
        `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": unexpected remote identifier for database "${resolved.databaseName}". Verify with "npx wrangler d1 list --json" and rerun with --apply to stage its id.`,
      );
    }
    io.log(`d1 created database=${resolved.databaseName}`);
    return { effectiveId: postMatch.uuid, action: 'created' };
  }
  if (!isAcceptedRemoteDatabaseId(match.uuid)) {
    throw new Error(
      `Unable to provision target "${resolved.targetKey}" environment "${resolved.environment}": unexpected remote identifier for database "${resolved.databaseName}".`,
    );
  }
  if (resolved.databaseId !== '' && resolved.databaseId !== match.uuid) {
    throw new Error(
      `Refusing provisioning for target "${resolved.targetKey}" environment "${resolved.environment}": the configured database id disagrees with the remote exact-name D1 database "${resolved.databaseName}". Resolve the mismatch manually.`,
    );
  }
  if (resolved.databaseId === '') {
    io.log(`d1 adopt database=${resolved.databaseName}`);
    return { effectiveId: match.uuid, action: 'adopt' };
  }
  io.log(`d1 verified database=${resolved.databaseName}`);
  return { effectiveId: match.uuid, action: 'ok' };
}

async function discoverWorker(
  resolved: ResolvedDeployment,
  io: ProvisionIo,
  runner: ProvisionCommandRunner,
): Promise<ProvisionWorkerState> {
  try {
    const result = await runner('npx', [...workerDeploymentsListArgs(resolved.workerName)]);
    if (result.exitCode !== 0) {
      io.log(
        `worker deployment state unknown for worker=${resolved.workerName}; verify with wrangler deployments list before deploying.`,
      );
      return 'unknown';
    }
    const discovery = parseWorkerDeploymentsOutput(result.stdout);
    io.log(
      discovery.found
        ? `worker deployed worker=${resolved.workerName}`
        : `worker absent worker=${resolved.workerName}`,
    );
    return discovery.found ? 'found' : 'absent';
  } catch {
    io.log(
      `worker deployment state unknown for worker=${resolved.workerName}; verify with wrangler deployments list before deploying.`,
    );
    return 'unknown';
  }
}
