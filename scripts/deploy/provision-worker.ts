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
const ANSI_ESCAPE_SEQUENCE = new RegExp(String.fromCharCode(27) + '\\[[0-?]*[ -/]*[@-~]', 'g');

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
  const trimmed = stderr.trim();

  try {
    const parsed = JSON.parse(stderr) as unknown;
    if (isAbsentWorkerEnvelope(parsed)) {
      return true;
    }
    return false;
  } catch {
    // Wrangler may render the API envelope as human-readable stderr.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      return false;
    }
  }

  return isAbsentWorkerText(stderr);
}

function isAbsentWorkerEnvelope(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.success !== false || !Array.isArray(record.errors)) {
    return false;
  }
  return record.errors.some((error) => {
    if (error === null || typeof error !== 'object' || Array.isArray(error)) {
      return false;
    }
    const entry = error as Record<string, unknown>;
    return entry.code === Number(ABSENT_WORKER_CODE) && typeof entry.message === 'string';
  });
}

function isAbsentWorkerText(stderr: string): boolean {
  const normalized = stderr.replace(ANSI_ESCAPE_SEQUENCE, '');
  const hasWorkerRequest = /\/workers\/scripts\/[^\s/]+(?:\/|\b)/i.test(normalized);
  const hasAbsentWorkerPhrase =
    /\bworker\s+(?:not found|does not exist)\b/i.test(normalized) ||
    /\bworkers\.api\.error\.script_not_found\b/i.test(normalized);
  const hasCode = /\bcode\s*:\s*10007\b/i.test(normalized);
  return hasWorkerRequest && hasAbsentWorkerPhrase && hasCode;
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
