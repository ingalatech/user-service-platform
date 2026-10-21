interface WorkerVersionRecord {
  readonly id?: unknown;
  readonly metadata?: unknown;
  readonly annotations?: unknown;
  readonly preview_url?: unknown;
  readonly resources?: unknown;
}

export interface WorkerVersionSummary {
  readonly id: string;
  readonly createdOn: string;
  readonly annotations: string;
}

export interface WorkerVersionDetails extends WorkerVersionSummary {
  readonly previewUrl?: string;
  readonly secretBindings: ReadonlyMap<string, string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function summarizeWorkerVersion(value: unknown): WorkerVersionSummary | undefined {
  if (!isRecord(value)) return undefined;
  const record = value as WorkerVersionRecord;
  if (typeof record.id !== 'string') return undefined;
  const metadata = isRecord(record.metadata) ? record.metadata : {};
  const createdOn = typeof metadata.created_on === 'string' ? metadata.created_on : '';
  const annotations = isRecord(record.annotations)
    ? Object.entries(record.annotations)
        .filter(([, annotation]) => typeof annotation === 'string')
        .map(([name, annotation]) => `${name}=${String(annotation)}`)
        .join(' ')
    : '';
  return { id: record.id, createdOn, annotations };
}

export function parseWorkerVersions(value: unknown): WorkerVersionSummary[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((version) => {
    const summary = summarizeWorkerVersion(version);
    return summary === undefined ? [] : [summary];
  });
}

export function parseWorkerVersionDetails(value: unknown): WorkerVersionDetails | undefined {
  const summary = summarizeWorkerVersion(value);
  if (summary === undefined || !isRecord(value)) return undefined;
  const record = value as WorkerVersionRecord;
  const resources = isRecord(record.resources) ? record.resources : {};
  const rawBindings = Array.isArray(resources.bindings) ? resources.bindings : [];
  const secretBindings = new Map<string, string>();
  for (const binding of rawBindings) {
    if (!isRecord(binding)) continue;
    if (typeof binding.name !== 'string' || typeof binding.type !== 'string') continue;
    if (binding.type === 'secret_text') secretBindings.set(binding.name, binding.type);
  }
  return {
    ...summary,
    ...(typeof record.preview_url === 'string' ? { previewUrl: record.preview_url } : {}),
    secretBindings,
  };
}

export function assertRequiredSecretBindings(
  details: WorkerVersionDetails,
  names: readonly string[],
): void {
  for (const name of names) {
    if (details.secretBindings.get(name) !== 'secret_text') {
      throw new Error(`Selected Worker Version is missing required encrypted binding "${name}".`);
    }
  }
}
