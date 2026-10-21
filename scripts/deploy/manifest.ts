import { createHash } from 'node:crypto';
import type { NonSecretProfile, SecretVarName } from '../../src/config/index.js';

const MANIFEST_MESSAGE_PREFIX = 'user-service-manifest/v1';
const MANIFEST_TAG_PREFIX = 'user-service-manifest-v1';
const FINGERPRINT_PATTERN = '[0-9a-f]{64}';

export interface VersionManifest {
  readonly fingerprint: string;
  readonly mailTransport: string;
  readonly message: string;
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

export function buildVersionManifest(profile: NonSecretProfile): VersionManifest {
  const fingerprint = fingerprintForProfile(profile);
  const message = `${MANIFEST_MESSAGE_PREFIX} fingerprint=${fingerprint} transport=${transportToken(profile.AUTH_MAIL_TRANSPORT)}`;
  const tag = `${MANIFEST_TAG_PREFIX}-${fingerprint}`;
  return {
    fingerprint,
    mailTransport: profile.AUTH_MAIL_TRANSPORT.trim().toLowerCase(),
    message,
    tag,
  };
}

export function parseVersionManifest(
  annotations: Readonly<Record<string, unknown>>,
): Pick<VersionManifest, 'fingerprint' | 'mailTransport'> {
  const message = annotations['workers/message'];
  const tag = annotations['workers/tag'];
  if (typeof message !== 'string' || typeof tag !== 'string') {
    throw new Error('Selected Worker Version is missing the required release manifest.');
  }
  const messageMatch = new RegExp(
    `^${MANIFEST_MESSAGE_PREFIX.replace('/', '\\/')} fingerprint=(${FINGERPRINT_PATTERN}) transport=([^ ]+)(?: |$)`,
  ).exec(message);
  const fingerprint = messageMatch?.[1];
  const transport = messageMatch?.[2];
  if (
    fingerprint === undefined ||
    transport === undefined ||
    tag !== `${MANIFEST_TAG_PREFIX}-${fingerprint}`
  ) {
    throw new Error('Selected Worker Version has an invalid release manifest.');
  }
  try {
    return {
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
