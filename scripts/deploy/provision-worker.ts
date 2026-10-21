// Read-only Worker/deployment discovery for provisioning (ticket #80).
//
// Provisioning discovers whether the target Worker is deployed yet through
// `deployments list --name <worker> --json`. An absent Worker is not an
// error: the first normal `npm run deploy` creates/publishes it.
// Provisioning never publishes application code and never creates a
// placeholder Worker.
//
// Failure messages never echo provider output.

export interface WorkerDiscovery {
  readonly found: boolean;
}

const ABSENT_WORKER_CODE = '10007';

// Read-only deployment discovery invocation for the exact target Worker
// name. Values are never requested; the command reports deployment records.
export function workerDeploymentsListArgs(workerName: string): readonly string[] {
  return ['wrangler', 'deployments', 'list', '--name', workerName, '--json'];
}

// Cloudflare reports a missing Worker as an API error rather than an empty
// listing. Only the provider's stable error code is useful here; the stderr
// payload itself must never cross this boundary.
export function isAbsentWorkerError(stderr: string | undefined): boolean {
  if (stderr === undefined || stderr.trim() === '') {
    return false;
  }

  try {
    const parsed = JSON.parse(stderr) as unknown;
    if (containsErrorCode(parsed)) {
      return true;
    }
  } catch {
    // Wrangler may render the API envelope as human-readable stderr.
  }

  return /(?:error\s+)?code\s*[:=]\s*["']?10007\b/i.test(stderr);
}

function containsErrorCode(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsErrorCode);
  }
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.code === ABSENT_WORKER_CODE || record.code === Number(ABSENT_WORKER_CODE)) &&
    (record.message === undefined || typeof record.message === 'string')
  ) {
    return true;
  }
  return Object.values(record).some(containsErrorCode);
}

// Parses the provider deployment listing: an empty array means the Worker is
// not deployed yet, a non-empty array means a deployment exists. Non-array
// output fails closed with a fixed message that echoes nothing from the
// provider.
export function parseWorkerDeploymentsOutput(stdout: string): WorkerDiscovery {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to verify Worker deployment state: unexpected discovery output.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to verify Worker deployment state: unexpected discovery output.');
  }
  return { found: parsed.length > 0 };
}
