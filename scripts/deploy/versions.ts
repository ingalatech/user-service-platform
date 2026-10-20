interface WorkerVersionRecord {
  readonly id?: unknown;
  readonly metadata?: unknown;
  readonly annotations?: unknown;
}

export interface WorkerVersionSummary {
  readonly id: string;
  readonly createdOn: string;
  readonly annotations: string;
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
