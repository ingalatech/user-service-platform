import { createHash } from 'node:crypto';
import type { NonSecretProfile, SecretVarName } from '../../src/config/index.js';

const MANIFEST_MESSAGE_PREFIX = 'user-service-manifest/v2';
const FINGERPRINT_PATTERN = '[0-9a-f]{64}';
const COMMIT_PATTERN = '[0-9a-f]{7,64}';
const SAFE_TOKEN_PATTERN = '[^\\s]+';

export interface VersionManifest {
  readonly branch: string;
  readonly commit: string;
  readonly fingerprint: string;
  readonly mailTransport: string;
  readonly message: string;
  readonly tag: string;
}

export interface VersionProvenance {
  readonly branch: string;
  readonly commit: string;
  readonly tag: string;
}

function canonicalProfile(profile: NonSecretProfile): string {
  const sortedProfile = Object.fromEntries(
    Object.entries(profile).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)),
  );
  return JSON.stringify({
    compiledConfig: sortedProfile,
    AUTH_MAIL_TRANSPORT: profile.AUTH_MAIL_TRANSPORT,
  });
}

function fingerprintForProfile(profile: NonSecretProfile): string {
  return createHash('sha256').update(canonicalProfile(profile)).digest('hex');
}

function transportToken(transport: string): string {
  const normalized = transport.trim().toLowerCase();
  return encodeURIComponent(normalized === '' ? 'empty' : normalized);
}

function decodeTransportToken(token: string): string {
  const decoded = decodeURIComponent(token);
  return decoded === 'empty' ? '' : decoded;
}

export function versionLabel(branch: string, commit: string, now: Date): string {
  const timestamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  const sanitizedBranch =
    branch
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 38) || 'detached';
  return `${commit.slice(0, 7)}-${timestamp}-${sanitizedBranch}`;
}

export function buildVersionManifest(
  profile: NonSecretProfile,
  provenance: VersionProvenance,
): VersionManifest {
  const fingerprint = fingerprintForProfile(profile);
  const message =
    `${MANIFEST_MESSAGE_PREFIX} commit=${provenance.commit} ` +
    `branch=${encodeURIComponent(provenance.branch)} fingerprint=${fingerprint} ` +
    `transport=${transportToken(profile.AUTH_MAIL_TRANSPORT)}`;
  return {
    branch: provenance.branch,
    commit: provenance.commit,
    fingerprint,
    mailTransport: profile.AUTH_MAIL_TRANSPORT.trim().toLowerCase(),
    message,
    tag: provenance.tag,
  };
}

export function parseVersionManifest(
  annotations: Readonly<Record<string, unknown>>,
): Pick<VersionManifest, 'branch' | 'commit' | 'fingerprint' | 'mailTransport'> {
  const message = annotations['workers/message'];
  const tag = annotations['workers/tag'];
  if (typeof message !== 'string' || typeof tag !== 'string') {
    throw new Error('Selected Worker Version is missing the required release manifest.');
  }
  const messageMatch = new RegExp(
    `^${MANIFEST_MESSAGE_PREFIX.replace('/', '\\/')} commit=(${COMMIT_PATTERN}) branch=(${SAFE_TOKEN_PATTERN}) fingerprint=(${FINGERPRINT_PATTERN}) transport=(${SAFE_TOKEN_PATTERN})$`,
  ).exec(message);
  const commit = messageMatch?.[1];
  const encodedBranch = messageMatch?.[2];
  const fingerprint = messageMatch?.[3];
  const transport = messageMatch?.[4];
  if (
    commit === undefined ||
    encodedBranch === undefined ||
    fingerprint === undefined ||
    transport === undefined
  ) {
    throw new Error('Selected Worker Version has an invalid release manifest.');
  }
  try {
    const branch = decodeURIComponent(encodedBranch);
    if (branch.length === 0 || tag.length === 0) throw new Error('empty manifest value');
    return {
      branch,
      commit,
      fingerprint,
      mailTransport: decodeTransportToken(transport),
    };
  } catch {
    throw new Error('Selected Worker Version has an invalid release manifest.');
  }
}

export function requiredSecretNamesForTransport(transport: string): readonly SecretVarName[] {
  switch (transport.trim().toLowerCase()) {
    case 'smtp':
      return ['BETTER_AUTH_SECRET', 'SMTP_USER', 'SMTP_PASSWORD'];
    case 'resend':
      return ['BETTER_AUTH_SECRET', 'RESEND_API_KEY'];
    case 'inmemory':
    case '':
      throw new Error('Selected Worker Version has an unsupported remote mail transport.');
    default:
      throw new Error('Selected Worker Version has an unsupported remote mail transport.');
  }
}
