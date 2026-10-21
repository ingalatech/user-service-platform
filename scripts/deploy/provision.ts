import {
  d1CreateArgs,
  d1ListArgs,
  isAcceptedRemoteDatabaseId,
  matchExactDatabase,
  parseD1ListOutput,
} from './provision-d1.js';
import { parseWorkerDeploymentsOutput, workerDeploymentsListArgs } from './provision-worker.js';
import {
  resolveEnvironmentDeployment,
  type EnvironmentFile,
  type ResolvedDeployment,
} from './environment-config.js';
import type { DeployableEnvironment } from './naming.js';

export const PROVISION_RESOURCE_KINDS = ['d1'] as const;
export type ProvisionResourceKind = (typeof PROVISION_RESOURCE_KINDS)[number];
export type ProvisionMode = 'plan' | 'apply';
export type ProvisionD1Action = 'ok' | 'adopt' | 'create' | 'created';
export type ProvisionWorkerState = 'found' | 'absent' | 'unknown';

export interface ProvisionRequest {
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
  readonly loadEnvironment: () => EnvironmentFile;
  readonly writeEnvironment: (file: EnvironmentFile) => void;
  readonly log: (message: string) => void;
}

export interface ProvisionOutcome {
  readonly workerName: string;
  readonly databaseName: string;
  readonly databaseId: string;
  readonly d1Action: ProvisionD1Action;
  readonly workerState: ProvisionWorkerState;
  readonly configUpdated: boolean;
}

export function stageProvisionedDatabaseId(
  file: EnvironmentFile,
  databaseId: string,
): EnvironmentFile {
  if (!isAcceptedRemoteDatabaseId(databaseId)) {
    throw new Error('Refusing to stage a database id that is not a provisioned D1 identifier.');
  }
  return { ...file, D1_ID: databaseId };
}

export async function runProvision(
  request: ProvisionRequest,
  io: ProvisionIo,
  runner: ProvisionCommandRunner,
): Promise<ProvisionOutcome> {
  if (request.environment !== 'sandbox') {
    throw new Error('Production provisioning is not supported; provision sandbox only.');
  }
  const file = io.loadEnvironment();
  const resolved = resolveEnvironmentDeployment(file);
  if (resolved.accountId === undefined || resolved.accountId === '') {
    throw new Error('No Cloudflare account ID configured for the selected environment.');
  }
  const accountId = resolved.accountId;
  const scopedRunner: ProvisionCommandRunner = (command, args) =>
    runner(command, args, { accountId });
  io.log(
    `provision environment=${resolved.environment} worker=${resolved.workerName} database=${resolved.databaseName} mode=${request.mode}`,
  );

  const listed = await scopedRunner('npx', [...d1ListArgs()]);
  if (listed.exitCode !== 0) throw new Error('D1 discovery failed.');
  const matches = matchExactDatabase(parseD1ListOutput(listed.stdout), resolved.databaseName);
  if (matches.length > 1) throw new Error('D1 discovery returned duplicate exact-name resources.');

  let databaseId = resolved.databaseId;
  let action: ProvisionD1Action;
  const match = matches[0];
  if (match === undefined) {
    if (databaseId !== '') throw new Error('Configured D1 ID is absent from the selected account.');
    if (request.mode === 'plan') {
      action = 'create';
    } else {
      const created = await scopedRunner('npx', [...d1CreateArgs(resolved.databaseName)]);
      if (created.exitCode !== 0) throw new Error('D1 creation failed.');
      const rediscovered = await scopedRunner('npx', [...d1ListArgs()]);
      if (rediscovered.exitCode !== 0) throw new Error('D1 rediscovery failed after creation.');
      let postMatches: ReturnType<typeof matchExactDatabase>;
      try {
        postMatches = matchExactDatabase(
          parseD1ListOutput(rediscovered.stdout),
          resolved.databaseName,
        );
      } catch {
        throw new Error('D1 rediscovery failed after creation.');
      }
      const postMatch = postMatches[0];
      if (postMatch === undefined || !isAcceptedRemoteDatabaseId(postMatch.uuid)) {
        throw new Error('D1 rediscovery did not return one valid exact-name resource.');
      }
      databaseId = postMatch.uuid;
      action = 'created';
    }
  } else {
    if (!isAcceptedRemoteDatabaseId(match.uuid))
      throw new Error('Remote D1 identifier is invalid.');
    if (databaseId !== '' && databaseId !== match.uuid)
      throw new Error('Configured D1 ID disagrees with the remote resource.');
    databaseId = match.uuid;
    action = resolved.databaseId === '' ? 'adopt' : 'ok';
  }

  let configUpdated = false;
  if (request.mode === 'apply' && databaseId !== '' && databaseId !== resolved.databaseId) {
    io.writeEnvironment(stageProvisionedDatabaseId(file, databaseId));
    configUpdated = true;
    io.log('staged the discovered D1 ID in the selected environment file; review the diff.');
  }

  const workerState = await discoverWorker(resolved, scopedRunner, io);
  return {
    workerName: resolved.workerName,
    databaseName: resolved.databaseName,
    databaseId,
    d1Action: action,
    workerState,
    configUpdated,
  };
}

async function discoverWorker(
  resolved: ResolvedDeployment,
  runner: ProvisionCommandRunner,
  io: ProvisionIo,
): Promise<ProvisionWorkerState> {
  const result = await runner('npx', [...workerDeploymentsListArgs(resolved.workerName)]);
  if (result.exitCode !== 0) return 'unknown';
  let discovery: ReturnType<typeof parseWorkerDeploymentsOutput>;
  try {
    discovery = parseWorkerDeploymentsOutput(result.stdout);
  } catch {
    return 'unknown';
  }
  const state = discovery.found ? 'found' : 'absent';
  io.log(`worker ${state} worker=${resolved.workerName}`);
  return state;
}
