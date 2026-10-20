export const SECRET_TEXT_TYPE = 'secret_text';

export interface RemoteSecretBinding {
  readonly name: string;
  readonly type: string;
}

export type SecretBindingStatus = 'ok' | 'missing' | 'wrong-type';

export interface SecretBindingResult {
  readonly name: string;
  readonly status: SecretBindingStatus;
}

export function secretListArgs(workerName: string): readonly string[] {
  return ['wrangler', 'secret', 'list', '--format', 'json', '--name', workerName];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSecretListOutput(stdout: string): RemoteSecretBinding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to verify required Worker secrets: unexpected secret list output.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to verify required Worker secrets: unexpected secret list output.');
  }
  const bindings: RemoteSecretBinding[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) continue;
    if (typeof entry.name === 'string' && typeof entry.type === 'string') {
      bindings.push({ name: entry.name, type: entry.type });
    }
  }
  return bindings;
}

export function checkSecretTextBindings(
  required: readonly string[],
  remote: readonly RemoteSecretBinding[],
): SecretBindingResult[] {
  return required.map((name) => {
    const match = remote.find((entry) => entry.name === name);
    if (match === undefined) return { name, status: 'missing' as const };
    if (match.type !== SECRET_TEXT_TYPE) return { name, status: 'wrong-type' as const };
    return { name, status: 'ok' as const };
  });
}

export function secretBindingsFailed(results: readonly SecretBindingResult[]): boolean {
  return results.some((result) => result.status !== 'ok');
}

export function formatSecretBindingsError(
  workerName: string,
  results: readonly SecretBindingResult[],
): Error {
  const failures = results
    .filter((result) => result.status !== 'ok')
    .map((result) =>
      result.status === 'missing'
        ? `${result.name} (missing)`
        : `${result.name} (not ${SECRET_TEXT_TYPE})`,
    );
  return new Error(
    `Required Worker secrets are not ${SECRET_TEXT_TYPE} bindings on "${workerName}": ${failures.join(', ')}. Recreate them as Cloudflare Secrets, not Variables.`,
  );
}
