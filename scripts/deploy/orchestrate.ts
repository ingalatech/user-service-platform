import type { DeploymentTarget, ResolvedDeployment } from './environment-config.js';
import {
  assertRequiredSecretBindings,
  parseWorkerVersionDetails,
  parseWorkerVersions,
  type WorkerVersionDetails,
} from './versions.js';
import {
  buildVersionManifest,
  parseVersionManifest,
  requiredSecretNamesForTransport,
} from './manifest.js';
import { isAbsentWorkerError } from './provision-worker.js';
import {
  drainSessionFailureTail,
  parseTailLines,
  SESSION_FAILURE_TAIL_DRAIN_MS,
  summarizeSessionFailures,
  type SessionFailureTailHandle,
} from './diagnostic-tail.js';

export type { SessionFailureTailHandle } from './diagnostic-tail.js';

// Deployment orchestration (ticket #78, ADR-0008).
//
// Reuses the existing migration, deploy, deployment-record and smoke
// semantics rather than creating a parallel release model: versioned D1
// migrations are validated locally, applied remotely, then the Worker is
// deployed from a temporary target-specific Wrangler config. Sandbox releases
// record the deployment and run the existing smoke test; production releases
// record the deployment without smoke and require an explicit confirmation.
//
// Production safety: a production deployment proceeds only when `confirm`
// exactly equals the materialized Worker name. The check runs before
// preflight and any remote mutation, and no push/merge path can supply it
// implicitly. A dry run executes the read-only preflight and then returns
// without running any mutating deployment command. The
// temporary config is removed in `finally`, even when deployment fails.
// Promotion is deliberately narrower: it receives only target identity and
// uses a minimal Wrangler config, so changing the current environment profile
// cannot rebuild or alter the immutable version selected for promotion.
//
// Secret boundary: the orchestrator passes Cloudflare credentials through by
// inheritance (child processes keep their own environment) and never reads,
// logs, or forwards secret values. Logs carry only non-secret deployment
// metadata: target key, environment, Worker/D1 names and step outcomes.

export type DeploymentStep =
  | 'preflight'
  | 'build-admin-assets'
  | 'validate-migrations-local'
  | 'migrate-remote'
  | 'deploy-worker'
  | 'record-deployment'
  | 'smoke-sandbox';

export interface DeployRequest {
  readonly resolved: ResolvedDeployment;
  readonly confirm?: string;
  readonly dryRun?: boolean;
}

export interface DeployCommandResult {
  readonly exitCode: number;
  readonly stdout?: string;
  readonly stderr?: string;
}

export interface DeployCommandOptions {
  readonly env?: NodeJS.ProcessEnv;
}

export type DeployCommandRunner = (
  command: string,
  args: string[],
  options?: DeployCommandOptions,
) => Promise<DeployCommandResult>;

export interface PromotionRequest {
  readonly resolved: DeploymentTarget;
  readonly versionId: string;
  readonly confirm?: string;
}

export interface PromotionIo {
  readonly materialize: (resolved: DeploymentTarget) => string;
  readonly cleanup: (path: string) => void;
  readonly preflight: (resolved: DeploymentTarget) => Promise<void>;
  readonly log: (message: string) => void;
  readonly smoke: (resolved: DeploymentTarget, versionUrl: string) => Promise<void>;
}

export function promotionSmokeCommand(
  environment: DeploymentTarget['environment'],
): readonly [string, readonly string[]] {
  return ['npm', ['run', environment === 'production' ? 'smoke:production' : 'smoke:readiness']];
}

export function smokeEnvironment(resolved: DeploymentTarget): NodeJS.ProcessEnv {
  const workerUrl = resolved.workerUrl.trim();
  if (workerUrl.length === 0) {
    throw new Error('Cannot run smoke without the selected environment Worker URL.');
  }
  const baseName =
    resolved.environment === 'production' ? 'SMOKE_PRODUCTION_BASE_URL' : 'SMOKE_SANDBOX_BASE_URL';
  return {
    ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }),
    [baseName]: workerUrl,
  };
}

export async function runPromotion(
  request: PromotionRequest,
  io: PromotionIo,
  runner: DeployCommandRunner,
): Promise<void> {
  const versionId = request.versionId.trim();
  if (!/^[a-zA-Z0-9-]+$/.test(versionId)) {
    throw new Error('A valid immutable Worker Version ID must be selected.');
  }
  const configPath = io.materialize(request.resolved);
  try {
    if (
      request.resolved.environment === 'production' &&
      request.confirm !== request.resolved.workerName
    ) {
      throw new Error(
        `Refusing production promotion; type the exact Worker name "${request.resolved.workerName}" to confirm.`,
      );
    }
    await io.preflight(request.resolved);
    const listed = await runner('npx', [
      'wrangler',
      'versions',
      'list',
      '--json',
      '--config',
      configPath,
    ]);
    if (listed.exitCode !== 0) {
      throw new Error('list-worker-versions failed.');
    }
    let versions: unknown;
    try {
      versions = JSON.parse(listed.stdout ?? '[]') as unknown;
    } catch {
      throw new Error('Unable to read Worker versions.');
    }
    if (!parseWorkerVersions(versions).some((version) => version.id === versionId)) {
      throw new Error('The selected immutable Worker Version ID is not available for this Worker.');
    }
    const viewed = await runner('npx', [
      'wrangler',
      'versions',
      'view',
      '--json',
      versionId,
      '--config',
      configPath,
    ]);
    if (viewed.exitCode !== 0) throw new Error('view-worker-version failed.');
    let versionDetailsValue: unknown;
    try {
      versionDetailsValue = JSON.parse(viewed.stdout ?? 'null') as unknown;
    } catch {
      throw new Error('Unable to read selected Worker Version metadata.');
    }
    const versionDetails = parseWorkerVersionDetails(versionDetailsValue);
    if (versionDetails?.id !== versionId) {
      throw new Error('Selected Worker Version metadata does not match the full Version ID.');
    }
    const manifest = parseVersionManifest(versionDetails.annotationValues);
    assertRequiredSecretBindings(
      versionDetails,
      requiredSecretNamesForTransport(manifest.mailTransport),
    );
    const versionUrl = versionUrlForVerifiedVersion(request.resolved, versionDetails);
    await io.smoke(request.resolved, versionUrl);
    const promoted = await runner('npx', [
      'wrangler',
      'versions',
      'deploy',
      `${versionId}@100%`,
      '--config',
      configPath,
    ]);
    if (promoted.exitCode !== 0) {
      throw new Error('promote-worker-version failed.');
    }
    io.log(`promoted worker=${request.resolved.workerName} version=${versionId}`);
  } finally {
    io.cleanup(configPath);
  }
}

// Version URLs use the first eight characters of the immutable Version ID and
// the exact Worker workers.dev hostname. Reject custom domains rather than
// silently testing the active deployment or another Worker.
export function versionUrlForVerifiedVersion(
  target: DeploymentTarget,
  version: WorkerVersionDetails,
): string {
  const versionId = version.id;
  const authoritativeUrl = version.previewUrl;
  if (authoritativeUrl !== undefined) {
    const parsed = new URL(authoritativeUrl);
    const targetWorkerUrl = new URL(target.workerUrl);
    const expectedSuffix = `-${target.workerName}.${targetWorkerUrl.hostname.slice(`${target.workerName}.`.length)}`;
    if (
      parsed.protocol !== 'https:' ||
      !parsed.hostname.endsWith('.workers.dev') ||
      !parsed.hostname.endsWith(expectedSuffix)
    ) {
      throw new Error(
        'Cloudflare returned an invalid Version URL for the selected Worker Version.',
      );
    }
    return parsed.toString().replace(/\/$/, '');
  }
  const workerUrl = new URL(target.workerUrl);
  const expectedPrefix = `${target.workerName}.`;
  if (!workerUrl.hostname.startsWith(expectedPrefix)) {
    throw new Error(
      'Promotion requires the target Worker URL to be its workers.dev hostname for Version URL readiness.',
    );
  }
  const subdomain = workerUrl.hostname.slice(expectedPrefix.length);
  if (subdomain.length === 0 || !subdomain.endsWith('.workers.dev')) {
    throw new Error(
      'Promotion requires the target Worker URL to be its workers.dev hostname for Version URL readiness.',
    );
  }
  // Wrangler 4.130 does not expose the preview URL from `versions view`; the
  // preceding remote view verified the complete UUID. Only then is the
  // documented Version URL prefix format used as the Cloudflare fallback.
  const versionPrefix = versionId.substring(0, 8);
  return `https://${versionPrefix}-${target.workerName}.${subdomain}`;
}

export interface DeployIo {
  readonly materialize: (resolved: ResolvedDeployment) => string;
  readonly cleanup: (path: string) => void;
  readonly preflight: (resolved: ResolvedDeployment) => Promise<void>;
  readonly log: (message: string) => void;
  readonly sourceMetadata?: () => Promise<{ readonly commit: string; readonly branch: string }>;
  readonly confirmFirstDeployment?: (workerName: string) => Promise<boolean>;
  // Optional bounded diagnostic tail for the sandbox smoke window (ticket
  // #96). When present and the environment is sandbox, the deploy boundary
  // starts the tail immediately before `smoke-sandbox` and always terminates
  // it afterward via `stop()`. Production never receives a tail. Absence of
  // the hook (older harnesses, dry runs without tail support) runs the smoke
  // unchanged.
  readonly startSessionFailureTail?: (
    resolved: ResolvedDeployment,
    configPath: string,
  ) => Promise<SessionFailureTailHandle>;
}

// The only accepted production confirmation is the target Worker name
// itself: the operator must name the exact production Worker being mutated.
export function productionConfirmFor(resolved: DeploymentTarget): string {
  return resolved.workerName;
}

export function planDeploymentSteps(
  request: DeployRequest,
  options: { readonly firstDeployment?: boolean } = {},
): DeploymentStep[] {
  const steps: DeploymentStep[] = [
    'preflight',
    'build-admin-assets',
    'validate-migrations-local',
    'migrate-remote',
    'deploy-worker',
    'record-deployment',
  ];
  if (request.resolved.environment === 'sandbox' && options.firstDeployment !== false) {
    steps.push('smoke-sandbox');
  }
  return steps;
}

function assertProductionConfirmed(request: DeployRequest): void {
  if (request.resolved.environment !== 'production') {
    return;
  }
  const expected = productionConfirmFor(request.resolved);
  if (request.confirm !== expected) {
    throw new Error(
      `Refusing production deployment without explicit confirmation: confirm must exactly equal the target Worker name ("${expected}"). Production is never an automatic side effect of sandbox or main.`,
    );
  }
}

async function collectTailLines(
  tail: SessionFailureTailHandle | null,
  io: DeployIo,
): Promise<readonly string[]> {
  if (tail === null) {
    return [];
  }
  try {
    return await tail.stop();
  } catch {
    io.log('sandbox smoke diagnostic: session failure tail stop failed');
    return [];
  }
}

function tailExitedBeforeSmoke(tail: SessionFailureTailHandle): boolean {
  if (tail.exitedBeforeSmoke) {
    return true;
  }
  try {
    return !tail.isLive();
  } catch {
    return false;
  }
}

// Bounded post-failure drain (ticket #102): keeps the live tail open briefly
// after the smoke client already observed the failure so the asynchronous
// Cloudflare invocation envelope can arrive. Ends early on a whitelisted
// event; otherwise expires and reports `phase unavailable` with a liveness
// proof. The drain sleep stays awaited and referenced (ticket #100), raw
// incremental snapshots stay private, and only whitelisted `event`/`phase`/
// optional `requestId`/`environment` may be logged.
async function collectDrainedTailLines(
  tail: SessionFailureTailHandle,
  io: DeployIo,
): Promise<{ readonly lines: readonly string[]; readonly liveThroughDrain: boolean }> {
  try {
    const outcome = await drainSessionFailureTail(tail);
    return { lines: outcome.lines, liveThroughDrain: outcome.liveThroughDrain };
  } catch {
    io.log('sandbox smoke diagnostic: session failure tail stop failed');
    return { lines: [], liveThroughDrain: false };
  }
}

// Sandbox smoke wrapped with the bounded diagnostic tail (tickets #96/#98/#102).
// Starts the tail immediately before the smoke and always terminates it
// afterward. Tail startup waits its bounded readiness grace before the smoke
// runs, so the tail is connected before the fast health then anonymous `GET
// /v1/me` sequence; a slow connect still degrades to the ticket-allowed
// `phase unavailable` rather than unfiltered logs. A child that exits during
// the grace is classified as `exited before smoke` with a fixed safe message
// rather than a misleading live empty tail. A failed smoke keeps the live tail
// open for the bounded drain window before terminating it, preferring early
// exit on a whitelisted event.
async function runSandboxSmokeWithDiagnostics(
  resolved: ResolvedDeployment,
  configPath: string,
  io: DeployIo,
  runner: DeployCommandRunner,
): Promise<void> {
  let tail: SessionFailureTailHandle | null = null;
  if (io.startSessionFailureTail !== undefined) {
    try {
      tail = await io.startSessionFailureTail(resolved, configPath);
    } catch {
      tail = null;
      io.log(
        'sandbox smoke diagnostic: session failure tail unavailable ' +
          '(continuing smoke without diagnostics)',
      );
    }
  }
  try {
    await runStep('smoke-sandbox', 'npm', ['run', 'smoke:health'], runner, {
      env: smokeEnvironment(resolved),
    });
  } catch (smokeError) {
    if (tail !== null && tailExitedBeforeSmoke(tail)) {
      await collectTailLines(tail, io);
      io.log('sandbox smoke diagnostic: session failure tail unavailable (exited before smoke)');
      throw smokeError;
    }
    if (tail !== null) {
      const drained = await collectDrainedTailLines(tail, io);
      const events = parseTailLines(drained.lines);
      if (events.length > 0) {
        io.log(summarizeSessionFailures(events));
      } else if (drained.liveThroughDrain) {
        io.log(
          `${summarizeSessionFailures([])} (tail live through ${String(SESSION_FAILURE_TAIL_DRAIN_MS)}ms drain)`,
        );
      } else {
        io.log(`${summarizeSessionFailures([])} (tail exited during drain)`);
      }
      throw smokeError;
    }
    io.log(summarizeSessionFailures(parseTailLines(await collectTailLines(tail, io))));
    throw smokeError;
  }
  const events = parseTailLines(await collectTailLines(tail, io));
  if (events.length > 0) {
    io.log(summarizeSessionFailures(events));
  } else {
    io.log('sandbox smoke diagnostic: no session.resolve-failed event observed');
  }
}
async function runStep(
  step: DeploymentStep,
  command: string,
  args: string[],
  runner: DeployCommandRunner,
  options?: DeployCommandOptions,
): Promise<void> {
  const result = await runner(command, args, options);
  if (result.exitCode !== 0) {
    throw new Error(`${step} failed (exit ${String(result.exitCode)}).`);
  }
}

export interface DeploymentOutcome {
  readonly workerName: string;
  readonly steps: DeploymentStep[];
}

export async function runDeployment(
  request: DeployRequest,
  io: DeployIo,
  runner: DeployCommandRunner,
): Promise<DeploymentOutcome> {
  const configPath = io.materialize(request.resolved);
  try {
    assertProductionConfirmed(request);
    await io.preflight(request.resolved);
    let steps = planDeploymentSteps(request);
    if (request.dryRun === true) {
      io.log(
        `dry-run target=${request.resolved.targetKey} environment=${request.resolved.environment} worker=${request.resolved.workerName} database=${request.resolved.databaseName} steps=${steps.join(',')}`,
      );
      return { workerName: request.resolved.workerName, steps };
    }
    io.log(
      `deploy target=${request.resolved.targetKey} environment=${request.resolved.environment} worker=${request.resolved.workerName}`,
    );
    // Determine whether this is the Cloudflare-required active first deploy
    // before building or applying migrations: the operator's confirmation
    // must precede every remote mutation.
    const versions = await runner('npx', [
      'wrangler',
      'versions',
      'list',
      '--json',
      '--config',
      configPath,
    ]);
    if (versions.exitCode !== 0 && !isAbsentWorkerError(versions.stderr)) {
      throw new Error('list-worker-versions failed.');
    }
    let existingVersions: unknown = [];
    if (versions.exitCode === 0) {
      try {
        existingVersions = JSON.parse(versions.stdout ?? '[]') as unknown;
      } catch {
        throw new Error('Unable to determine whether the Worker already exists.');
      }
    }
    if (!Array.isArray(existingVersions)) {
      throw new Error('Unable to determine whether the Worker already exists.');
    }
    const isFirstDeployment = existingVersions.length === 0;
    steps = planDeploymentSteps(request, { firstDeployment: isFirstDeployment });
    if (isFirstDeployment) {
      io.log(
        `first deployment for worker=${request.resolved.workerName} will activate its first version; Cloudflare does not support an inactive initial version`,
      );
      if ((await io.confirmFirstDeployment?.(request.resolved.workerName)) !== true) {
        throw new Error(
          'First deployment cancelled; explicit activation confirmation is required.',
        );
      }
    }
    // Administration SPA assets (ticket #124, ADR-0012): rebuild `admin/dist`
    // from versioned sources before any remote mutation so every deployment
    // serves the current built assets through the materialized ASSETS binding.
    await runStep('build-admin-assets', 'npm', ['run', 'build:admin'], runner);
    // Local migration validation uses the base config (no --config): it
    // proves the versioned migrations apply before any remote mutation.
    await runStep(
      'validate-migrations-local',
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--local'],
      runner,
    );
    await runStep(
      'migrate-remote',
      'npx',
      ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', configPath],
      runner,
    );
    if (isFirstDeployment) {
      await runStep('deploy-worker', 'npx', ['wrangler', 'deploy', '--config', configPath], runner);
    } else {
      const source = (await io.sourceMetadata?.()) ?? { commit: 'unknown', branch: 'unknown' };
      const tag = new Date().toISOString();
      const manifest = buildVersionManifest(request.resolved.applicationConfig);
      await runStep(
        'deploy-worker',
        'npx',
        [
          'wrangler',
          'versions',
          'upload',
          '--message',
          `${manifest.message} commit=${source.commit} branch=${source.branch} uploaded=${tag}`,
          '--tag',
          manifest.tag,
          '--config',
          configPath,
        ],
        runner,
      );
    }
    await runStep(
      'record-deployment',
      'npx',
      ['wrangler', 'deployments', 'list', '--config', configPath],
      runner,
    );
    if (request.resolved.environment === 'sandbox' && isFirstDeployment) {
      await runSandboxSmokeWithDiagnostics(request.resolved, configPath, io, runner);
    } else if (request.resolved.environment === 'sandbox') {
      io.log('candidate uploaded; stable-origin smoke is deferred until promotion');
    }
    io.log(`deployed worker=${request.resolved.workerName}`);
    return { workerName: request.resolved.workerName, steps };
  } finally {
    io.cleanup(configPath);
  }
}
