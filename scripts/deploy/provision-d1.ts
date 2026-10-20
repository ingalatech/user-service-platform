import { isProvisionedDatabaseId } from './environment-config.js';

// D1 provisioning provider contract (ticket #80).
//
// Discovery goes through Wrangler JSON output against the exact canonical
// database name (`wrangler d1 list --json`). Creation uses the supported
// `wrangler d1 create <canonical-name> --update-config=false` invocation:
// pinned Wrangler 4.130.0 has no `--json` flag for `d1 create` and prints
// human-readable success text plus a config snippet instead. Creation output
// is opaque text and is never parsed: after a successful create the caller
// rediscovers with `d1 list --json`, requires exactly one exact-name match,
// and validates its UUID before staging.
//
// The selected environment file, not a generated Wrangler file, is
// authoritative: creation explicitly disables Wrangler config updates.
//
// Secret boundary: this module consumes database names/ids only. Failure
// messages never echo provider output, so tokens, account identifiers or
// other provider fields cannot leak through diagnostics.

export interface RemoteDatabase {
  readonly name: string;
  readonly uuid: string;
}

// Read-only remote D1 discovery invocation.
export function d1ListArgs(): readonly string[] {
  return ['wrangler', 'd1', 'list', '--json'];
}

// Exact-name D1 creation invocation. Creation output is opaque success
// text plus a config snippet (never JSON): the caller ignores it and
// rediscovers the created id with `d1 list --json`. Config updates are
// explicitly disabled so the repository target registry stays authoritative.
export function d1CreateArgs(databaseName: string): readonly string[] {
  return ['wrangler', 'd1', 'create', databaseName, '--update-config=false'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Parses the names/ids-only provider discovery output, keeping `name`/`uuid`
// pairs only. Unknown extra fields (including any value-shaped fields a
// future provider might add) are dropped, never consumed or logged.
// Non-array output fails closed with a fixed message that echoes nothing
// from the provider.
export function parseD1ListOutput(stdout: string): RemoteDatabase[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    throw new Error('Unable to verify remote D1 databases: unexpected discovery output.');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Unable to verify remote D1 databases: unexpected discovery output.');
  }
  const databases: RemoteDatabase[] = [];
  for (const entry of parsed) {
    if (!isRecord(entry)) {
      continue;
    }
    const name: unknown = entry.name;
    const uuid: unknown = entry.uuid;
    if (typeof name === 'string' && typeof uuid === 'string') {
      databases.push({ name, uuid });
    }
  }
  return databases;
}

// Matches the exact canonical database name. Matching is exact and
// case-sensitive: prefix or cross-environment names never satisfy the check,
// so one target can never adopt another target's database.
export function matchExactDatabase(
  remotes: readonly RemoteDatabase[],
  databaseName: string,
): RemoteDatabase[] {
  return remotes.filter((entry) => entry.name === databaseName);
}

// Validates a discovered or created remote id with the same provisioned-id
// shape the deployer enforces. Uniform placeholders, empty slots and
// synthetic fixtures fail closed instead of becoming accepted ids.
export function isAcceptedRemoteDatabaseId(databaseId: string): boolean {
  return isProvisionedDatabaseId(databaseId);
}
